import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictSpec, evaluateVerdict } from './verdict-spec.mjs';
import { drivers, matrix } from '../test/helpers/verdict-mutations.mjs';
import { reviewMutants } from '../test/helpers/review-mutations.mjs';
import { mediaControl, mediaMutants, correlateMedia } from '../test/helpers/media-verdict-mutations.mjs';
import { skill, visualTools } from '../test/helpers/scenario-fixtures.mjs';

const options = (name, real) => ({
  real, skill, expectedTools: visualTools, down: name === 'acceptance-oracle-down',
});
export function auditVerdicts() {
  const controls = [];
  for (const [name, driver] of Object.entries(drivers)) for (const real of [false, true]) {
    const value = driver.make();
    evaluateVerdict(name, value, options(name, real));
    controls.push({ case: name, real_verdict_branch: real, status: 'passed',
      rows: value.verdict_rows.map(row => row.id) });
  }
  const reject = (name, family, value, origin) => {
    let failure;
    try { evaluateVerdict(family, value, options(family, true)); }
    catch (error) { failure = error; }
    assert.ok(failure, `${name}: mutant accepted`);
    assert.ok(verdictSpec.some(row => row.id === failure.verdict_row), `${name}: no failing clause`);
    return { name, case: family, origin, rejected: true, row: failure.verdict_row,
      phase: failure.verdict_phase, code: failure.code ?? null, message: failure.message };
  };
  const mutants = [...matrix, ...reviewMutants].map(([name, family, mutate]) => {
    const value = drivers[family].make();
    mutate(value);
    return reject(name, family, value, 'complete-correlated-control');
  });
  const media = correlateMedia(mediaControl());
  evaluateVerdict('oracle-consumer-visual', media, options('oracle-consumer-visual', true));
  controls.push({ case: 'oracle-consumer-visual-with-media', real_verdict_branch: true,
    status: 'passed', rows: media.verdict_rows.map(row => row.id) });
  for (const [name, mutate] of mediaMutants) {
    const value = mediaControl();
    mutate(value);
    mutants.push(reject(name, 'oracle-consumer-visual', correlateMedia(value), 'correlated-media-control'));
  }
  const directory = fileURLToPath(new URL('../.omo/evidence/a1/task-19-piomo-oracle-advisor-mod/review-a3/', import.meta.url));
  const preserved = JSON.parse(readFileSync(join(directory, 'new-mutant-results.json'), 'utf8'));
  for (const mutant of preserved.mutants) {
    const value = JSON.parse(readFileSync(join(directory, basename(mutant.input)), 'utf8'));
    mutants.push(reject(mutant.name, mutant.family, value, 'preserved-review-input'));
  }
  mutants.push(reject('owned-cancel-resolved-target-preserved', 'stop-real',
    JSON.parse(readFileSync(join(directory, 'owned-cancel-resolved-target.input.json'), 'utf8')),
    'preserved-review-input'));
  return {
    coverage: { rows: verdictSpec.map(({ admission, behavioral, ...row }) => ({
      ...row, admission: typeof admission === 'function', behavioral: typeof behavioral === 'function',
    })), positive_controls: controls, actual_real_model_calls: 0 },
    mutants: { previous_matrix: matrix.length, new_review_mutants: reviewMutants.length,
      media_review_mutants: mediaMutants.length,
      preserved_review_inputs: preserved.mutants.length + 1,
      rejected: mutants.length, accepted: 0, results: mutants, actual_real_model_calls: 0 },
  };
}
