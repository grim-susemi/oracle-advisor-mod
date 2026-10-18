import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTransport, TRANSPORT_DECISION } from '../src/transport.mjs';
import { createLedger } from '../src/ledger.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

const verdict = '{"verdict":"CONTINUE","reasons":[]}';
const outcome = (details, text = '', isError = false) => ({
  toolCall: {}, result: { details, content: [{ type: 'text', text }] }, isError,
});
function fixture(t, { live = false, execute, abortPropagates = true } = {}) {
  const events = new EventEmitter();
  const records = new Map();
  let number = 0;
  const f = createFakePi({ executeTool: async (name, args, options) => {
    if (execute) {
      const result = await execute(name, args, options, f);
      if (result !== undefined) return result;
    }
    if (name === 'task') {
      const task = { task_id: `t${++number}`, status: 'completed', residency_state: 'resident',
        final_response: verdict, notification: { run_epoch: 0 }, description: args.description };
      records.set(task.task_id, task);
      f.snapshot(task);
      return outcome({ ...task, run_epoch: 0 }, `${verdict}\n\n[task_id: ${task.task_id} - continue]`);
    }
    if (name === 'task_output') return outcome({ kind: 'status', snapshot: records.get(args.task_id) });
    if (name === 'task_cancel') {
      const task = records.get(args.task_id);
      if (!task) return outcome({ kind: 'not_found' });
      const kind = task.status === 'running' ? 'cancelled' : 'released';
      Object.assign(task, { status: kind === 'cancelled' ? 'cancelled' : task.status, residency_state: 'persisted_only' });
      f.snapshot(task);
      return outcome({ kind, task_id: task.task_id, status: task.status });
    }
    if (name === 'task_send') {
      const task = records.get(args.to);
      task.notification.run_epoch++;
      f.snapshot(task);
      return outcome({ kind: 'revived', task_id: args.to, run_epoch: task.notification.run_epoch });
    }
    throw new Error(`Unexpected ${name}`);
  } });
  f.pi.events = events;
  f.records = records;
  f.snapshot = task => events.emit('senpi:extension-rpc-event', {
    name: 'omo.task.updated', data: { parent_session_id: 'fake-session', tasks: [structuredClone(task)] },
  });
  f.ledger = createLedger(f.pi);
  f.ledger.append({ type: 'job_opened', job_id: 'J1' });
  f.transport = createTransport(f.pi, { ledger: f.ledger,
    decision: { ...TRANSPORT_DECISION, live_residency: live ? 'enabled' : 'disabled', abort_propagates: abortPropagates },
  });
  t.after(() => f.transport.dispose());
  f.run = (request_id = 'r1', extra = {}) => {
    f.ledger.append({ type: 'consult_admitted', request_id, kind: 'work' });
    return f.transport.consult({ ctx: f.ctx, request_id, prompt: `full dossier ${request_id}`, ...extra,
      beforeDispatch: () => f.ledger.append({ type: 'consult_dispatched', request_id }) });
  };
  return f;
}

test('measured decision is fresh-only even though snapshot awaiting exists', async t => {
  assert.equal(TRANSPORT_DECISION.live_residency, 'disabled');
  assert.equal(TRANSPORT_DECISION.await_mechanism, 'omo.task.updated');
  const f = fixture(t);
  for (let n = 1; n <= 3; n++) {
    const result = await f.run(`r${n}`);
    assert.equal(result.path, 'spawn');
    assert.equal(result.answer, verdict);
    assert.equal(result.status, 'answered');
    assert.equal(result.oracle_run_epoch, 0);
  }
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_send').length, 0);
  assert.deepEqual(f.ledger.state.job.oracle_task_ids, ['t1', 't2', 't3']);
  assert.ok([...f.records.values()].every(task => task.residency_state === 'persisted_only'));
});

test('future live mode revives the same id and subscribes before send', async t => {
  const f = fixture(t, { live: true });
  assert.equal((await f.run()).path, 'spawn');
  const result = await f.run('r2');
  assert.equal(result.path, 'revival');
  assert.equal(result.oracle_task_id, 't1');
  assert.equal(result.oracle_run_epoch, 1);
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 0);
});

