import test from 'node:test';
import assert from 'node:assert/strict';
import { replayLedger } from '../src/ledger.mjs';
import { callCostFixture, mixedCallBenchmark } from './helpers/call-cost.mjs';

test('hot job facts stay detached from canonical state', async t => {
  const f = callCostFixture();
  t.after(f.close);
  for (let i = 1; i <= 80; i++) await f.step(i);
  const job = f.ledger.jobFacts;
  job.counters.consults = 100;
  job.oracle_task_ids.push('forged');
  job.trigger_state.predecessor = null;
  await f.step(81); await f.step(82);
  assert.equal(Object.keys(f.ledger.state.job.trigger_state.calls).length, 82);
  assert.equal(f.ledger.state.job.counters.consults, 4);
  assert.equal(f.ledger.ownsTask('forged'), false);
});

test('5000 mixed calls retain every id and exactly match cold reload at 600 and 5000', async t => {
  const f = callCostFixture();
  t.after(f.close);
  const benchmark = await mixedCallBenchmark(f, 5000, async count => {
    assert.equal(Object.keys(f.ledger.state.job.trigger_state.calls).length, count);
    assert.deepEqual(replayLedger(f.entries), f.ledger.state);
    const cold = callCostFixture(f.entries, f.ctx.cwd);
    try {
      assert.deepEqual(cold.ledger.state, f.ledger.state);
      await f.step(count + 1);
      await cold.step(count + 1);
      assert.deepEqual(cold.ledger.state, f.ledger.state);
      // The benchmark will redeliver this exact id on its next step.
    } finally { cold.close(); }
  });
  assert.equal(benchmark.executed_consults, 250);
  assert.equal(benchmark.native_dispatches, 4);
  assert.deepEqual(benchmark.refusal_statuses, { answered: 4, cap_exhausted: 246 });
  assert.ok(benchmark.means_ms['4901-5000'] <= benchmark.means_ms['101-200'] * 2,
    JSON.stringify(benchmark.means_ms));
  for (const [key, late] of Object.entries(benchmark.event_costs_ms[5000])) {
    assert.ok(late <= benchmark.event_costs_ms[200][key] * 2,
      JSON.stringify({ key, early: benchmark.event_costs_ms[200][key], late }));
  }
  assert.equal(Object.keys(f.ledger.state.job.trigger_state.calls).length, 5001);
});

test('a failed detector append resynchronizes before the next delivered event', async t => {
  const f = callCostFixture();
  t.after(f.close);
  await f.step(1);
  const append = f.pi.appendEntry;
  f.pi.appendEntry = (_type, data) => {
    if (data.type === 'trigger_state_recorded') throw new Error('fixture persistence failure');
    return append(_type, data);
  };
  await assert.rejects(f.call('lost', 'bash', { command: 'lost-operation' }), /fixture persistence failure/);
  f.pi.appendEntry = append;
  await f.call('other', 'bash', { command: 'lost-operation' });
  await f.result('other', 'bash', { exit_code: 1 });
  assert.deepEqual(replayLedger(f.entries), f.ledger.state);
  assert.equal(Object.hasOwn(f.ledger.state.job.trigger_state.calls, 'lost'), false);
  await f.call('lost', 'bash', { command: 'lost-operation' });
  await f.result('lost', 'bash', { exit_code: 1 });
  assert.deepEqual(replayLedger(f.entries), f.ledger.state);
  assert.equal(f.ledger.state.job.trigger_state.calls.lost.completed, true);
  assert.ok(f.ledger.state.job.nudges[0], 'The retained failure pair must produce its nudge after resynchronizing.');
  assert.deepEqual(f.ledger.state.job.nudges[0].tool_call_ids, ['other', 'lost']);
});
