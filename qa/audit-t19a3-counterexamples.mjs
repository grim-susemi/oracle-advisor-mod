import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runOriginalVerifierProbes, verdictResult } from '../test/helpers/t19a3-verifier-probes.mjs';

export { runOriginalVerifierProbes } from '../test/helpers/t19a3-verifier-probes.mjs';

const ids = [
  ...Array.from({ length: 11 }, (_, i) => `R${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `S${i + 1}`),
  'H1', 'H2', 'H3',
];
export const verifierCounterexampleIds = Object.freeze([...ids, 'R12']);

function diagnostic(id, origin, call) {
  const { observation, options, ...result } = call;
  return { id, origin, ...result, real: options.real, host: options.host,
    oracle: options.oracle };
}

export function runT19a3Counterexamples(probeOptions = {}) {
  const replay = runOriginalVerifierProbes(probeOptions);
  const script = name => replay.scripts.find(entry => entry.name === name);
  const ce = script('ce.mjs'), hold = script('hold.mjs'), r12 = script('r12.mjs');
  const negatives = [], historicalControls = [];
  assert.equal(ce.definitions.length * 2, ce.calls.length);
  const retained = JSON.parse(ce.outputs['new-counterexamples.json']);
  assert.deepEqual(ce.definitions.map(entry => entry.id),
    replay.original_catalog.map(entry => entry.id));
  assert.deepEqual(retained.map(entry => entry.id), ce.definitions.map(entry => entry.id));
  ce.definitions.forEach((entry, index) => {
    for (const call of ce.calls.slice(index * 2, index * 2 + 2)) {
      const result = diagnostic(entry.id.split('-')[0], 'ce.mjs', call);
      result.name = entry.id;
      if (entry.expect === 'accept') historicalControls.push({ ...result, id: entry.id });
      else negatives.push(result);
    }
  });
  assert.equal(hold.calls.length, 8);
  hold.calls.forEach((call, index) => {
    const id = `H${Math.floor(index / 2)}`;
    const result = diagnostic(id, 'hold.mjs', call);
    if (id === 'H0') historicalControls.push(result);
    else negatives.push(result);
  });
  assert.equal(r12.calls.length, 1);
  const originalR12 = r12.calls[0];
  negatives.push(diagnostic('R12', 'r12.mjs', originalR12));
  const options = { ...originalR12.options, real: false };
  negatives.push(diagnostic('R12', 'r12.mjs/additional-mode', {
    family: originalR12.family, observation: originalR12.observation, options,
    ...verdictResult(originalR12.family, originalR12.observation, options),
  }));
  assert.deepEqual([...new Set(negatives.map(result => result.id))].sort(),
    [...verifierCounterexampleIds].sort());
  assert.equal(negatives.length, 66);
  assert.equal(new Set(negatives.map(result => `${result.id}/${result.real}`)).size, 66);
  const supplemental = script('r7-probe.mjs').calls.map((call, index) =>
    diagnostic(['R7-direct', 'R7-without-end-retirement', 'R7-without-end-snapshot'][index],
      'r7-probe.mjs', call));
  // The original positive inputs are never backfilled. Incomplete historical
  // controls are explicitly evidence-deficient, not counted as passing controls.
  historicalControls.forEach(result => {
    result.classification = result.accepted ? 'accepted' :
      result.rejected ? 'evidence_deficient' : 'unexpected_error';
  });
  return {
    distinct_catalog_counterexamples: 32, distinct_new_counterexamples: 33,
    catalog: { cases: 32, evaluations: 64, results: negatives.filter(result => result.id !== 'R12') },
    explicit_r12: { cases: 1, evaluations: 2, results: negatives.filter(result => result.id === 'R12') },
    evaluations: negatives.length, results: negatives,
    rejected: negatives.filter(result => result.rejected).length,
    accepted: negatives.filter(result => result.accepted).length,
    unexpected_errors: negatives.filter(result => result.unexpected_error).length,
    historical_controls: { cases: 5, evaluations: historicalControls.length,
      accepted: historicalControls.filter(result => result.accepted).length,
      evidence_deficient: historicalControls.filter(result => result.classification === 'evidence_deficient').length,
      results: historicalControls },
    supplemental_r7_direct: { cases: 3, counted_as_new: 0, results: supplemental,
      original_output: JSON.parse(script('r7-probe.mjs').outputs['r7-probe.json']) },
    original_probe_execution: replay.scripts.map(({ name, source_sha256, outputs, calls, stdout }) =>
      ({ name, source_sha256, evaluations: calls.length, stdout,
        outputs: Object.fromEntries(Object.entries(outputs).map(([path, value]) => [path, JSON.parse(value)])) })),
    verifier_manifest: replay.manifest, evidence_unchanged: replay.evidence_unchanged,
    base_substitutions: replay.base_substitutions, fresh_manifest: replay.fresh_manifest,
    actual_real_model_calls: 0, actual_native_qa_calls: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runT19a3Counterexamples();
  console.log(JSON.stringify(result, null, 2));
  if (result.accepted || result.unexpected_errors ||
    result.supplemental_r7_direct.results.some(entry => !entry.rejected)) process.exitCode = 1;
}