for (const details of [{ kind: 'not_continuable' }, { kind: 'not_found' },
  { kind: 'error', error: { code: 'no_resident_session' } }]) {
  test(`revival refusal ${details.error?.code ?? details.kind} falls back exactly once even with isError false`, async t => {
    const f = fixture(t, { live: true, execute(name) {
      if (name === 'task_send') return outcome(details, 'no resident session');
    } });
    await f.run();
    const result = await f.run('r2');
    assert.equal(result.path, 'fresh_fallback');
    assert.equal(result.status, 'answered');
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 2);
    assert.equal(f.ledger.state.job.revival_failures.length, 1);
    assert.equal(f.records.get('t1').residency_state, 'persisted_only');
    const facts = f.ledger.request('r2').native_attempts;
    assert.equal(Object.keys(facts).length, 2);
    assert.equal(facts['1'].kind, details.kind);
    assert.equal(facts['2'].task_id, 't2');
    assert.ok(Object.values(facts).every(Object.isFrozen));
    assert.equal(f.ledger.request('r2').model_called, true);
    assert.equal(f.calls.sendMessage.filter(([message]) => message.details?.event === 'revival_failed').length, 1);
  });
}

for (const analysis of [
  'The read-only logs show no resident session; avoid reusing it.',
  'The change handles HTTP 429 quota responses correctly.',
  'Keep provider stream timeout handling unchanged.',
]) {
  test(`successful native advice is answered even when analysis says: ${analysis}`, async t => {
    const answer = `${analysis}\n${verdict}`;
    const f = fixture(t, { execute(name, args, _options, state) {
      if (name !== 'task') return;
      const task = { task_id: 'advice', status: 'completed', residency_state: 'resident',
        description: args.description, run_epoch: 0 };
      state.records.set(task.task_id, task);
      state.snapshot(task);
      return outcome({ ...task, run_in_background: false },
        `${answer}\n\n[task_id: advice - continue with task_send(to="advice", message="...")]`, false);
    } });
    const result = await f.run();
    assert.equal(result.status, 'answered');
    assert.equal(result.answer, answer);
    assert.equal(result.model_called, true);
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
    assert.equal(f.records.get('advice').residency_state, 'persisted_only');
  });
}

test('structured failure codes and statuses classify without error prose or isError', async t => {
  for (const [details, structuredContent, status] of [
    [{ error: { code: 'quota' } }, undefined, 'quota'],
    [{ status: 'timed_out' }, undefined, 'timed_out'],
    [{ kind: 'error' }, { error: { code: 429 } }, 'quota'],
    [{}, { status: 'timed_out' }, 'timed_out'],
  ]) {
    const f = fixture(t, { execute(name) {
      if (name !== 'task') return;
      const result = outcome(details, 'native refusal', false);
      result.result.structuredContent = structuredContent;
      return result;
    } });
    const result = await f.run();
    assert.equal(result.status, status);
    assert.equal(result.model_called, true);
    assert.equal(f.calls.executeTool.length, 1);
  }
});

test('lane capacity is unavailable without fallback or model charge', async t => {
  const f = fixture(t, { live: true, execute(name) {
    if (name === 'task_send') return outcome({ kind: 'lane_capacity' }, 'lane full', false);
  } });
  await f.run();
  const result = await f.run('r2');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.model_called, false);
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
});

test('a dead resident before revival falls back once; fresh-only never attempts revival', async t => {
  for (const live of [true, false]) {
    const f = fixture(t, { live });
    await f.run();
    Object.assign(f.records.get('t1'), { status: 'cancelled', residency_state: 'persisted_only', final_response: '' });
    f.snapshot(f.records.get('t1'));
    const result = await f.run('r2');
    assert.equal(result.path, live ? 'fresh_fallback' : 'spawn');
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_send').length, 0);
    assert.equal(f.ledger.state.job.revival_failures?.length ?? 0, live ? 1 : 0);
  }
});

test('promotion and arbitrarily long simulated thought remain event-driven with no deadline', { timeout: 2000 }, async t => {
  let clock = 0;
  const admitted = Promise.withResolvers();
  const f = fixture(t, { execute(name, args, _options, state) {
    if (name !== 'task') return;
    const task = { task_id: 'slow', status: 'running', residency_state: 'resident', description: args.description, run_epoch: 0 };
    state.records.set('slow', task);
    state.snapshot(task);
    admitted.resolve();
    return outcome({ task_id: 'slow', status: 'running', run_in_background: true });
  } });
  f.ctx.getPromptCacheSafeWaitSeconds = () => 1;
  f.transport.dispose();
  f.transport = createTransport(f.pi, { ledger: f.ledger, now: () => clock });
  const pending = f.run();
  await admitted.promise;
  clock = 365 * 86400000;
  assert.equal(f.transport.running.request_id, 'r1');
  const busy = await f.run('busy');
  assert.equal(busy.status, 'busy');
  Object.assign(f.records.get('slow'), { status: 'completed', final_response: verdict });
  f.snapshot(f.records.get('slow'));
  const result = await pending;
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, verdict);
  assert.equal(result.main_cache_wait_exceeded, true);
  assert.equal(result.engine_delivers_completion, true);
});

