import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sourceHash, writeJson } from './harness.mjs';
import { auditVerdicts } from './audit-verdict-spec.mjs';
import { runT19a2Counterexamples } from './audit-t19a2-counterexamples.mjs';
import { auditDriverReceipts } from './audit-driver-receipts.mjs';
import { replayA7 } from './replay-a7-t19a2.mjs';
import { verdictSpec } from './verdict-spec.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const directory = join(ROOT, '.omo/evidence/a2/task-19-piomo-oracle-advisor-mod');
const a7 = join(ROOT, '.omo/evidence/a7');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const rawPaths = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? rawPaths(join(directory, entry.name)) :
    /\.(?:ordered\.jsonl|log)$|(?:probe|receipts)\.jsonl$|batch-summary\.json$/.test(entry.name)
      ? [join(directory, entry.name)] : []);
const immutable = Object.fromEntries(rawPaths(a7).map(path => [path, digest(path)]));
const check = json(join(directory, 'check-final.json'));
assert.equal(check.command, 'npm run check');
assert.equal(check.exit_code, 0);
assert.equal(check.failed, 0);

const previous = auditVerdicts();
const current = runT19a2Counterexamples();
assert.equal(current.distinct_new_counterexamples, 22);
assert.equal(current.rejected, current.evaluations);
assert.equal(current.accepted, 0);
assert.equal(current.unexpected_errors, 0);
const changedMatrix = join(ROOT,
  '.omo/evidence/task19-a2-triage/task-19-piomo-oracle-advisor-mod/mock-matrix.json');
const changed = json(changedMatrix);
assert.equal(changed.cases, 10);
assert.equal(changed.passed, 10);
assert.equal(changed.failed, 0);
const native = auditDriverReceipts([
  ...['task19-final', 'task19-native-final', 'task19-isolated', 'task19-log-recheck']
    .map(attempt => join(ROOT, `.omo/evidence/${attempt}/task-19-piomo-oracle-advisor-mod/mock-matrix.json`)),
  changedMatrix,
]);
assert.equal(native.cases, 40);
const replay = replayA7(a7, {
  skill: readFileSync(join(ROOT, 'test/fixtures/seed-skill.yaml'), 'utf8'),
  expectedTools: Object.keys(READONLY_ORACLE_TOOLS)
    .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort(),
});
assert.equal(replay.coverage.replayed_cases, 19);
assert.equal(replay.coverage.discovered_ordered_logs, 19);
for (const name of ['stop-forged', 'nudge-real', 'resident-stuck', 'acceptance', 'acceptance-oracle-down']) {
  assert.notEqual(replay.entries.find(entry => entry.case === name)?.verdict, 'accepted', name);
}
const basis = {
  'consult-real': 'One scoped work request, its native oracle dispatch, canonical capture, answered result, accounting and retirement agree.',
  'consult-cap': 'Four admitted model calls consume the cap; the fifth scoped request returns cap_exhausted without another native dispatch.',
  'consult-not-readonly': 'The actual unsafe oracle policy refuses before a model call; refusal, capture, terminal result and accounting agree.',
  'consult-no-job': 'The actual no-job request is refused without native dispatch or consumed slot.',
  'resident-3': 'Three same-job consults obey the captured fresh-only/live-residency decision and leave no running or resident oracle after end.',
  'resident-dead': 'The observed between-consult death obeys the captured residency decision and the replacement request and retirement identities agree.',
  'stop-real': 'STOP blocks edit and rename; its own disposition returns ACTIVE and the exact retry succeeds. Later completion advice and remediation are separate observations.',
  'seed-bind': 'Exact submitted Seed bytes and hash join their binding call and epoch, reload, negative inputs, override, rebind and drift snapshots.',
  'seed-invalid': 'The fixed invalid-input challenges and actual current model binding are independently joined to their results and scoped Seed snapshots.',
  'trigger-real': 'The required serial failures and emitted trigger refer to the same actual operation and call IDs; observation prose supplies no trigger.',
  lifecycle: 'Each lifecycle snapshot has its own command span, observed session, job and epoch; the closed job is retired.',
  'oracle-readonly': 'The actual owned oracle child and provider schemas expose only the permitted read-only surface; native child and retirement evidence agree.',
  'oracle-write-attempt': 'The owned read-only child cannot execute the requested mutation; actual schemas, child tool records and unchanged fixture agree.',
  'oracle-consumer-visual': 'The named oracle child reads the exact fixture image, its own provider response consumes that image, and separate media identities are not reused.',
  'oracle-profile-switch': 'Captured effective profile configurations independently prove unsafe-profile refusal and repaired allowlist behavior.',
  'oracle-project-override-write': 'The captured project override and effective configuration independently prove unsafe write-surface refusal.',
};
for (const entry of replay.entries.filter(entry => entry.verdict === 'accepted')) {
  assert.ok(basis[entry.case], `Missing accepted-case explanation: ${entry.case}`);
  assert.deepEqual(entry.completed_clause_ids, entry.clause_ids);
  entry.acceptance_basis = basis[entry.case];
  entry.clause_proofs = entry.clause_ids.map(id => {
    const row = verdictSpec.find(row => row.id === id);
    return { id, plan_line: row.plan_line, quote: row.quote, evidence_fields: row.evidence_fields };
  });
}
replay.evaluator_sha256 = Object.fromEntries(
  ['verdict-spec', 'scenario-verdict', 'verdict-primary', 'verdict-aux', 'verdict-policy'].map(name =>
    [`qa/${name}.mjs`, digest(join(ROOT, `qa/${name}.mjs`))]));
assert.deepEqual(Object.fromEntries(Object.keys(immutable).map(path => [path, digest(path)])), immutable);
writeJson(join(a7, 'replay-t19a2.json'), replay);
writeJson(join(directory, 'counterexamples.json'), current);
writeJson(join(directory, 'coverage.json'), previous.coverage);
writeJson(join(directory, 'prior-counterexamples.json'), previous.mutants);
writeJson(join(directory, 'native-replay.json'), native);
writeJson(join(directory, 'a7-raw-manifest.json'), { unchanged: true, sha256: immutable });
const result = {
  source_hash: sourceHash(), check: { exit_code: check.exit_code, tests: check.tests,
    passed: check.passed, failed: check.failed, unit_rows: check.unit_rows.length,
    command_rows: check.command_rows.length },
  table_rows: verdictSpec.length, prior_counterexamples_rejected: previous.mutants.rejected,
  positive_controls: previous.coverage.positive_controls.length,
  new_counterexamples: current.distinct_new_counterexamples,
  new_evaluations_rejected: current.rejected, native_controls: native.cases,
  changed_native_mock_cases: changed.passed, observed_native_clause_ids: native.observed_clause_ids.length,
  a7_replay: replay.coverage, a7_raw_logs_unchanged: true,
  actual_real_model_calls: 0, commits_created: 0,
};
writeJson(join(directory, 'verification-summary.json'), result);
console.log(JSON.stringify(result));
