import test from 'node:test';
import assert from 'node:assert/strict';
import { drivers } from './helpers/verdict-mutations.mjs';
import { reviewMutants } from './helpers/review-mutations.mjs';
import { mediaControl, mediaMutants, correlateMedia } from './helpers/media-verdict-mutations.mjs';
import { verdictSpec, evaluateRow } from '../qa/verdict-spec.mjs';

for (const [name, family, mutate] of reviewMutants) {
  test(`clause row rejects ${name}`, () => {
    const value = drivers[family].make();
    mutate(value);
    let failure;
    try { drivers[family].verdict(value); } catch (error) { failure = error; }
    assert.ok(failure, `${name} was accepted`);
    const row = verdictSpec.find(row => row.id === failure.verdict_row);
    assert.ok(row, `${name} must fail an identified clause row`);
    assert.ok(row.cases.includes(family));
    assert.ok(['admission', 'behavioral'].includes(failure.verdict_phase));
    // Replaying the actual failing row, rather than another driver assertion,
    // must reject the same counterexample.
    const options = family.startsWith('seed-') ? { real: true, skill:
      drivers[family].make().proofs.bound.seed_yaml } : family === 'oracle-consumer-visual'
      ? { expectedTools: drivers[family].make().oracle_requests[0].tools } :
        { real: true, down: family === 'acceptance-oracle-down' };
    assert.throws(() => evaluateRow(row, value, { ...options, caseName: family }));
  });
}

test('visual row accepts one exact fixture-bound media side response', () => {
  const value = correlateMedia(mediaControl());
  drivers['oracle-consumer-visual'].verdict(value);
  assert.equal(value.side_requests.length, 1);
});
for (const [name, mutate] of mediaMutants) test(`clause row rejects ${name}`, () => {
  const value = mediaControl();
  mutate(value);
  correlateMedia(value);
  let failure;
  try { drivers['oracle-consumer-visual'].verdict(value); } catch (error) { failure = error; }
  assert.ok(failure, `${name} was accepted`);
  assert.ok(verdictSpec.some(row => row.id === failure.verdict_row && row.todo === 11));
});

