import test from 'node:test';
import assert from 'node:assert/strict';
import { decideProbe } from '../qa/probe-decision.mjs';

const observations = () => ({
  await: [{ name: 'omo.task.updated', works: true, independent_of_terminal: true }],
  revivals: [{ answered: true, status: 'completed', latency_ms: 12 }],
  stuck_record: { reproduced: false },
  policy: { schema_valid: true, exclusive: true, paths: ['root'] },
  foreground: { latency_ms: 8, abort_propagates: false },
  provider_idle_timeout: { applies: true, value_ms: 300000 },
});

test('a normal completed revival alone cannot enable residency', () => {
  assert.equal(decideProbe(observations()).live_residency, 'disabled');
});

test('a real answered running record proves the independent arrival mechanism', () => {
  const observed = observations();
  observed.revivals.push({ answered: true, status: 'running', latency_ms: 21 });
  assert.equal(decideProbe(observed).live_residency, 'enabled');
  assert.deepEqual(decideProbe(observed).answered_consult_latencies_ms, [8, 12, 21]);
});

test('schema success without exact effective tools cannot approve an allowlist', () => {
  const observed = observations();
  observed.policy.exclusive = false;
  const decision = decideProbe(observed);
  assert.equal(decision.allowlist_key, 'unproven');
  assert.deepEqual(decision.allowlist_paths, []);
});

test('the first working mechanism wins but terminal-dependent signals stay fresh-only', () => {
  const observed = observations();
  observed.await = [
    { name: 'omo.task.updated', works: false },
    { name: 'evalHandleHost', works: true, independent_of_terminal: false },
    { name: 'completion-notification', works: true, independent_of_terminal: true },
  ];
  observed.stuck_record.reproduced = true;
  assert.equal(decideProbe(observed).await_mechanism, 'evalHandleHost');
  assert.equal(decideProbe(observed).live_residency, 'disabled');
});
