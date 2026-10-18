import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictSpec, evaluateRow } from '../qa/verdict-spec.mjs';
import { assertHeldExecutions } from '../qa/scenario-verdict.mjs';
import {
  detail, skill, visualTools,
} from './helpers/scenario-fixtures.mjs';
import { drivers, matrix } from './helpers/verdict-mutations.mjs';

for (const [name, driver] of Object.entries(drivers)) test(`${name}: complete real scenario positive control`, () => {
  const observation = driver.make();
  assert.doesNotThrow(() => driver.verdict(observation));
  assert.ok(observation.verdict_rows.length > 0);
  assert.ok(observation.verdict_rows.every(row => row.admission && row.behavioral));
});
test('atomic terminal packets expose their STOP effects at the durable packet boundary', () => {
  const observation = drivers['stop-real'].make();
  const hold = observation.events.find(event => event.kind === 'ledger' && event.record.type === 'stop_opened');
  hold.record = { type: 'consult_finished', events: [hold.record] };
  assert.doesNotThrow(() => drivers['stop-real'].verdict(observation));
  const at = observation.events.findIndex(event => event.kind === 'attempt' && event.name === 'oracle_record_stop');
  observation.events.splice(at, 0,
    { event: 'evidence', kind: 'attempt', call_id: 'escape', name: 'edit', input: {} },
    { event: 'evidence', kind: 'executed', call_id: 'escape', name: 'edit', result: detail({}), is_error: false });
  assert.throws(() => drivers['stop-real'].verdict(observation), assert.AssertionError);
});

const behavioral = new Set([
  'old-stop-bypass', 'old-forged-override', 'old-nudge-missing', 'old-nudge-extra',
  'stop-partial-escape', 'nudge-corrupt-patch',
  'violation-then-disposition', 'seed-unsuccessful-bind',
  'acceptance-escaped-held-write', 'down-failed-final-test', 'visual-write-tool',
]);
for (const [mutation, name, mutate] of matrix) test(`${name}: real verdict rejects ${mutation}`, () => {
  const observation = drivers[name].make();
  mutate(observation);
  if (['forged-write-restore', 'violation-then-restore'].includes(mutation)) {
    assert.throws(() => assertHeldExecutions(observation.events), assert.AssertionError);
  }
  const code = behavioral.has(mutation) || mutation.startsWith('guarded-') ? 'ERR_ASSERTION' : 'scenario_not_reached';
  let failure;
  assert.throws(() => {
    try { drivers[name].verdict(observation); }
    catch (error) { failure = error; throw error; }
  }, { code });
  const row = verdictSpec.find(row => row.id === failure.verdict_row);
  assert.ok(row, `${mutation} must fail a clause row`);
  assert.ok(row.cases.includes(name));
  const options = name.startsWith('seed-') ? { real: true, skill } :
    name === 'oracle-consumer-visual' ? { expectedTools: visualTools } :
      { real: true, down: name === 'acceptance-oracle-down' };
  assert.throws(() => evaluateRow(row, observation, { ...options, caseName: name }));
});
