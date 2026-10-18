import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import policyProbe from '../qa/oracle-policy-extension.mjs';
import transportQA from '../qa/transport-extension.mjs';
import { REGISTRATION_KEY } from '../src/extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

const answer = '{"verdict":"CONTINUE","reasons":[]}';

// Installed runner.createContext() has no executeTool. createToolContext()
// adds a caller-bound executor; pi.executeTool returns a bare result and
// throws on a blocked preflight. Nested execution returns an outcome instead.
function hostFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-retirement-context-'));
  const priorRegistration = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  const variables = {
    HOME: directory, USERPROFILE: directory, OMO_PROFILE: '', OCX_PROFILE: '',
    OPENCODE_CONFIG_DIR: '', SENPI_CODING_AGENT_DIR: join(directory, 'agent'),
    OMO_CODING_AGENT_DIR: join(directory, 'agent'), OMO_ORACLE_ADVISOR: '1',
    ORACLE_QA_REAL_ORACLE: '0', ORACLE_QA_PROBE_LOG: join(directory, 'probe.jsonl'),
    ORACLE_QA_ATTEMPT_DIR: join(directory, 'attempt'), ORACLE_QA_GUARD_IPC: '',
    ORACLE_QA_WRITE_TARGET: join(directory, 'must-not-exist'),
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  mkdirSync(join(directory, '.omo'));
  mkdirSync(join(directory, 'agent'));
  writeFileSync(join(directory, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));
  t.after(async () => {
    try {
      // Disposal can append observed lifecycle records. Keep the fixture's
      // registration, environment and log directory alive until it settles.
      await globalThis[REGISTRATION_KEY]?.runtime?.transport.dispose();
    } finally {
      if (priorRegistration === undefined) delete globalThis[REGISTRATION_KEY];
      else globalThis[REGISTRATION_KEY] = priorRegistration;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const f = createFakePi({ cwd: directory });
  delete f.ctx.executeTool;
  f.commandCtx = {
    ...f.ctx,
    getSystemPromptOptions: () => ({}),
    waitForIdle: async () => {},
  };
  f.command = (name, args = '') => f.commands.get(name).handler(args, f.commandCtx);
  f.pi.events = new EventEmitter();
  f.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });
  f.rpc = new Map();
  f.observations = [];
  f.pi.rpc = {
    handle(name, handler) { f.rpc.set(name, handler); },
    emit(name, data) { f.observations.push({ name, ...data }); },
  };
  f.records = new Map();
  f.nativeCalls = [];
  f.blocked = [];
  f.blockedSignal = Promise.withResolvers();
  let sequence = 0;
  const nestedSequence = new Map();
  f.snapshot = task => f.pi.events.emit('senpi:extension-rpc-event', {
    name: 'omo.task.updated', data: { parent_session_id: 'fake-session', tasks: [structuredClone(task)] },
  });
  async function execute(name, args, options = {}, parentToolCallId) {
    const ordinal = (nestedSequence.get(parentToolCallId) ?? 0) + 1;
    nestedSequence.set(parentToolCallId, ordinal);
    const toolCallId = parentToolCallId ? `${parentToolCallId}/${ordinal}` : `codemode-${++sequence}`;
    const toolCall = { type: 'toolCall', id: toolCallId, name, arguments: args };
    const event = { toolName: name, toolCallId, input: args, ...(parentToolCallId ? { parentToolCallId } : {}) };
    await f.beforePreflight?.(event);
    for (const handler of f.handlers.get('tool_call') ?? []) {
      const blocked = await handler(event, f.ctx);
      if (!blocked?.block) continue;
      f.blocked.push({ ...event, ...blocked });
      f.blockedSignal.resolve({ ...event, ...blocked });
      const error = Object.assign(new Error(blocked.reason), { code: 'blocked' });
      if (!parentToolCallId) throw error;
      return { toolCall, isError: true, result: {
        content: [{ type: 'text', text: error.message }], details: { code: 'blocked' },
      } };
    }
    let result;
    const definition = f.tools.get(name);
    if (definition) {
      const context = Object.defineProperty({ ...f.ctx }, 'executeTool', {
        value: (nestedName, input, nestedOptions) => execute(nestedName, input, nestedOptions, toolCallId),
      });
      result = await definition.execute(toolCallId, args, options.signal, undefined, context);
    } else {
      f.nativeCalls.push(event);
      if (name === 'task') {
        const task = { task_id: `owned-${f.records.size + 1}`, status: 'completed',
          residency_state: 'resident', resident: true, description: args.description,
          agent_type: 'oracle', final_response: answer, run_epoch: 0 };
        f.records.set(task.task_id, task);
        f.snapshot(task);
        result = { content: [{ type: 'text', text: answer }], details: { ...task } };
      } else if (name === 'task_output') {
        result = { content: [], details: { kind: 'status', snapshot: structuredClone(f.records.get(args.task_id)) } };
      } else if (name === 'task_cancel') {
        const task = f.records.get(args.task_id);
        assert.ok(task, 'only an owned oracle may reach native cancellation');
        Object.assign(task, { residency_state: 'persisted_only', resident: false });
        f.snapshot(task);
        result = { content: [], details: { kind: 'released', task_id: args.task_id } };
      } else throw new Error(`Unexpected native tool ${name}`);
    }
    await f.emit('tool_result', { ...event, ...result, isError: result.isError === true });
    return parentToolCallId ? { toolCall, result, isError: result.isError === true } : result;
  }
  f.pi.executeTool = (name, args, options) => execute(name, args, options);
  f.call = f.pi.executeTool;
  return f;
}

async function retainedOracle(t) {
  const f = hostFixture(t);
  transportQA(f.pi);
  f.runtime = globalThis[REGISTRATION_KEY].runtime;
  await f.emit('session_start');
  await f.command('oracle', 'on');
  const spawned = await f.call('task', { subagent_type: 'oracle', description: 'owned lifecycle fixture' });
  f.id = spawned.details.task_id;
  f.runtime.ledger.append({ type: 'oracle_assigned', oracle_task_id: f.id, residency: 'resident' });
  return f;
}

test('policy retirement RPC uses the factory API, not session context execution', { timeout: 3000 }, async t => {
  const f = hostFixture(t);
  policyProbe(f.pi);
  await f.emit('session_start');
  assert.equal(f.ctx.executeTool, undefined);
  await f.call('probe_oracle', { action: 'surface' });
  assert.equal(f.observations.find(item => item.event === 'result').status, 'observed');
  const retired = await f.rpc.get('oracle.policy.retire')();
  assert.deepEqual(retired.retired.map(item => item.id), ['owned-1']);
  assert.equal(f.records.get('owned-1').residency_state, 'persisted_only');
  assert.equal(f.nativeCalls.filter(call => call.toolName === 'task_cancel').length, 1);
  assert.equal(existsSync(process.env.ORACLE_QA_WRITE_TARGET), false);
});

test('transport QA goes through oracle_consult and retires three owned residents', { timeout: 3000 }, async t => {
  const f = hostFixture(t);
  transportQA(f.pi);
  const runtime = globalThis[REGISTRATION_KEY].runtime;
  await f.emit('session_start');
  await f.command('oracle', 'on');
  for (let n = 0; n < 3; n++) {
    await Promise.race([
      f.call('qa_transport_run', { marker: `run-${n}`, mode: 'normal' }),
      f.blockedSignal.promise.then(event => assert.fail(`${event.toolName}: ${event.reason}`)),
    ]);
  }
  const results = f.observations.filter(item => item.event === 'consult_result');
  assert.deepEqual(results.map(item => item.status), ['answered', 'answered', 'answered']);
  assert.deepEqual(results.map(item => item.dossier_prior_ids),
    [[], [results[0].request_id], results.slice(0, 2).map(item => item.request_id)]);
  const cancels = f.nativeCalls.filter(call => call.toolName === 'task_cancel');
  assert.equal(cancels.length, 3);
  for (const call of cancels) {
    assert.ok(runtime.ledger.state.job.oracle_task_ids.includes(call.input.task_id));
    assert.equal(call.parentToolCallId, undefined, 'private factory controls are not queued behind the consult');
  }
  assert.equal(f.blocked.length, 0);
  assert.ok([...f.records.values()].every(task => !task.resident && task.residency_state === 'persisted_only'));
  assert.equal(runtime.ledger.state.job.counters.consults, 3);
  const dead = await f.rpc.get('oracle.transport.dead')();
  assert.equal(dead.oracle_task_id, results.at(-1).oracle_task_id);
  assert.equal(dead.result.confirmed, true);
  assert.equal(dead.result.task.resident, false);
  assert.equal(f.blocked.length, 0, 'dead-target fixture must use owned lifecycle authority');
  await f.command('oracle', 'end');
  assert.equal(runtime.ledger.state.job.retire_pending, false);
});

test('direct owned cancellation still shares all five STOP blocks with mutation guards', { timeout: 3000 }, async t => {
  const f = hostFixture(t);
  transportQA(f.pi);
  const runtime = globalThis[REGISTRATION_KEY].runtime;
  await f.emit('session_start');
  await f.command('oracle', 'on');
  runtime.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'owned-protected' });
  runtime.ledger.append({ type: 'stop_opened', stop_id: 'S1', reasons: [{ text: 'Hold this job.' }] });
  for (let n = 1; n <= 5; n++) {
    await assert.rejects(n % 2
      ? f.call('task_cancel', { task_id: 'owned-protected' })
      : f.call('edit', {}), { code: 'blocked' });
    assert.equal(f.blocked.at(-1).terminate, n === 5);
  }
  assert.equal(f.entries.filter(entry => entry.data.type === 'gate_blocked').length, 5);
  assert.equal(f.nativeCalls.length, 0);
  await assert.rejects(runtime.transport.retire(f.ctx, 'end', ['foreign']), /unowned oracle/);
  assert.equal(f.nativeCalls.length, 0);
});

