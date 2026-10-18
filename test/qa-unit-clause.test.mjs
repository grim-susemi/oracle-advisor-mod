import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRow, verdictSpec } from '../qa/verdict-spec.mjs';

const row = () => verdictSpec.find(row => row.id === 't08.acceptance.explicit-allowlist');
function evidence() {
  const events = row().proof_tests.flatMap((proof, index) => {
    const record = { event: 'unit_test', test_id: `run-1:test-${index}`,
      file: proof.file, name: proof.name, skipped: false, todo: false };
    return [{ ...record, kind: 'attempt' }, { ...record, kind: 'passed' }];
  });
  return { events, test_exit_code: 0 };
}
test('unit Acceptance rows require a correlated actual execution and successful settlement', () => {
  const observation = evidence();
  evaluateRow(row(), observation, { caseName: 'unit-acceptance' });
  for (const mutate of [
    value => { value.events = value.events.filter(event => event.kind !== 'attempt'); },
    value => { value.events.at(-1).test_id = 'different-test'; },
    value => { value.events.at(-1).kind = 'failed'; },
    value => { value.events.at(-1).skipped = true; },
    value => { value.events.at(-1).todo = true; },
    value => { value.test_exit_code = 1; },
  ]) {
    const mutant = evidence();
    mutate(mutant);
    assert.throws(() => evaluateRow(row(), mutant, { caseName: 'unit-acceptance' }));
  }
});
