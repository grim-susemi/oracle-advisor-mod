import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, initialState, reduceEntry, replayLedger, consultUsage } from '../src/ledger.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

const entry = data => ({ type: 'custom', customType: 'oracle-advisor', data });
const opened = { type: 'job_opened', job_id: 'J1', job_epoch: 1 };

test('native facts are frozen, write-once and isolated from lifecycle metadata', () => {
  const fake = createFakePi();
  const ledger = createLedger(fake.pi);
  ledger.append(opened);
  assert.throws(() => ledger.captureNativeResult('missing', '1', {}), /native_fact_without_admission/);
  ledger.append({ type: 'consult_admitted', request_id: 'r1', kind: 'work' });
  const native = { model_called: true, task_id: 'paid', run_stats: { input_tokens: 13 }, kind: 'quota' };
  ledger.captureNativeResult('r1', '1', native);
  native.model_called = false;
  native.run_stats.input_tokens = 0;
  const captured = ledger.request('r1').native_attempts['1'];
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.run_stats));
  assert.throws(() => { captured.model_called = false; }, TypeError);
  assert.throws(() => ledger.captureNativeResult('r1', '1', { model_called: false }), /native_fact_already_captured/);
  ledger.append({ type: 'consult_finished', request_id: 'r1', status: 'cancelled',
    model_called: false, oracle_task_id: 'cleanup-task',
    input_tokens: 0, usage_status: 'unknown', model: 'cleanup-model',
    native_attempts: { 1: { model_called: false } } });
  assert.deepEqual(ledger.request('r1').native_attempts['1'],
    { model_called: true, task_id: 'paid', run_stats: { input_tokens: 13 }, kind: 'quota' });
  assert.equal(ledger.request('r1').model_called, true);
  assert.equal(ledger.request('r1').oracle_task_id, 'paid');
  assert.equal(ledger.request('r1').input_tokens, 13);
  assert.equal(ledger.request('r1').usage_status, 'actual');
  assert.equal(ledger.request('r1').model, null);
  ledger.rebuild(fake.entries);
  assert.deepEqual(ledger.request('r1').native_attempts['1'], captured);
  assert.equal(ledger.request('r1').model_called, true);
});

test('absent native model_called stays absent through finish, release and rebuild', () => {
  const fake = createFakePi();
  const ledger = createLedger(fake.pi);
  ledger.append(opened);
  ledger.append({ type: 'consult_admitted', request_id: 'r1', kind: 'work' });
  ledger.captureNativeResult('r1', '1', { kind: 'lane_capacity', task_id: 'refused' });
  ledger.append({ type: 'consult_released', request_id: 'r1', status: 'unavailable', model_called: true });
  ledger.rebuild(fake.entries);
  assert.equal(Object.hasOwn(ledger.request('r1').native_attempts['1'], 'model_called'), false);
  assert.equal(ledger.request('r1').model_called, false);
  assert.equal(ledger.state.job.counters.consults, 0);
});

test('slot usage is derived only from canonical native facts and pending reservations', () => {
  const requests = {
    paid: { job_id: 'J1', slot: 'work', status: 'cancelled',
      native_result: { model_called: true }, counted: false, calls_remaining: 999 },
    refused: { job_id: 'J1', slot: 'work', status: 'interrupted',
      native_result: { model_called: false }, counted: true, calls_remaining: -1 },
    pending: { job_id: 'J1', slot: 'completion', status: 'admitted' },
    other: { job_id: 'J9', slot: 'work', status: 'answered', native_result: { model_called: true } },
  };
  assert.deepEqual(consultUsage(requests, 'J1'), { consults: 2, work: 1, completion: 1, calls_remaining: 2 });
  assert.deepEqual(consultUsage(requests, 'J9'), { consults: 1, work: 1, completion: 0, calls_remaining: 3 });
  assert.equal(requests.paid.calls_remaining, 999);
  assert.equal(requests.refused.counted, true);
});

