import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { REGISTRATION_KEY } from '../../src/extension.mjs';
import { createFakePi } from './fake-pi.mjs';

export async function probeInterleavedAccounting({
  actions = ['branch', 'reload', 'cancel', 'native', 'return', 'replay'],
  kind = 'lane_capacity', modelCalled = false, withId = false, verify = false, followUps = true,
  cleanupReject = false, teardown, teardownReject = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-accounting-probe-'));
  const home = join(root, 'home'), cwd = join(root, 'work'), agentDir = join(home, '.omo/agent');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));
  const environment = { HOME: home, USERPROFILE: home, SENPI_CODING_AGENT_DIR: agentDir,
    OMO_CODING_AGENT_DIR: agentDir, OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
    OMO_ORACLE_ADVISOR: '1' };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const previousRegistration = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const tasks = new Map(), dispatches = new Map(), expected = new Map();
  const waits = [], replays = [], steps = [], captures = [], teardownResults = [];
  let selected = [], runtime, pending, before, original, delivered = false, first, output, rejectedCleanup = false;
  let snapshotListener, armedTeardown = false, injectedTeardown = false;
  const flag = typeof modelCalled === 'boolean' ? modelCalled : undefined;
  const paid = flag ?? (kind === 'quota' || kind === 'error' && withId);
  const fake = createFakePi({ cwd, executeTool: async (name, args) => {
    if (name === 'task_output') {
      if (args.task_id === 'owned-refusal' && verify) assert.equal(captures.length, 1,
        'native fact must be captured before any cleanup/status read');
      if (armedTeardown && teardown === 'cleanup' && teardownReject && !injectedTeardown) {
        injectedTeardown = true;
        throw Object.assign(new Error('shutdown status read rejected'), { code: 'lane_capacity', model_called: !flag });
      }
      if (cleanupReject && args.task_id === 'owned-refusal' && !rejectedCleanup) {
        rejectedCleanup = true;
        throw Object.assign(new Error('cleanup status read rejected'),
          flag === true ? { code: 'lane_capacity', model_called: false } : {});
      }
      return { result: { details: { snapshot: tasks.get(args.task_id) } }, isError: false };
    }
    if (name === 'task_cancel') {
      if (armedTeardown && teardown === 'retire' && teardownReject && !injectedTeardown) {
        injectedTeardown = true;
        throw Object.assign(new Error('owned retirement rejected'), { code: 'quota', model_called: !flag });
      }
      const task = tasks.get(args.task_id);
      task.residency_state = 'persisted_only';
      return { result: { details: { kind: 'released', task_id: args.task_id } }, isError: false };
    }
    if (name !== 'task') throw new Error(`Unexpected native call ${name}`);
    const id = args.description.split('#').at(-1);
    dispatches.set(id, (dispatches.get(id) ?? 0) + 1);
    if (id === 'refused') {
      entered.resolve();
      await release.promise;
      const details = { kind, ...(flag === undefined ? {} : { model_called: flag }),
        ...(withId ? { task_id: 'owned-refusal' } : {}) };
      if (withId || teardown) tasks.set('owned-refusal', {
        task_id: 'owned-refusal', status: 'completed',
        residency_state: teardown === 'retire' ? 'resident' : 'persisted_only',
      });
      if (teardown) snapshotListener?.({
        name: 'omo.task.updated', data: { parent_session_id: 'fake-session',
          tasks: [{ ...tasks.get('owned-refusal'), description: args.description, agent_type: 'oracle' }] },
      });
      return { result: { details }, isError: true };
    }
    const task = { task_id: `owned-${id}`, status: 'completed', residency_state: 'persisted_only',
      final_response: '{"verdict":"CONTINUE","reasons":[]}' };
    tasks.set(task.task_id, task);
    return { result: { details: task }, isError: false };
  } });
  fake.pi.events = { on(_channel, listener) {
    snapshotListener = listener;
    return () => {
      if (armedTeardown && teardown === 'dispose' && teardownReject && !injectedTeardown) {
        injectedTeardown = true;
        throw Object.assign(new Error('subscription disposal rejected'), { code: 'quota', model_called: !flag });
      }
      snapshotListener = undefined;
    };
  } };
  fake.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });
  const append = fake.pi.appendEntry;
  fake.pi.appendEntry = (type, data) => {
    append(type, data);
    selected.push(fake.entries.at(-1));
    if (data.type === 'consult_native_result' && data.request_id === 'refused') {
      captures.push(structuredClone(data.native_result));
      if (verify) assert.ok(Object.isFrozen(data.native_result));
    }
  };
  fake.ctx.sessionManager.getBranch = () => selected;
  const invoke = (id, kind = 'work') => fake.tools.get('oracle_consult').execute(id, {
    kind, question: 'Review the current change.',
  }, undefined, undefined, fake.ctx);
  const observe = promise => {
    const observed = promise.then(value => ({ resolved: true, value }), error => ({
      resolved: false, code: error.code, message: error.message,
    }));
    waits.push(observed);
    return observed;
  };
  function snapshot(step) {
    const state = runtime.ledger.state, record = runtime.ledger.request('refused');
    const used = [...expected.values()].filter(Boolean).length;
    const remaining = 4 - state.job.counters.consults;
    const canonicalUsed = Object.values(state.requests).filter(record => record.job_id === 'J1' && record.counted).length;
    steps.push({ step, remaining, used: state.job.counters.consults, expected_used: used, canonical_used: canonicalUsed,
      canonical_model_called: record?.model_called, status: record?.status,
      original_dispatches: dispatches.get('refused') ?? 0 });
    if (!verify) return;
    assert.ok(remaining >= 0 && remaining <= 4, `${step}: remaining out of range`);
    assert.equal(state.job.counters.consults, used, `${step}: reference charge mismatch`);
    assert.equal(canonicalUsed, used, `${step}: canonical charge mismatch`);
    assert.equal(remaining, 4 - canonicalUsed, `${step}: remaining differs from canonical set`);
    assert.equal(record.calls_remaining, remaining, `${step}: recorded remaining mismatch`);
    assert.deepEqual(state.job.consults.refused, record, `${step}: branch/canonical record divergence`);
    assert.ok([...dispatches.values()].every(count => count <= 1), `${step}: duplicate dispatch`);
    assert.equal(Object.keys(state.job.stops).length, 0);
    if (delivered) assert.equal(record.model_called, paid);
    if (captures.length) {
      assert.equal(captures.length, 1, `${step}: second native fact write`);
      assert.deepEqual(record.native_attempts['1'], captures[0], `${step}: native facts changed`);
      assert.ok(Object.isFrozen(record.native_attempts['1']));
      assert.equal(Object.hasOwn(record.native_attempts['1'], 'model_called'), flag !== undefined);
    }
  }
  try {
    runtime = extension(fake.pi);
    await fake.emit('session_start');
    await fake.command('oracle', 'on');
    before = structuredClone(selected);
    pending = invoke('refused');
    await entered.promise;
    original = structuredClone(selected);
    expected.set('refused', true);
    snapshot('native-admitted');
    for (const action of actions) {
      if (action === 'native') {
        armedTeardown = teardown === 'cleanup' || teardown === 'retire';
        release.resolve();
        first = await pending;
        armedTeardown = false;
        const settled = await Promise.all(waits);
        if (verify) assert.ok(settled.every(result => result.resolved),
          JSON.stringify({ actions, kind, modelCalled, withId, settled }));
        delivered = true;
        expected.set('refused', paid);
      } else if (action === 'branch' || action === 'return') {
        selected = structuredClone(action === 'branch' ? before : original);
        const actionResult = observe(fake.emit('session_tree'));
        if (delivered) await actionResult;
      } else if (action === 'reload') {
        const actionResult = observe(fake.emit('session_start'));
        if (delivered) await actionResult;
      } else if (action === 'cancel') {
        const actionResult = observe(fake.command('oracle', 'cancel'));
        if (delivered) await actionResult;
      } else if (action === 'replay') {
        const replay = invoke('refused');
        replays.push(replay);
        if (delivered) {
          const result = await replay;
          if (verify) {
            assert.equal(result.details.status, first.details.status);
            assert.equal(result.details.calls_remaining, 4 - Number(paid));
          }
        }
      } else if (action === 'teardown') {
        assert.ok(delivered);
        if (teardown !== 'dispose') {
          const outcomes = runtime.ledger.request('refused').lifecycle_results;
          const operation = teardown === 'cleanup' && teardownReject ? 'execute' : teardown;
          const status = teardownReject ? 'rejected' : 'fulfilled';
          assert.ok(outcomes.some(outcome => outcome.operation === operation && outcome.status === status));
          teardownResults.push({ operation: teardown, status });
          assert.equal(injectedTeardown, teardownReject);
          snapshot(action);
          continue;
        }
        armedTeardown = true;
        try {
          runtime.transport.dispose();
          teardownResults.push({ operation: teardown, status: 'fulfilled' });
        } catch (error) {
          teardownResults.push({ operation: teardown, status: 'rejected', code: error.code });
        } finally { armedTeardown = false; }
        if (verify) {
          assert.equal(injectedTeardown, teardownReject);
          assert.equal(teardownResults.at(-1).status, teardownReject ? 'rejected' : 'fulfilled');
        }
      } else throw new Error(`Unknown accounting action ${action}`);
      snapshot(action);
    }
    const replayResults = await Promise.all(replays);
    if (verify) for (const replay of replayResults) {
      assert.equal(replay.details.status, first.details.status);
      assert.equal(replay.details.calls_remaining, 4 - Number(paid));
    }
    const afterReturn = runtime.ledger.state;
    output = {
      actions, envelope: { kind, model_called: flag ?? 'absent', task_id_present: withId },
      expected_paid: paid, cleanup_rejected: rejectedCleanup, result: first.details, steps,
      native_captures: captures, teardown_results: teardownResults,
      local_after_return: afterReturn.job.consults.refused ?? null,
      canonical_after_return: runtime.ledger.request('refused'),
      counters_after_return: afterReturn.job.counters, followups: [], real_model_calls: 0,
    };
    if (followUps) for (const [id, kind] of [
      ['work-1', 'work'], ['work-2', 'work'], ['work-3', 'work'], ['completion', 'completion'],
    ]) {
      const usedWork = [...expected.entries()].filter(([id, charged]) => charged && id !== 'completion').length;
      const allowed = kind === 'completion' || usedWork < 3;
      expected.set(id, allowed);
      const result = await invoke(id, kind);
      if (verify) assert.equal(result.details.status, allowed ? 'answered' : 'cap_exhausted');
      output.followups.push(result.details);
      snapshot(id);
    }
    output.dispatches = Object.fromEntries(dispatches);
    output.final_counters = runtime.ledger.state.job.counters;
  } finally {
    release.resolve();
    if (pending) await Promise.allSettled([pending, ...waits, ...replays]);
    try { if (runtime) await fake.emit('session_shutdown'); }
    finally {
      if (previousRegistration === undefined) delete globalThis[REGISTRATION_KEY];
      else globalThis[REGISTRATION_KEY] = previousRegistration;
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      if (output) output.cleanup = { homes_removed: !existsSync(root), owned_processes: 0, pids_gone: true };
    }
  }
  return output;
}