for (const action of ['end', 'cancel']) for (const held of [false, true]) {
  test(`real command context ${action} releases a retained owned oracle while held=${held}`, { timeout: 3000 }, async t => {
    const f = await retainedOracle(t);
    assert.equal(f.commandCtx.executeTool, undefined);
    assert.equal(typeof f.commandCtx.waitForIdle, 'function');
    assert.equal(f.records.get(f.id).residency_state, 'resident');
    if (held) f.runtime.ledger.append({ type: 'stop_opened', stop_id: 'S1', reasons: [{ text: 'Hold.' }] });
    await assert.rejects(f.call('task_cancel', {
      task_id: f.id, reason: `oracle-advisor: ${action === 'end' ? 'job_end' : 'owner_cancel'}`,
    }), { code: 'blocked' });
    assert.equal(f.records.get(f.id).resident, true);
    const result = await f.command('oracle', action);
    assert.equal(result.status, action === 'end' ? 'closed' : 'no_consult_running');
    assert.equal(f.records.get(f.id).residency_state, 'persisted_only');
    assert.equal(f.records.get(f.id).resident, false);
    assert.equal(f.nativeCalls.filter(call => call.toolName === 'task_cancel').length, 1);
    assert.equal(f.runtime.ledger.state.job.retire_pending, false);
    if (held && action === 'cancel') assert.equal(f.runtime.ledger.state.job.gate_state, 'HELD');
  });
}

