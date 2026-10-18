import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateVerdict } from './verdict-spec.mjs';
import { ROOT } from './harness.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

export function auditDriverReceipts(matrixPaths, replacements = [], cleanupOnlyPaths = []) {
  const chosen = new Map();
  const failed_attempts = [];
  for (const path of matrixPaths) {
    const matrix = JSON.parse(readFileSync(path, 'utf8'));
    for (const result of matrix.results) {
      if (result.exit_code === 0) chosen.set(result.case, result.receipt);
      else failed_attempts.push(result);
    }
  }
  for (const path of replacements) {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    chosen.set(receipt.case, path);
  }
  const skill = readFileSync(join(ROOT, 'test/fixtures/seed-skill.yaml'), 'utf8');
  const expectedTools = Object.keys(READONLY_ORACLE_TOOLS)
    .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort();
  const pids = new Set(), homes = new Set(), cases = [], rowIds = new Set();
  const inspectCleanup = value => {
    if (!value || typeof value !== 'object') return;
    if (Number.isInteger(value.pid) && Object.hasOwn(value, 'pid_gone')) {
      assert.equal(value.pid_gone, true, `owned PID ${value.pid}`);
      pids.add(value.pid);
    }
    for (const key of ['temp_dir', 'temp_home']) if (typeof value[key] === 'string') homes.add(value[key]);
    for (const path of value.temp_dirs ?? []) if (typeof path === 'string') homes.add(path);
    if (value.removed === true && Number.isInteger(value.removed_files) &&
      typeof value.path === 'string') homes.add(value.path);
    if (value.removed === false || value.homes_removed === false || value.pids_gone === false ||
      value.all_owned_pids_gone === false || value.all_temporary_homes_removed === false) {
      assert.fail('An observed owned resource was not cleaned up.');
    }
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) for (const entry of item) inspectCleanup(entry);
      else if (item && typeof item === 'object') inspectCleanup(item);
    }
  };
  const cleanup_receipts = [...new Set([
    ...failed_attempts.map(attempt => attempt.receipt).filter(Boolean), ...cleanupOnlyPaths,
  ])];
  for (const path of cleanup_receipts) inspectCleanup(JSON.parse(readFileSync(path, 'utf8')));
  for (const [name, path] of chosen) {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(receipt.status, 'passed', path);
    assert.equal(receipt.exit_code, 0, path);
    for (const key of ['real_oracle_runs', 'real_model_calls', 'real_provider_calls']) {
      if (typeof receipt[key] === 'number') assert.equal(receipt[key], 0, path);
    }
    inspectCleanup(receipt);
    let canonical_event_log;
    if (['resident-3', 'resident-dead', 'resident-stuck', 'shutdown-inflight', 'consult-cache-budget',
      'cancel-after-promotion', 'answered-error-words'].includes(name)) {
      canonical_event_log = receipt.event_log_path ?? join(receipt.run_dir, 'probe.jsonl');
      receipt.events = readFileSync(canonical_event_log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    }
    const observations = name.startsWith('acceptance') ? receipt.variants
      : name.startsWith('trigger-') ? receipt.attempts.filter(attempt => attempt.main === 'mock') : [receipt];
    const proofs = [];
    for (const observation of observations) {
      const options = { real: false, host: true, oracle: 'mock', skill, expectedTools,
        down: name === 'acceptance-oracle-down', coordination: observation.coordination?.present === true };
      const rows = evaluateVerdict(name, observation, options);
      for (const row of rows) rowIds.add(row.id);
      proofs.push({ variant: observation.name ?? observation.main ?? null, rows });
    }
    cases.push({ case: name, receipt: path, canonical_event_log, source_hash: receipt.source_hash, proofs });
  }
  for (const home of homes) {
    const path = relative(resolve(tmpdir()), resolve(home));
    assert.ok(path && !path.startsWith('..'), `Home must be outside evidence, under OS temp: ${home}`);
    assert.equal(existsSync(home), false, `Disposable home remains: ${home}`);
  }
  return { cases: cases.length, results: cases, failed_attempts,
    observed_clause_ids: [...rowIds].sort(), cleanup_receipts, owned_pids_confirmed_gone: [...pids],
    disposable_homes_confirmed_absent: [...homes], actual_real_model_calls: 0 };
}
