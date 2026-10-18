import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sourceHash, writeJson } from './harness.mjs';
import { verdictSpec } from './verdict-spec.mjs';
import { auditVerdicts } from './audit-verdict-spec.mjs';
import { auditDriverReceipts } from './audit-driver-receipts.mjs';

const directory = join(ROOT, '.omo/evidence/a1/task-19-piomo-oracle-advisor-mod');
const checkPath = join(directory, 'check-final-source.json');
const check = JSON.parse(readFileSync(checkPath, 'utf8'));
assert.equal(check.exit_code, 0);
assert.equal(check.failed, 0);
const matrixPath = attempt => join(ROOT, '.omo/evidence', attempt,
  'task-19-piomo-oracle-advisor-mod/mock-matrix.json');
const finalMatrix = JSON.parse(readFileSync(matrixPath('task19-native-final'), 'utf8'));
assert.equal(finalMatrix.cases, 40);
const isolated = JSON.parse(readFileSync(matrixPath('task19-isolated'), 'utf8'));
assert.equal(isolated.failed, 0);
const logRecheck = JSON.parse(readFileSync(matrixPath('task19-log-recheck'), 'utf8'));
assert.equal(logRecheck.failed, 0);
for (const failed of finalMatrix.results.filter(result => result.exit_code !== 0)) {
  assert.ok(isolated.results.some(result => result.case === failed.case && result.exit_code === 0),
    `No passing isolated rerun for ${failed.case}`);
}
const pilots = [
  'task-8-piomo-oracle-advisor-mod/stop-real.json',
  'task-9-piomo-oracle-advisor-mod/nudge-real.json',
  'task-10-piomo-oracle-advisor-mod/seed-bind-mock.json',
  'task-13-piomo-oracle-advisor-mod/acceptance.json',
].map(path => join(ROOT, '.omo/evidence/task19-pilot', path)).filter(existsSync);
const drivers = auditDriverReceipts(
  [matrixPath('task19-final'), matrixPath('task19-native-final'), matrixPath('task19-isolated'),
    matrixPath('task19-log-recheck')], [], pilots,
);
assert.equal(drivers.cases, 40);
const audit = auditVerdicts();
const covered = new Set([
  ...check.unit_rows.map(row => row.id), ...check.command_rows.map(row => row.id),
  ...drivers.observed_clause_ids,
]);
const missing = verdictSpec.filter(row => !covered.has(row.id)).map(row => row.id);
assert.deepEqual(missing, [], 'Every clause needs its own observed proof context.');
const identity = sourceHash();
const coverage = {
  ...audit.coverage, generated_at: new Date().toISOString(), source_hash: identity,
  plan: 'C:/Users/USER/orca/projects/\uAE30\uD0C0 \uC791\uC5C5/.omo/plans/piomo-oracle-advisor-mod.md',
  clauses: verdictSpec.length, observed_clauses: covered.size, missing_clauses: missing,
  unit_proof: { receipt: checkPath, tests: check.tests, passed: check.passed,
    failed: check.failed, unit_rows: check.unit_rows.length, command_rows: check.command_rows.length },
  mock_proof: { matrix: matrixPath('task19-native-final'), cases: drivers.cases,
    isolated_recheck: matrixPath('task19-isolated'),
    shutdown_log_recheck: matrixPath('task19-log-recheck'),
    host_and_probe_rows: drivers.observed_clause_ids.length,
    replay: join(directory, 'driver-replay.json') },
  cleanup: { owned_pids_confirmed_gone: drivers.owned_pids_confirmed_gone,
    disposable_homes_confirmed_absent: drivers.disposable_homes_confirmed_absent,
    earlier_failed_receipts: drivers.cleanup_receipts },
  real_models_exercised: false,
};
writeJson(join(directory, 'coverage.json'), coverage);
writeJson(join(directory, 'mutants.json'), { ...audit.mutants, source_hash: identity });
writeJson(join(directory, 'driver-replay.json'), drivers);
console.log(JSON.stringify({
  source_hash: identity, clauses: verdictSpec.length, observed_clauses: covered.size,
  tests: check.tests, tests_passed: check.passed, tests_failed: check.failed,
  unit_rows: check.unit_rows.length, command_rows: check.command_rows.length,
  mock_cases: drivers.cases, positive_controls: audit.coverage.positive_controls.length,
  rejected_mutants: audit.mutants.rejected, accepted_mutants: audit.mutants.accepted,
  owned_pids_confirmed_gone: drivers.owned_pids_confirmed_gone.length,
  disposable_homes_confirmed_absent: drivers.disposable_homes_confirmed_absent.length,
  real_model_calls: 0, evidence_directory: directory,
}));
