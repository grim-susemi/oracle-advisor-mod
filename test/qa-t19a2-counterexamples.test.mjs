import test from 'node:test';
import assert from 'node:assert/strict';
import { runT19a2Counterexamples } from '../qa/audit-t19a2-counterexamples.mjs';
import { verdictSpec } from '../qa/verdict-spec.mjs';

const audit = runT19a2Counterexamples();

test('task 19 attempt 2 replays all 22 catalog cases separately from native sensitivity rows', () => {
  assert.equal(audit.distinct_new_counterexamples, 22);
  assert.equal(audit.catalog.cases, 22);
  assert.equal(audit.catalog.evaluations, 44);
  assert.equal(new Set(audit.catalog.results.map(result => result.name)).size, 22);
  assert.equal(audit.supplemental_native.cases, 10);
  assert.equal(audit.supplemental_native.evaluations, 20);
  assert.equal(audit.supplemental_seed.cases, 1);
  assert.equal(audit.supplemental_seed.evaluations, 2);
  assert.equal(audit.evaluations, 66);
  assert.equal(audit.actual_real_model_calls, 0);
});

for (const group of [audit.catalog, audit.supplemental_native, audit.supplemental_seed]) {
  for (const result of group.results) {
    test(`${result.origin}: ${result.name} rejects with real=${result.real}`, () => {
      const diagnostic = JSON.stringify(result);
      assert.equal(result.accepted, false, diagnostic);
      assert.equal(result.unexpected_error, false, diagnostic);
      assert.equal(result.rejected, true, diagnostic);
      assert.notEqual(result.error_name, 'TypeError', diagnostic);
      assert.ok(['ERR_ASSERTION', 'scenario_not_reached'].includes(result.code), diagnostic);
      assert.ok(verdictSpec.some(row => row.id === result.row && row.cases.includes(result.family)), diagnostic);
      assert.ok(['admission', 'behavioral'].includes(result.phase), diagnostic);
      if (result.origin !== 'catalog' || result.input.startsWith('native-') ||
        result.input.endsWith('.native.input.json')) assert.equal(result.host, true, diagnostic);
    });
  }
}