export async function runAccountingInterleavings(onRow = () => {}) {
  const permutations = [
    ['branch', 'reload', 'cancel'], ['branch', 'cancel', 'reload'],
    ['reload', 'branch', 'cancel'], ['reload', 'cancel', 'branch'],
    ['cancel', 'branch', 'reload'], ['cancel', 'reload', 'branch'],
  ];
  const rows = [];
  for (const [name, followUps] of [['refund-overflow-repro', false], ['return-branch-repro', true]]) {
    const probe = await probeInterleavedAccounting({ verify: true, followUps });
    assert.equal(probe.result.calls_remaining, 4);
    assert.equal(probe.local_after_return.model_called, false);
    if (followUps) assert.deepEqual(probe.followups.map(result => result.status),
      ['answered', 'answered', 'answered', 'answered']);
    onRow(name, probe);
    rows.push({ name, status: probe.result.status, remaining: probe.result.calls_remaining,
      charged: false, steps: probe.steps.length, dispatches: probe.dispatches.refused, cleanup: probe.cleanup });
  }
  for (const kind of ['lane_capacity', 'quota', 'error']) for (const modelCalled of [true, false, 'absent']) {
    for (const withId of [true, false]) for (const order of permutations) {
      for (let nativeAt = 0; nativeAt <= order.length; nativeAt++) for (const returnBefore of [true, false]) {
        const actions = [...order.slice(0, nativeAt), 'replay',
          ...(returnBefore ? ['return'] : []), 'native',
          ...(returnBefore ? [] : ['return']), ...order.slice(nativeAt), 'reload', 'replay'];
        const probe = await probeInterleavedAccounting({
          actions, kind, modelCalled, withId, verify: true, followUps: false,
        });
        const name = `interleaved-${kind}-${modelCalled}-${withId}-${order.join('-')}-${nativeAt}-${returnBefore}`;
        onRow(name, probe);
        rows.push({ name, status: probe.result.status, remaining: probe.result.calls_remaining,
          charged: probe.expected_paid, steps: probe.steps.length,
          dispatches: probe.dispatches.refused, cleanup: probe.cleanup });
      }
    }
  }
  for (const kind of ['lane_capacity', 'quota', 'error']) for (const modelCalled of [true, false, 'absent']) {
    for (const withId of [true, false]) for (const teardown of ['cleanup', 'retire', 'dispose']) {
      for (const teardownReject of [false, true]) {
        const actions = ['cancel', 'native', 'teardown', 'reload', 'replay', 'branch', 'return', 'replay'];
        const probe = await probeInterleavedAccounting({
          actions, kind, modelCalled, withId, teardown, teardownReject, verify: true, followUps: true,
        });
        const name = `native-teardown-${kind}-${modelCalled}-${withId}-${teardown}-${teardownReject}`;
        onRow(name, probe);
        rows.push({ name, status: probe.result.status, remaining: probe.result.calls_remaining,
          charged: probe.expected_paid, steps: probe.steps.length, dispatches: probe.dispatches.refused,
          native_capture_count: probe.native_captures.length, teardown: probe.teardown_results, cleanup: probe.cleanup });
      }
    }
  }
  return rows;
}