test('reducer is pure and replay preserves every durable job field', () => {
  const events = [
    opened,
    { type: 'oracle_assigned', oracle_task_id: 'owned-1', residency: 'resident' },
    { type: 'consult_reserved', request_id: 'r1', kind: 'work' },
    { type: 'consult_started', request_id: 'r1', started_at: '2026-10-17T00:00:00Z' },
    { type: 'consult_finished', request_id: 'r1', status: 'answered', input_tokens: 10 },
    { type: 'verdict_recorded', request_id: 'r1', verdict: 'STOP', reasons: [{ text: 'Wrong scope' }] },
    { type: 'stop_opened', stop_id: 's1', request_id: 'r1', reasons: [{ text: 'Wrong scope' }] },
    { type: 'seed_bound', seed: { hash: 'hash1', source: 'main_supplied', goal: 'Goal', criteria: [{ id: 'AC1', text: 'Pass' }] } },
    { type: 'nudge_recorded', kind: 'failure', episode_id: 'e1' },
    { type: 'progress_recorded', revision: 4 },
    { type: 'stop_override', stop_id: 's1', reason: 'Owner accepts this scoped exception.', actor: 'owner' },
    { type: 'job_paused' },
  ];
  const before = structuredClone(events);
  const state = events.reduce(reduceEntry, initialState());
  assert.deepEqual(events, before);
  assert.deepEqual(replayLedger(events.map(entry)), state);
  assert.equal(state.job.status, 'paused');
  assert.equal(state.job.consults.r1.input_tokens, 10);
  assert.deepEqual(state.job.oracle_task_ids, ['owned-1']);
  assert.equal(state.job.verdicts[0].verdict, 'STOP');
  assert.equal(state.job.stops.s1.status, 'overridden');
  assert.equal(state.job.overrides[0].actor, 'owner');
  assert.equal(state.job.seed.hash, 'hash1');
  assert.equal(state.job.counters.nudges, 1);
  assert.equal(state.job.progress_revision, 4);
  assert.equal(state.job.gate_state, 'ACTIVE');
  state.job.seed.goal = 'Changed only in the returned state';
  state.job.verdicts[0].reasons[0].text = 'Changed only in the returned verdict';
  assert.deepEqual(events, before);
});

test('rebuild durably interrupts in-flight consults once and never dispatches tools', () => {
  const fake = createFakePi({ entries: [
    entry(opened), entry({ type: 'consult_reserved', request_id: 'r1', kind: 'work' }),
    entry({ type: 'consult_started', request_id: 'r1' }),
  ] });
  const ledger = createLedger(fake.pi);
  ledger.rebuild(fake.entries);
  assert.equal(ledger.state.job.consults.r1.status, 'interrupted');
  assert.equal(fake.calls.appendEntry.at(-1)[1].type, 'consult_interrupted');
  const rebuilt = structuredClone(ledger.state);
  ledger.rebuild(fake.entries);
  assert.deepEqual(ledger.state, rebuilt);
  assert.equal(fake.calls.appendEntry.length, 1);
  assert.equal(fake.calls.executeTool.length, 0);
});

test('branch rebuild excludes entries not on the selected branch', () => {
  const ledger = createLedger(createFakePi().pi);
  ledger.rebuild([entry(opened), entry({ type: 'oracle_assigned', oracle_task_id: 'left' })]);
  ledger.rebuild([entry(opened), entry({ type: 'oracle_assigned', oracle_task_id: 'right' })]);
  assert.equal(ledger.state.job.oracle_task_id, 'right');
  assert.deepEqual(ledger.state.job.oracle_task_ids, ['right']);
});

test('persistence failure cannot change in-memory state', () => {
  const ledger = createLedger({ appendEntry() { throw new Error('disk full'); } });
  assert.throws(() => ledger.append(opened), /disk full/);
  assert.deepEqual(ledger.state, initialState());
});

test('a newly reduced record never retains mutable input references', () => {
  const seed = { hash: 'original', criteria: [{ id: 'AC1', text: 'Original' }] };
  const state = reduceEntry(reduceEntry(initialState(), opened), { type: 'seed_bound', seed });
  seed.criteria[0].text = 'Changed by the caller after persistence';
  assert.equal(state.job.seed.criteria[0].text, 'Original');
});

test('released reservations refund their slots once; epoch changes preserve STOPs', () => {
  const state = [
    opened,
    { type: 'consult_reserved', request_id: 'r1', kind: 'work' },
    { type: 'consult_released', request_id: 'r1', status: 'unavailable' },
    { type: 'consult_released', request_id: 'r1', status: 'unavailable' },
    { type: 'stop_opened', stop_id: 's1' },
    { type: 'seed_bound', seed: { hash: 'a' } },
    { type: 'seed_bound', seed: { hash: 'b' } },
  ].reduce(reduceEntry, initialState());
  assert.equal(state.job.counters.consults, 0);
  assert.equal(state.job.counters.work, 0);
  assert.equal(state.job.job_epoch, 2);
  assert.equal(state.job.stops.s1.status, 'open');
  assert.equal(state.job.gate_state, 'HELD');
});
