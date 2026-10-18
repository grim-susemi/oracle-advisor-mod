import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sourceHash, writeJson } from './harness.mjs';
import { auditVerdicts } from './audit-verdict-spec.mjs';
import { runT19a2Counterexamples } from './audit-t19a2-counterexamples.mjs';
import { runT19a3Counterexamples } from './audit-t19a3-counterexamples.mjs';
import { auditDriverReceipts } from './audit-driver-receipts.mjs';
import { replayBatch } from './replay-t19a3.mjs';
import { verdictSpec } from './verdict-spec.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const directory = join(ROOT, '.omo/evidence/a3/task-19-piomo-oracle-advisor-mod');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const check = json(join(directory, 'check.json'));
assert.equal(check.exit_code, 0);
assert.equal(check.failed, 0);
const freshMatrixPath = join(ROOT, '.omo/evidence/task19-a3-final/task-19-piomo-oracle-advisor-mod/mock-matrix.json');
const matrix = { ...json(freshMatrixPath), fresh_matrix: freshMatrixPath };
assert.equal(new Set(matrix.results.map(result => result.case)).size, 40);
const matrixPath = join(directory, 'native-matrix.json');
writeJson(matrixPath, matrix);
assert.equal(matrix.cases, 40);
assert.equal(matrix.passed, 40);
assert.equal(matrix.failed, 0);
const native = auditDriverReceipts([matrixPath]);
assert.equal(native.cases, 40);
const prior = auditVerdicts();
const attempt2 = runT19a2Counterexamples();
assert.equal(attempt2.rejected, 66);
assert.equal(attempt2.accepted, 0);
const original = runT19a3Counterexamples();
const current = runT19a3Counterexamples({ nativeMatrix: matrixPath });
for (const audit of [original, current]) {
  assert.equal(audit.rejected, 66);
  assert.equal(audit.accepted, 0);
  assert.equal(audit.unexpected_errors, 0);
  assert.ok(audit.supplemental_r7_direct.results.every(result => result.rejected));
}
assert.equal(current.historical_controls.accepted, 10,
  'Fresh ordinary, R0-private-retirement and H0-controlled-hold controls must all pass both modes.');
assert.equal(current.base_substitutions.length, 4);
const frozen = json(join(ROOT, '.omo/evidence/v19b/identity-before.json'));
const sourceIdentity = frozen.src.map(file => {
  const sha256 = digest(join(ROOT, file.path));
  assert.equal(sha256, file.sha256, file.path);
  return { ...file, actual_sha256: sha256, unchanged: true };
});
const expectedTools = Object.keys(READONLY_ORACLE_TOOLS)
  .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort();
const skill = readFileSync(join(ROOT, 'test/fixtures/seed-skill.yaml'), 'utf8');
const previousA7 = json(join(ROOT, '.omo/evidence/a7/replay-t19a2.json'));
const basis = new Map(previousA7.entries.filter(entry => entry.verdict === 'accepted')
  .map(entry => [entry.case, entry.acceptance_basis]));
basis.set('resident-stuck',
  'The actual mock-provider request matches the native task and full prompt; its unanswered hold is joined to the exact request/job/epoch before owner cancellation, and both cancelled consults retire their owned tasks.');