test('terminal without an answer never retries', async t => {
  const f = fixture(t, { execute(name, args, _options, state) {
    if (name !== 'task') return;
    const task = { task_id: 'dead', status: 'failed', residency_state: 'persisted_only', description: args.description };
    state.records.set('dead', task);
    state.snapshot(task);
    return outcome({ task_id: 'dead', status: 'failed' }, '');
  } });
  assert.equal((await f.run()).status, 'oracle_dead');
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
});

test('host timeout and quota remain non-verdict failures with no retry', async t => {
  for (const [kind, status] of [['timed_out', 'timed_out'], ['quota', 'quota']]) {
    const f = fixture(t, { execute(name) { if (name === 'task') return outcome({ kind }, 'provider failure', true); } });
    const result = await f.run();
    assert.equal(result.status, status);
    assert.equal(result.verdict, undefined);
    assert.equal(f.calls.executeTool.length, 1);
  }
});

test('coordination roster drop aborts the owned wait and never uses ask or notify', { timeout: 2000 }, async t => {
  const key = Symbol.for('omo.agent-coordination.api.v1');
  const previous = globalThis[key];
  let changed;
  const admitted = Promise.withResolvers();
  globalThis[key] = { version: 1, getClient: () => ({
    peers: () => [{ task_id: 'peer', status: 'running' }],
    onPeersChanged(fn) { changed = fn; return () => { changed = undefined; }; },
  }) };
  t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
  const f = fixture(t, { execute(name, args, options, state) {
    if (name !== 'task') return;
    const task = { task_id: 'peer', status: 'running', residency_state: 'resident', description: args.description };
    state.records.set('peer', task); state.snapshot(task); admitted.resolve();
    return new Promise(resolve => options.signal.addEventListener('abort', () => {
      task.status = 'cancelled'; task.residency_state = 'persisted_only'; state.snapshot(task);
      resolve(outcome({ task_id: 'peer', status: 'cancelled' }, '', true));
    }, { once: true }));
  } });
  const pending = f.run();
  await admitted.promise;
  changed([]);
  assert.equal((await pending).status, 'oracle_dead');
  assert.equal(changed, undefined);
});

for (const propagates of [true, false]) {
  test(`owner cancel aborts once and retires when abort_propagates=${propagates}`, { timeout: 2000 }, async t => {
    const admitted = Promise.withResolvers();
    let aborts = 0;
    const f = fixture(t, { abortPropagates: propagates, execute(name, args, options, state) {
      if (name !== 'task') return;
      const task = { task_id: 'held', status: 'running', residency_state: 'resident', description: args.description };
      state.records.set('held', task); state.snapshot(task); admitted.resolve();
      return new Promise(resolve => options.signal.addEventListener('abort', () => {
        aborts++;
        if (propagates) { task.status = 'cancelled'; task.residency_state = 'persisted_only'; state.snapshot(task); }
        resolve(outcome({ task_id: 'held', status: task.status }, '', true));
      }, { once: true }));
    } });
    const pending = f.run();
    await admitted.promise;
    await f.transport.cancel(f.ctx);
    assert.equal((await pending).status, 'cancelled');
    assert.equal(aborts, 1);
    assert.equal(f.records.get('held').residency_state, 'persisted_only');
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
  });
}

test('an already-aborted consult never dispatches a model call', async t => {
  const f = fixture(t);
  const result = await f.run('cancelled-before-dispatch', { signal: AbortSignal.abort() });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.model_called, false);
  assert.equal(f.calls.executeTool.length, 0);
  assert.equal(f.transport.running, null);
});

test('cancel during the pre-dispatch status read prevents revival and fallback', { timeout: 2000 }, async t => {
  const inspecting = Promise.withResolvers();
  const inspected = Promise.withResolvers();
  let hold = false;
  const f = fixture(t, { live: true, async execute(name, args, _options, state) {
    if (name !== 'task_output' || !hold) return;
    inspecting.resolve();
    await inspected.promise;
    return outcome({ kind: 'status', snapshot: state.records.get(args.task_id) });
  } });
  await f.run();
  hold = true;
  const pending = f.run('cancel-before-revival');
  await inspecting.promise;
  const cancelled = f.transport.cancel();
  inspected.resolve();
  assert.equal((await pending).status, 'cancelled');
  await cancelled;
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_send').length, 0);
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
});

