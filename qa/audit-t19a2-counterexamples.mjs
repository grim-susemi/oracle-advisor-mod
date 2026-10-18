import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateVerdict, verdictSpec } from './verdict-spec.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const reviewDirectory = fileURLToPath(new URL(
  '../.omo/evidence/a2/task-19-piomo-oracle-advisor-mod/review-a1/', import.meta.url));
const skill = readFileSync(new URL('../test/fixtures/seed-skill.yaml', import.meta.url), 'utf8');
// These two coordination tools were unavailable on the preserved native host.
const expectedTools = Object.keys(READONLY_ORACLE_TOOLS)
  .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort();
const inputBasename = input => basename(win32.basename(input));
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));

export function loadT19a2Counterexamples(directory = reviewDirectory) {
  const catalog = readJSON(join(directory, 'counterexample-catalog.json'));
  assert.equal(catalog.distinct_new_counterexamples, 22);
  assert.equal(catalog.rows.length, 22);
  assert.equal(new Set(catalog.rows.map(row => row.name)).size, 22);
  const native = readJSON(join(directory, 'native-receipt-probes.json'));
  const additional = readJSON(join(directory, 'additional-probes.json'));
  const unique = rows => [...new Map(rows.map(row => [row.name, row])).values()];
  const nativeRows = unique(native.results);
  const seedRows = unique(additional);
  assert.equal(nativeRows.length, 10);
  assert.equal(seedRows.length, 1);
  assert.equal(seedRows[0].family, 'seed-invalid');
  const groups = {
    catalog: catalog.rows,
    supplemental_native: nativeRows,
    supplemental_seed: seedRows,
  };
  return Object.entries(groups).flatMap(([origin, rows]) => rows.map(row => {
    // Absolute paths in the review are provenance, not live scratch dependencies.
    const input = inputBasename(row.input);
    const preserved = readJSON(join(directory, input));
    const enveloped = Object.hasOwn(preserved, 'options') && Object.hasOwn(preserved, 'observation');
    const observation = enveloped ? preserved.observation : preserved;
    const options = enveloped ? preserved.options : {};
    assert.ok(observation && typeof observation === 'object', input);
    assert.ok(options && typeof options === 'object' && !Array.isArray(options), input);
    return {
      name: row.name, family: row.family, origin, input,
      observation, options,
      host: origin !== 'catalog' || input.startsWith('native-') ||
        input.endsWith('.native.input.json') || Object.hasOwn(observation, 'cleanup') || options.host === true,
    };
  }));
}

export function runT19a2Counterexamples(directory = reviewDirectory) {
  const cases = loadT19a2Counterexamples(directory);
  const results = cases.flatMap(counterexample => [false, true].map(real => {
    const { name, family, origin, input, host } = counterexample;
    const observation = structuredClone(counterexample.observation);
    const options = {
      ...structuredClone(counterexample.options), real, host, skill,
      expectedTools: [...expectedTools], down: family === 'acceptance-oracle-down',
      coordination: observation.coordination?.present === true,
    };
    let failure;
    try {
      evaluateVerdict(family, observation, options);
    } catch (error) {
      failure = error;
    }
    const row = verdictSpec.find(candidate => candidate.id === failure?.verdict_row);
    const rejected = Boolean(failure && failure.name !== 'TypeError' &&
      ['ERR_ASSERTION', 'scenario_not_reached'].includes(failure.code) &&
      row?.cases.includes(family) && ['admission', 'behavioral'].includes(failure.verdict_phase));
    return {
      name, family, origin, input, real, host, accepted: !failure, rejected,
      unexpected_error: Boolean(failure && !rejected),
      row: failure?.verdict_row ?? null, phase: failure?.verdict_phase ?? null,
      code: failure?.code ?? null, error_name: failure?.name ?? null,
      message: failure?.message ?? null,
    };
  }));
  const summarize = origin => {
    const rows = results.filter(result => result.origin === origin);
    return {
      cases: cases.filter(counterexample => counterexample.origin === origin).length,
      evaluations: rows.length,
      rejected: rows.filter(result => result.rejected).length,
      accepted: rows.filter(result => result.accepted).length,
      unexpected_errors: rows.filter(result => result.unexpected_error).length,
      results: rows,
    };
  };
  // Native replays intentionally overlap catalog phenomena; never add them to 22.
  return {
    distinct_new_counterexamples: 22,
    catalog: summarize('catalog'),
    supplemental_native: summarize('supplemental_native'),
    supplemental_seed: summarize('supplemental_seed'),
    evaluations: results.length,
    rejected: results.filter(result => result.rejected).length,
    accepted: results.filter(result => result.accepted).length,
    unexpected_errors: results.filter(result => result.unexpected_error).length,
    actual_real_model_calls: 0,
    positive_controls: 'not_run',
  };
}
