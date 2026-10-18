import test from 'node:test';
import assert from 'node:assert/strict';
import { runT19a3Counterexamples, verifierCounterexampleIds } from '../qa/audit-t19a3-counterexamples.mjs';
import { verdictSpec } from '../qa/verdict-spec.mjs';

const audit = runT19a3Counterexamples();

function assertRowRejection(result) {
  const diagnostic = JSON.stringify(result);
  assert.equal(result.accepted, false, diagnostic);
  assert.equal(result.rejected, true, diagnostic);
  assert.equal(result.unexpected_error, false, diagnostic);
  assert.notEqual(result.error_name, 'TypeError', diagnostic);
  assert.ok(['ERR_ASSERTION', 'scenario_not_reached'].includes(result.code), diagnostic);
  assert.ok(['admission', 'behavioral'].includes(result.phase), diagnostic);
  assert.ok(verdictSpec.some(row => row.id === result.row && row.cases.includes(result.family)), diagnostic);
}

test('task 19 attempt 3 replays all 32 original cases plus R12 without double counting R7/H1/H2', () => {
  assert.equal(audit.distinct_catalog_counterexamples, 32);
  assert.equal(audit.distinct_new_counterexamples, 33);
  assert.equal(audit.catalog.evaluations, 64);
  assert.equal(audit.explicit_r12.evaluations, 2);
  assert.equal(audit.evaluations, 66);
  assert.equal(new Set(audit.results.map(result => result.id)).size, 33);
  assert.deepEqual([...new Set(audit.results.map(result => result.id))].sort(),
    [...verifierCounterexampleIds].sort());
  for (const id of verifierCounterexampleIds) {
    const results = audit.results.filter(result => result.id === id);
    assert.deepEqual(results.map(result => result.real).sort(), [false, true], id);
  }
  assert.equal(audit.supplemental_r7_direct.cases, 3);
  assert.equal(audit.supplemental_r7_direct.counted_as_new, 0);
  assert.equal(audit.actual_real_model_calls, 0);
  assert.equal(audit.actual_native_qa_calls, 0);
});

test('task 19 attempt 3 executes every original probe body and preserves its immutable inputs', () => {
  assert.deepEqual(audit.original_probe_execution.map(entry => entry.name),
    ['ce.mjs', 'r12.mjs', 'hold.mjs', 'r7-probe.mjs']);
  assert.deepEqual(audit.original_probe_execution.map(entry => entry.evaluations), [66, 1, 8, 3]);
  assert.ok(audit.original_probe_execution.every(entry => entry.source_sha256.length === 64));
  assert.ok(audit.verifier_manifest.length >= 11);
  assert.equal(audit.evidence_unchanged, true);
  const direct = audit.supplemental_r7_direct.original_output;
  for (const result of Object.values(direct)) assert.equal(result.replay_inside_window, true);
});

for (const result of audit.results) {
  test(`original verifier ${result.id} rejects at a current verdict row with real=${result.real}`, () => {
    assert.equal(result.host, true);
    assertRowRejection(result);
  });
}

for (const result of audit.supplemental_r7_direct.results) {
  test(`original r7-probe.mjs ${result.id} rejects without borrowing owner-end evidence`, () => {
    assertRowRejection(result);
  });
}

// The original H0 has a raw provider request and native running snapshot;
// its controlled-hold proof remains valid without synthetic observer backfill.
for (const result of audit.historical_controls.results.filter(entry =>
  ['control-stop-forged', 'control-stop-real', 'control-nudge-real', 'H0'].includes(entry.id))) {
  test(`historical native baseline ${result.id} still passes with real=${result.real}`, () => {
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.equal(result.classification, 'accepted');
  });
}

// Do not manufacture observer attestations for frozen receipts. Fresh controls
// are collected separately after the observer and admission repairs integrate.
for (const result of audit.historical_controls.results.filter(entry =>
  entry.id === 'control-R0-hold-before-private-retirement')) {
  test(`historical ${result.id} is evidence-deficient, not a current positive, with real=${result.real}`, () => {
    assertRowRejection(result);
    assert.equal(result.classification, 'evidence_deficient');
  });
}