for (const action of ['cancel', 'esc', 'shutdown']) {
  test(`${action} after promotion retires the owned child without waiting for its answer`, { timeout: 2000 }, async t => {
    const promoted = Promise.withResolvers();
    const outer = new AbortController();
    let aborts = 0;
    const f = fixture(t, { execute(name, args, options, state) {
      if (name === 'task_output') promoted.resolve();
      if (name !== 'task') return;
      const task = { task_id: 'promoted', status: 'running', residency_state: 'resident',
        description: args.description, run_epoch: 0 };
      state.records.set(task.task_id, task);
      // The native foreground call has returned; abort no longer reaches the
      // resident child. Its only terminal transition is the owned task_cancel.
      options.signal.addEventListener('abort', () => { aborts++; }, { once: true });
      return outcome({ task_id: task.task_id, status: 'running', run_in_background: true });
    } });
    const pending = f.run(action, { signal: outer.signal });
    await promoted.promise;
    let stopping;
    if (action === 'esc') outer.abort();
    else stopping = action === 'shutdown' ? f.transport.shutdown(f.ctx) : f.transport.cancel();
    const result = await pending;
    await stopping;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.model_called, true);
    assert.equal(aborts, 1);
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
    assert.equal(f.records.get('promoted').status, 'cancelled');
    assert.equal(f.records.get('promoted').residency_state, 'persisted_only');
    assert.equal(f.transport.running, null);
    assert.ok(f.calls.appendEntry.some(([, entry]) => entry.type === 'oracle_retired' && entry.confirmed));
  });
}

test('branch switch retires old ids and next consult spawns with the new dossier', async t => {
  const f = fixture(t, { live: true });
  await f.run();
  await f.transport.branchSwitch(f.ctx, f.ledger.state.job);
  const result = await f.run('branch');
  assert.equal(result.path, 'spawn');
  assert.equal(f.records.get('t1').residency_state, 'persisted_only');
  assert.equal(f.calls.executeTool.findLast(([name]) => name === 'task')[1].prompt, 'full dossier branch');
});

test('reload marks interrupted, retires the old child, and never replays it', async t => {
  const f = fixture(t);
  const task = { task_id: 'reload', status: 'running', residency_state: 'resident' };
  f.records.set('reload', task);
  f.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'reload' });
  f.ledger.append({ type: 'consult_reserved', request_id: 'old', kind: 'work' });
  f.ledger.append({ type: 'consult_started', request_id: 'old' });
  f.ledger.rebuild(f.entries);
  await f.transport.restore(f.ctx);
  assert.equal(f.ledger.state.job.consults.old.status, 'interrupted');
  assert.equal(f.records.get('reload').residency_state, 'persisted_only');
  assert.equal(f.calls.executeTool.some(([name]) => name === 'task'), false);
});

test('retirement handles running, completed resident, and already gone; refuses unowned ids', async t => {
  const f = fixture(t);
  for (const [id, status, residency_state] of [
    ['running', 'running', 'resident'], ['complete', 'completed', 'resident'], ['gone', 'completed', 'persisted_only'],
  ]) {
    f.records.set(id, { task_id: id, status, residency_state });
    f.ledger.append({ type: 'oracle_assigned', oracle_task_id: id });
  }
  const retired = await f.transport.retire(f.ctx, 'end');
  assert.equal(retired.length, 3);
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 2);
  await assert.rejects(f.transport.retire(f.ctx, 'end', ['foreign']), /unowned/);
  assert.ok([...f.records.values()].every(task => task.residency_state === 'persisted_only'));
});

test('stuck revival answer is returned once and retired; next consult spawns', async t => {
  const f = fixture(t, { live: true, execute(name, args, _options, state) {
    if (name !== 'task_send') return;
    const task = state.records.get(args.to);
    Object.assign(task, { status: 'running', final_response: verdict, run_epoch: 1, notification: { run_epoch: 1 } });
    state.snapshot(task);
    return outcome({ kind: 'revived', task_id: args.to, run_epoch: 1 });
  } });
  await f.run();
  const second = await f.run('r2');
  assert.equal(second.answer, verdict);
  assert.equal(second.status, 'answered');
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task').length, 1);
  assert.equal(f.calls.appendEntry.filter(([, entry]) => entry.type === 'stuck_record_retired').length, 1);
  assert.equal((await f.run('r3')).path, 'spawn');
});

