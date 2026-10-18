import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { callCostFixture, measureProgress } from './helpers/call-cost.mjs';

test('tool hook cost stays bounded after executed consult refusals', async t => {
  const f = callCostFixture();
  t.after(f.close);
  const pair = async id => {
    await f.call(id, 'bash', { command: 'owned-cost-check' });
    await f.result(id, 'bash', { exit_code: 0 });
  };
  const measure = async prefix => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) await pair(`${prefix}-${i}`);
    return (performance.now() - start) / 100;
  };
  for (let i = 0; i < 4; i++) await f.consult(`request-${i}`);
  for (let i = 0; i < 100; i++) await pair(`warm-${i}`);
  const early = await measure('early');
  for (let i = 4; i < 200; i++) {
    const response = await f.consult(`request-${i}`);
    assert.equal(response.details.status, 'cap_exhausted');
  }
  const late = await measure('late');
  assert.ok(late <= early * 2, JSON.stringify({ early, late, ratio: late / early }));
  assert.equal(Object.keys(f.ledger.state.requests).length, 200);
});

test('task progress event cost stays bounded with ten and fifty tasks active and ended', async t => {
  const f = callCostFixture();
  t.after(f.close);
  for (let i = 1; i <= 200; i++) await f.step(i);
  const early = Object.fromEntries([10, 50].map(tasks => [tasks, measureProgress(f, tasks)]));
  for (let i = 201; i <= 2000; i++) {
    await f.call(`event-${i}`, 'read', { path: 'fixture.mjs' });
    await f.result(`event-${i}`, 'read', { exit_code: 0 });
  }
  for (const active of [true, false]) {
    if (!active) f.ledger.append({ type: 'job_ended', job_id: 'J1' }, { snapshot: false });
    for (const tasks of [10, 50]) {
      const late = measureProgress(f, tasks);
      assert.ok(late <= early[tasks] * 2,
        JSON.stringify({ active, tasks, early: early[tasks], late, ratio: late / early[tasks] }));
    }
  }
});

test('tool hook cost stays bounded after retained tool history', async t => {
  const f = callCostFixture();
  t.after(f.close);
  await f.call('template', 'read', { path: 'fixture.mjs' });
  await f.result('template', 'read', { exit_code: 0 });
  const seed = f.ledger.triggerState;
  const template = seed.calls.template;
  const measure = async (history, phase) => {
    const calls = Object.fromEntries(Array.from({ length: history }, (_, i) =>
      [`retained-${i}`, { ...template, tool_call_id: `retained-${i}` }]));
    f.ledger.append({ type: 'trigger_state_recorded', job_id: 'J1',
      state: { ...seed, calls } }, { snapshot: false });
    for (let i = 0; i < 50; i++) {
      await f.call(`${phase}-warm-${i}`, 'read', { path: 'fixture.mjs' });
      await f.result(`${phase}-warm-${i}`, 'read', { exit_code: 0 });
    }
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await f.call(`${phase}-${i}`, 'read', { path: 'fixture.mjs' });
      await f.result(`${phase}-${i}`, 'read', { exit_code: 0 });
    }
    return (performance.now() - start) / 100;
  };
  const early = await measure(200, 'early-history');
  const late = await measure(5000, 'late-history');
  assert.ok(late <= early * 2, JSON.stringify({ early, late, ratio: late / early }));
  assert.equal(Object.keys(f.ledger.state.job.trigger_state.calls).length, 5150);
  assert.deepEqual(f.ledger.state, (await import('../src/ledger.mjs')).replayLedger(f.entries));
});