test('a pending owner release cannot authorize a concurrent model cancellation of the same oracle', { timeout: 3000 }, async t => {
  const f = await retainedOracle(t);
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let first = true;
  f.beforePreflight = async event => {
    if (event.toolName !== 'task_cancel' || !first) return;
    first = false;
    reached.resolve();
    await release.promise;
  };
  const ending = f.command('oracle', 'end');
  ending.catch(() => {});
  await reached.promise;
  try {
    await assert.rejects(f.call('task_cancel', {
      task_id: f.id, reason: 'oracle-advisor: job_end',
    }), { code: 'blocked' });
    assert.equal(f.records.get(f.id).resident, true);
  } finally { release.resolve(); }
  await ending;
  assert.equal(f.records.get(f.id).resident, false);
  assert.equal(f.nativeCalls.filter(call => call.toolName === 'task_cancel').length, 1);
});

test('a deferred call cannot retain a completed lifecycle release permit', { timeout: 3000 }, async t => {
  const f = await retainedOracle(t);
  const resume = Promise.withResolvers();
  let deferred;
  f.beforePreflight = event => {
    if (event.toolName !== 'task_cancel' || deferred) return;
    deferred = (async () => {
      await resume.promise;
      return f.call('task_cancel', { task_id: f.id, reason: 'oracle-advisor: owner_cancel' });
    })();
    deferred.catch(() => {});
  };
  await f.command('oracle', 'cancel');
  resume.resolve();
  await assert.rejects(deferred, { code: 'blocked' });
  assert.equal(f.nativeCalls.filter(call => call.toolName === 'task_cancel').length, 1);
});

for (const lifecycle of ['session_tree', 'session_shutdown']) {
  test(`${lifecycle} releases a held retained oracle from its base event context`, { timeout: 3000 }, async t => {
    const f = await retainedOracle(t);
    f.runtime.ledger.append({ type: 'stop_opened', stop_id: 'S1', reasons: [{ text: 'Hold.' }] });
    await f.emit(lifecycle);
    assert.equal(f.records.get(f.id).resident, false);
    assert.equal(f.nativeCalls.filter(call => call.toolName === 'task_cancel').length, 1);
  });
}