test('propagated abort retirement awaits the deferred disposed snapshot without polling', { timeout: 2000 }, async t => {
  const cancellation = Promise.withResolvers();
  const f = fixture(t, { execute(name) {
    if (name === 'task_cancel') {
      cancellation.resolve();
      return outcome({ kind: 'noop', task_id: 'deferred', status: 'cancelled' });
    }
  } });
  f.records.set('deferred', { task_id: 'deferred', status: 'cancelled', residency_state: 'resident' });
  f.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'deferred' });
  const pending = f.transport.retire(f.ctx, 'cancelled');
  await cancellation.promise;
  Object.assign(f.records.get('deferred'), { residency_state: 'disposed' });
  f.snapshot(f.records.get('deferred'));
  const [result] = await pending;
  assert.equal(result.confirmed, true);
  assert.equal(result.task.residency_state, 'disposed');
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
});

test('owner cancellation retires the child before signalling the native foreground wait', { timeout: 2000 }, async t => {
  const admitted = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const f = fixture(t, { execute(name, args, options, state) {
    if (name !== 'task') return;
    const task = { task_id: 'late-abort', status: 'running', residency_state: 'resident', description: args.description };
    state.records.set(task.task_id, task); state.snapshot(task); admitted.resolve();
    return new Promise(resolve => options.signal.addEventListener('abort', () => {
      assert.equal(task.residency_state, 'persisted_only');
      aborted.resolve();
      resolve(outcome({ task_id: task.task_id }, 'Tool execution aborted', true));
    }, { once: true }));
  } });
  const pending = f.run();
  await admitted.promise;
  const cancelled = f.transport.cancel();
  await aborted.promise;
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
  assert.equal((await pending).status, 'cancelled');
  await cancelled;
});

test('a stale previous run response cannot satisfy the new revival epoch', { timeout: 2000 }, async t => {
  const sent = Promise.withResolvers();
  const f = fixture(t, { live: true, execute(name, args, _options, state) {
    if (name !== 'task_send') return;
    state.snapshot(state.records.get(args.to));
    sent.resolve();
    return outcome({ kind: 'revived', task_id: args.to, run_epoch: 1 });
  } });
  await f.run();
  const pending = f.run('r2');
  await sent.promise;
  assert.equal(f.transport.running.request_id, 'r2');
  Object.assign(f.records.get('t1'), { run_epoch: 1, notification: { run_epoch: 1 }, final_response: 'new epoch answer' });
  f.snapshot(f.records.get('t1'));
  assert.equal((await pending).answer, 'new epoch answer');
});

test('Esc cleanup uses unaborted factory controls for a nested consult', { timeout: 2000 }, async t => {
  const outer = new AbortController();
  const admitted = Promise.withResolvers();
  const f = fixture(t, { execute(name, args, options, state) {
    if (name !== 'task') {
      // ExtensionToolContext.executeTool uses options.signal ?? callerSignal.
      if ((options.signal ?? outer.signal).aborted) return outcome({}, 'Tool execution aborted', true);
      return;
    }
    const task = { task_id: 'esc', status: 'running', residency_state: 'resident', description: args.description };
    state.records.set(task.task_id, task); state.snapshot(task); admitted.resolve();
    return new Promise(resolve => options.signal.addEventListener('abort', () => {
      task.status = 'cancelled'; state.snapshot(task);
      resolve(outcome({ task_id: task.task_id }, 'Tool execution aborted', true));
    }, { once: true }));
  } });
  const pending = f.run('esc', { signal: outer.signal });
  await admitted.promise;
  outer.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(f.records.get('esc').residency_state, 'persisted_only');
  assert.ok(f.calls.executeTool.filter(([name]) => name !== 'task').every(([, , options]) => !options.signal.aborted));
});

