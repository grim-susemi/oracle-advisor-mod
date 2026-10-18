import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeScenario } from '../qa/scenario-observer.mjs';
import { createLedger } from '../src/ledger.mjs';
import { createTransport } from '../src/transport.mjs';
import { registerStopGate } from '../src/stop-gate.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

function fixture(t, { trusted = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qa-retirement-provenance-'));
  const previous = process.env.SENPI_CODING_AGENT_DIR;
  process.env.SENPI_CODING_AGENT_DIR = directory;
  const f = createFakePi({ cwd: directory });
  f.evidence = [];
  f.nativeCalls = [];
  f.records = new Map();
  f.pi.events = new EventEmitter();
  let runtime;
  const observed = observeScenario(f.pi, (event, data) => f.evidence.push({ event, ...data }),
    trusted ? { getRuntime: () => runtime } : undefined);
  const ledger = createLedger(observed);
  runtime = {
    ledger, getSessionStatus: () => 'lead',
    registerTool: definition => observed.registerTool(definition),
  };
  runtime.transport = createTransport(observed, { ledger, getSessionStatus: runtime.getSessionStatus });
  registerStopGate(observed, runtime);
  f.runtime = runtime;
  t.after(() => {
    runtime.transport.dispose();
    if (previous === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
    else process.env.SENPI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  f.snapshot = task => f.pi.events.emit('senpi:extension-rpc-event', {
    name: 'omo.task.updated', data: { parent_session_id: 'fake-session', tasks: [structuredClone(task)] },
  });
  f.call = async (toolName, input, _options, callId) => {
    const event = { toolName, input, toolCallId: callId ?? `codemode-${++sequence}` };
    await f.beforePreflight?.(event);
    for (const handler of f.handlers.get('tool_call') ?? []) {
      const result = await handler(event, f.ctx);
      if (result?.block) throw Object.assign(new Error(result.reason), { code: 'blocked' });
    }
    f.nativeCalls.push(event);
    let result;
    if (toolName === 'task') {
      const task = { task_id: 'owned-1', status: 'completed', residency_state: 'resident',
        resident: true, agent_type: 'oracle', description: input.description,
        final_response: '{"verdict":"CONTINUE","reasons":[]}', run_epoch: 0 };
      f.records.set(task.task_id, task);
      f.snapshot(task);
      result = { content: [], details: { ...task } };
    } else if (toolName === 'task_output') {
      result = { content: [], details: { snapshot: structuredClone(f.records.get(input.task_id)) } };
    } else if (toolName === 'task_cancel') {
      await f.beforeCancelResult?.(event);
      const task = f.records.get(input.task_id);
      Object.assign(task, { resident: false, residency_state: 'persisted_only' });
      f.snapshot(task);
      result = { content: [], details: { kind: 'released', task_id: input.task_id } };
    } else throw new Error(`Unexpected native tool: ${toolName}`);
    await f.emit('tool_result', { ...event, ...result, isError: false });
    return result;
  };
  f.pi.executeTool = (...args) => f.call(...args);
  delete f.ctx.executeTool;
  ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 7 });
  ledger.append({ type: 'consult_admitted', request_id: 'request-1',
    job_id: 'J1', job_epoch: 7, kind: 'work' });
  observed.registerTool({ name: 'qa_consult', execute: () =>
    runtime.transport.consult({ ctx: f.ctx, request_id: 'request-1', prompt: 'Review.' }) });
  observed.registerTool({ name: 'qa_retire', execute: (_id, args) =>
    runtime.transport.retire(f.ctx, args.reason, args.ids) });
  f.consult = () => f.tools.get('qa_consult').execute('request-1', {}, undefined, undefined, f.ctx);
  f.retire = (reason, ids) => f.tools.get('qa_retire').execute('retire-operation', { reason, ids },
    undefined, undefined, f.ctx);
  f.hold = () => ledger.append({ type: 'stop_opened', stop_id: 'S1', reasons: [{ text: 'Hold.' }] });
  f.markers = () => f.evidence.filter(item => item.kind === 'retirement_authority');
  f.retain = () => {
    Object.assign(f.records.get('owned-1'), { resident: true, residency_state: 'resident' });
    f.snapshot(f.records.get('owned-1'));
  };
  return f;
}

test('real private answered retirement emits exact request provenance before guarded execution',
  { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.beforePreflight = event => {
      if (event.toolName === 'task_cancel') f.hold();
    };
    assert.equal((await f.consult()).status, 'answered');
    const cancel = f.nativeCalls.find(event => event.toolName === 'task_cancel');
    assert.equal(f.markers().length, 1);
    const [marker] = f.markers();
    assert.equal(marker.call_id, cancel.toolCallId);
    assert.equal(marker.task_id, 'owned-1');
    assert.equal(marker.request_id, 'request-1');
    assert.equal(marker.job_id, 'J1');
    assert.equal(marker.job_epoch, 7);
    assert.equal(marker.source, 'runtime.transport.isRetirementCall');
    assert.ok(marker.operation_id && marker.scope_id);
    const snapshot = f.evidence.find(item => item.kind === 'retirement_snapshot');
    const retired = f.evidence.find(item => item.retirement && item.record.type === 'oracle_retired');
    const settled = f.evidence.find(item => item.retirement && item.record.type === 'consult_lifecycle_result');
    for (const proof of [snapshot, retired.retirement, settled.retirement]) {
      assert.equal(proof.operation_id, marker.operation_id);
      assert.equal(proof.scope_id, marker.scope_id);
      assert.equal(proof.call_id, cancel.toolCallId);
    }
    assert.equal(retired.retirement.snapshot_event_id, snapshot.evidence_id);
    assert.equal(settled.retirement.retired_event_id, retired.evidence_id);
    const attemptIndex = f.evidence.findIndex(item => item.kind === 'attempt' && item.call_id === cancel.toolCallId);
    const markerIndex = f.evidence.findIndex(item => item.kind === 'retirement_authority');
    const executedIndex = f.evidence.findIndex(item => item.kind === 'executed' && item.call_id === cancel.toolCallId);
    assert.ok(attemptIndex < markerIndex && markerIndex < executedIndex);
    assert.equal(f.runtime.ledger.state.job.gate_state, 'HELD');
    assert.ok(f.evidence.some(item => item.kind === 'ledger' &&
      item.record.type === 'oracle_retired' && item.record.confirmed === true));
    assert.ok(f.runtime.ledger.request('request-1').lifecycle_results.some(result =>
      result.operation === 'retire' && result.status === 'fulfilled'));
  });

test('forged reason and factory prefix remain recorded attempts without private provenance',
  { timeout: 3000 }, async t => {
    const f = fixture(t);
    await f.consult();
    f.evidence.length = 0;
    f.retain();
    f.hold();
    await assert.rejects(f.call('task_cancel', {
      task_id: 'owned-1', reason: 'oracle-advisor: answered',
    }, {}, 'codemode-forged'), { code: 'blocked' });
    assert.deepEqual(f.markers(), []);
    assert.ok(f.evidence.some(item => item.kind === 'attempt' && item.call_id === 'codemode-forged'));
    assert.ok(!f.evidence.some(item => item.kind === 'executed' && item.call_id === 'codemode-forged'));
  });

test('concurrent model cancellation cannot borrow a live private release scope',
  { timeout: 3000 }, async t => {
    const f = fixture(t);
    await f.consult();
    f.evidence.length = 0;
    f.retain();
    f.hold();
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.beforeCancelResult = async () => { reached.resolve(); await release.promise; };
    const retiring = f.retire('answered', ['owned-1']);
    retiring.catch(() => {});
    await reached.promise;
    const [marker] = f.markers();
    try {
      await assert.rejects(f.call('task_cancel', {
        task_id: 'owned-1', reason: 'oracle-advisor: answered',
      }, {}, 'codemode-concurrent'), { code: 'blocked' });
      assert.equal(f.records.get('owned-1').resident, true);
      assert.ok(marker);
      assert.deepEqual(f.markers(), [marker]);
    } finally { release.resolve(); }
    await retiring;
    assert.ok(!f.evidence.some(item => item.kind === 'executed' && item.call_id === 'codemode-concurrent'));
  });

test('a deferred descendant and an exact old call id cannot reuse expired private scope',
  { timeout: 3000 }, async t => {
    const f = fixture(t);
    await f.consult();
    f.evidence.length = 0;
    f.retain();
    f.hold();
    const resume = Promise.withResolvers();
    let deferred;
    f.beforePreflight = event => {
      if (event.toolName !== 'task_cancel' || deferred) return;
      deferred = resume.promise.then(() => f.call('task_cancel', {
        task_id: 'owned-1', reason: 'oracle-advisor: answered',
      }, {}, event.toolCallId));
      deferred.catch(() => {});
    };
    await f.retire('answered', ['owned-1']);
    assert.equal(f.markers().length, 1);
    resume.resolve();
    await assert.rejects(deferred, { code: 'blocked' });
    assert.equal(f.markers().length, 1);
    assert.equal(f.evidence.filter(item => item.kind === 'executed' && item.name === 'task_cancel').length, 1);
  });

for (const ownership of ['missing', 'ambiguous']) {
  test(`private authority with ${ownership} raw native ownership emits no marker`,
    { timeout: 3000 }, async t => {
      const f = fixture(t);
      if (ownership === 'missing') {
        f.runtime.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'owned-1' });
        f.records.set('owned-1', { task_id: 'owned-1', status: 'completed',
          resident: true, residency_state: 'resident' });
      } else {
        await f.consult();
        f.evidence.length = 0;
        f.retain();
        f.runtime.ledger.append({ type: 'consult_admitted', request_id: 'request-2',
          job_id: 'J1', job_epoch: 7, kind: 'work' });
        f.runtime.ledger.captureNativeResult('request-2', '1', { details: { task_id: 'owned-1' } });
      }
      f.hold();
      await f.retire('answered', ['owned-1']);
      assert.equal(f.nativeCalls.at(-2).toolName, 'task_cancel');
      assert.deepEqual(f.markers(), []);
    });
}

test('the optional runtime getter preserves observation without manufacturing provenance',
  { timeout: 3000 }, async t => {
    const f = fixture(t, { trusted: false });
    assert.equal((await f.consult()).status, 'answered');
    assert.deepEqual(f.markers(), []);
    assert.ok(f.evidence.some(item => item.kind === 'attempt' && item.name === 'task_cancel'));
    assert.ok(f.evidence.some(item => item.kind === 'executed' && item.name === 'task_cancel'));
  });