const replays = {};
for (const batch of ['a7', 'a8']) {
  const replay = replayBatch(join(ROOT, '.omo/evidence', batch), { batch, skill, expectedTools });
  for (const entry of replay.entries) {
    entry.reason = entry.reason.replace(/\x1b\[[0-9;]*m/g, '');
    if (entry.verdict === 'accepted') {
      assert.deepEqual(entry.completed_clause_ids, entry.clause_ids);
      assert.ok(basis.get(entry.case), `Missing acceptance basis: ${entry.case}`);
      entry.reason = basis.get(entry.case);
    }
    entry.clause_proofs = entry.clause_ids.map(id => {
      const row = verdictSpec.find(row => row.id === id);
      return { id, plan_line: row.plan_line, quote: row.quote, evidence_fields: row.evidence_fields };
    });
  }
  replay.evaluator_sha256 = Object.fromEntries(
    ['verdict-spec', 'scenario-observer', 'scenario-verdict', 'verdict-primary', 'verdict-aux', 'verdict-policy']
      .map(name => [`qa/${name}.mjs`, digest(join(ROOT, `qa/${name}.mjs`))]));
  writeJson(join(ROOT, `.omo/evidence/${batch}/replay-t19a3.json`), replay);
  writeJson(join(directory, `${batch}-raw-manifest-before.json`), replay.raw_manifest_before);
  writeJson(join(directory, `${batch}-raw-manifest-after.json`), replay.raw_manifest_after);
  replays[batch] = replay;
}
assert.equal(replays.a7.entries.length, 19);
assert.equal(replays.a8.entries.length, 15);
const a7Changes = replays.a7.entries.flatMap(entry => {
  const before = previousA7.entries.find(previous => previous.case === entry.case);
  assert.ok(before, entry.case);
  return before.verdict === entry.verdict ? [] :
    [{ case: entry.case, before: before.verdict, after: entry.verdict, reason: entry.reason }];
});
const perLog = replay => replay.entries.map(({ case: name, raw_log, verdict, reason, clause_ids, evaluator }) =>
  ({ case: name, raw_log, verdict, reason, clause_ids, evaluator }));
writeJson(join(directory, 'original-verifier-probes.json'), original);
writeJson(join(directory, 'fresh-verifier-probes.json'), current);
writeJson(join(directory, 'prior-counterexamples.json'), prior.mutants);
writeJson(join(directory, 'attempt2-counterexamples.json'), attempt2);
writeJson(join(directory, 'coverage.json'), prior.coverage);
writeJson(join(directory, 'native-replay.json'), native);
writeJson(join(directory, 'source-identity.json'), sourceIdentity);
const summary = {
  source_hash: sourceHash(),
  check: { exit_code: check.exit_code, tests: check.tests, passed: check.passed,
    failed: check.failed, unit_rows: check.unit_rows.length, command_rows: check.command_rows.length },
  verdict_rows: verdictSpec.length, prior_rejected: prior.mutants.rejected,
  prior_positive_controls: prior.coverage.positive_controls.length, attempt2_rejected: attempt2.rejected,
  original_verifier: { distinct_catalog_cases: 32, explicit_r12_cases: 1, distinct_cases: 33,
    evaluations: original.evaluations, rejected: original.rejected,
    direct_r7_rejected: original.supplemental_r7_direct.results.length,
    preserved_controls: original.historical_controls },
  fresh_verifier: { distinct_cases: 33, evaluations: current.evaluations, rejected: current.rejected,
    direct_r7_rejected: current.supplemental_r7_direct.results.length,
    control_evaluations: current.historical_controls.evaluations,
    controls_accepted: current.historical_controls.accepted, substitutions: current.base_substitutions },
  native_mock_matrix: { cases: matrix.cases, passed: matrix.passed, failed: matrix.failed,
    final_table_passed: native.cases, observed_clause_ids: native.observed_clause_ids.length,
    receipt: matrixPath, source_hashes: [...new Set(native.results.map(result => result.source_hash))] },
  source_files_unchanged: sourceIdentity.length,
  a7: { ...replays.a7.coverage, changes_from_attempt2: a7Changes, per_log: perLog(replays.a7) },
  a8: { ...replays.a8.coverage, per_log: perLog(replays.a8) },
  real_model_calls: 0, native_replay_model_calls: 0, commits_created: 0,
};
writeJson(join(directory, 'verification-summary.json'), summary);
console.log(JSON.stringify({ ...summary, original_verifier: {
  ...summary.original_verifier, preserved_controls: undefined },
  a7: { ...summary.a7, per_log: undefined }, a8: { ...summary.a8, per_log: undefined } }));