for (const called of [true, false, undefined]) {
  test(`Escape explicitly cancels a running oracle before aborting its native foreground wait; model_called=${called}`, { timeout: 2000 }, async t => {
    const admitted = Promise.withResolvers();
    const cancellation = Promise.withResolvers();
    const outer = new AbortController();
    const nativeDetails = { task_id: 'native-escape', status: 'cancelled',
      model: 'native-oracle', run_stats: { output_tokens: 7 },
      ...(called === undefined ? {} : { model_called: called }) };
    let finish;
    let nativeSignal;
    const captured = [];
    const f = fixture(t, { execute(name, args, options, state) {
      if (name === 'task') {
        nativeSignal = options.signal;
        const task = { task_id: 'native-escape', status: 'running', residency_state: 'resident',
          description: args.description };
        state.records.set(task.task_id, task);
        state.snapshot(task);
        admitted.resolve();
        return new Promise(resolve => {
          finish = resolve;
          nativeSignal.addEventListener('abort', () => {
            // Native terminal parking refuses a cancelled resident.
            if (task.residency_state === 'resident') {
              task.status = 'cancelled';
              state.snapshot(task);
            }
            resolve(outcome(nativeDetails, '', true));
          }, { once: true });
        });
      }
      if (name !== 'task_cancel') return;
      const task = state.records.get(args.task_id);
      if (task.status === 'cancelled') {
        cancellation.resolve({ kind: 'noop' });
        return outcome({ kind: 'noop', task_id: task.task_id, status: 'cancelled' });
      }
      assert.equal(nativeSignal.aborted, false);
      Object.assign(task, { status: 'cancelled', residency_state: 'disposed' });
      state.snapshot(task);
      finish(outcome(nativeDetails, '', true));
      cancellation.resolve({ kind: 'cancelled' });
      return outcome({ kind: 'cancelled', task_id: task.task_id, model_called: called !== true,
        model: 'cleanup-only', run_stats: { output_tokens: 999 } });
    } });
    f.ledger.subscribe(event => {
      if (event.type === 'consult_native_result') captured.push(structuredClone(event.native_result));
    });
    // Factory controls must remain callable while the nested foreground waits.
    const nested = f.ctx.executeTool;
    f.ctx.executeTool = (name, args, options) => {
      if (name !== 'task' && nativeSignal && !nativeSignal.aborted) {
        throw new Error('Control call queued behind its native foreground wait');
      }
      return nested(name, args, options);
    };
    const id = 'escape-before-native-abort';
    const pending = f.run(id, { signal: outer.signal });
    await admitted.promise;
    outer.abort();
    assert.equal((await cancellation.promise).kind, 'cancelled');
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(f.ledger.request(id).calls_remaining, 3);
    f.ledger.append({ type: 'consult_finished', request_id: id, status: result.status });
    assert.equal(f.records.get('native-escape').residency_state, 'disposed');
    assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
    assert.deepEqual(captured, [{ ...nativeDetails, isError: true }]);
    const facts = f.ledger.request(id).native_attempts;
    assert.deepEqual(facts, { 1: captured[0] });
    assert.ok(Object.isFrozen(facts['1']) && Object.isFrozen(facts['1'].run_stats));
    assert.equal(Object.hasOwn(facts['1'], 'model_called'), called !== undefined);
    assert.equal(result.model_called, called ?? true);
    assert.equal(f.ledger.request(id).calls_remaining, called === false ? 4 : 3);
    assert.ok(f.ledger.request(id).lifecycle_results.some(item => item.operation === 'retire' && item.status === 'fulfilled'));
    assert.ok(f.ledger.request(id).lifecycle_results.every(item =>
      Object.keys(item).every(key => ['operation', 'status', 'code'].includes(key))));
    f.transport.dispose();
    f.ledger.rebuild(f.entries);
    assert.deepEqual(f.ledger.request(id).native_attempts, facts);
    assert.equal(f.ledger.request(id).model_called, called ?? true);
    assert.equal(f.ledger.request(id).calls_remaining, called === false ? 4 : 3);
    assert.equal(captured.length, 1);
  });
}

test('Escape before native admission waits for the owned id and then retires it', { timeout: 2000 }, async t => {
  const admitting = Promise.withResolvers();
  const admitted = Promise.withResolvers();
  const outer = new AbortController();
  let nativeSignal;
  const f = fixture(t, { async execute(name, args, options, state) {
    if (name !== 'task') return;
    nativeSignal = options.signal;
    admitting.resolve();
    await admitted.promise;
    const task = { task_id: 'late-id', status: 'running', residency_state: 'resident', description: args.description };
    state.records.set(task.task_id, task);
    state.snapshot(task);
    return outcome({ task_id: task.task_id, status: 'running', run_in_background: true });
  } });
  const pending = f.run('escape-before-admission', { signal: outer.signal });
  await admitting.promise;
  outer.abort();
  try { assert.equal(nativeSignal.aborted, false); }
  finally { admitted.resolve(); }
  assert.equal((await pending).status, 'cancelled');
  assert.equal(f.records.get('late-id').residency_state, 'persisted_only');
  assert.equal(f.calls.executeTool.filter(([name]) => name === 'task_cancel').length, 1);
});
