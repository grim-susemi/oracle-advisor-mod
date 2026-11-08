import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { evaluateVerdict } from './verdict-spec.mjs';
import { sourceHash, writeJson } from './harness.mjs';
import { assertNodeLaunch, checkPhaseFiles, nodeSpawnEnvironment } from './node-spawn.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const allFiles = readdirSync(resolve(root, 'test')).filter(name => name.endsWith('.test.mjs'))
  .sort().map(name => `test/${name}`);
const phase = process.env.ORACLE_QA_CHECK_PHASE;
const files = phase === undefined ? allFiles : checkPhaseFiles(phase);
const source_hash = sourceHash();
const prior = [];
if (phase === '16/16') {
  assert.ok(process.env.ORACLE_QA_CHECK_PARTS, 'Final phase requires prior observations');
  for (let number = 1; number < 16; number++) {
    const record = JSON.parse(readFileSync(join(process.env.ORACLE_QA_CHECK_PARTS,
      `phase-${number}.json`), 'utf8'));
    assert.equal(record.phase, `${number}/16`);
    assert.equal(record.test_exit_code, 0);
    assert.equal(record.exit_code, 0);
    assert.equal(record.source_hash, source_hash, 'All phases must use the same source');
    assert.deepEqual(record.all_test_files, allFiles);
    assert.deepEqual(record.test_files, checkPhaseFiles(record.phase));
    assert.deepEqual(record.test_argv.slice(1), ['--test', '--test-isolation=none',
      '--test-reporter=./qa/verdict-test-reporter.mjs', ...record.test_files]);
    prior.push(record);
  }
  assert.deepEqual([...prior.flatMap(record => record.test_files), ...files].sort(), allFiles);
}
const argv = ['--test', '--test-isolation=none', '--test-reporter=./qa/verdict-test-reporter.mjs', ...files];
const run_id = randomUUID();
const events = [{ event: 'check', kind: 'attempt', request_id: run_id, argv: process.argv }];
const environment = nodeSpawnEnvironment(process.env);
assertNodeLaunch(process.execPath, argv, environment, { nodeProfile: phase === undefined ? 'check' : 'check-phase' });
const child = spawn(process.execPath, argv, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'inherit'] });
const testIdentity = { event: 'check_child', request_id: `${run_id}/test`, parent_request_id: run_id,
  pid: child.pid, argv: child.spawnargs };
events.push({ ...testIdentity, kind: 'attempt' });
const completion = new Promise((resolveCompletion, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolveCompletion({ code, signal }));
});
let passed = 0, failed = 0;
const diagnostics = [];
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
  if (!line.startsWith('ORACLE_VERDICT_TEST ')) {
    diagnostics.push(line);
    console.log(line);
    continue;
  }
  const record = JSON.parse(line.slice('ORACLE_VERDICT_TEST '.length));
  const file = record.file ? relative(root, record.file).replaceAll('\\', '/') : '';
  const test_id = `${run_id}:${file}:${record.name}:${record.line}:${record.column}`;
  const kind = record.type === 'test:enqueue' ? 'attempt' : record.type === 'test:pass' ? 'passed' : 'failed';
  events.push({ event: 'unit_test', kind, test_id, file, name: record.name,
    skipped: record.skipped, todo: record.todo });
  if (kind === 'passed') passed++;
  if (kind === 'failed') {
    failed++;
    console.error(`FAIL ${file}: ${record.name}\n${record.error?.stack ?? record.error?.message ?? ''}`);
  }
}
const result = await completion;
events.push({ ...testIdentity, kind: 'settled', exit_code: result.code });
console.log(`tests ${passed + failed}; pass ${passed}; fail ${failed}; exit ${result.code}`);
if (result.code !== 0 || result.signal) process.exitCode = result.code || 1;
let rows = [], commands = [], buildArgv = null;
try {
if (result.code === 0 && !result.signal && (phase === undefined || phase === '16/16')) {
  events.unshift(...prior.flatMap(record => record.events));
  const observation = { events, run_id,
    test_exit_code: result.code, argv: [process.execPath, ...argv] };
  rows = evaluateVerdict('unit-acceptance', observation);
  console.log(`clause acceptance: ${rows.length} correlated rows passed`);
  assertNodeLaunch(process.execPath, ['scripts/build.mjs'], environment);
  const build = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, env: environment, stdio: 'inherit' });
  buildArgv = build.spawnargs;
  const buildIdentity = { event: 'check_child', request_id: `${run_id}/build`, parent_request_id: run_id,
    pid: build.pid, argv: build.spawnargs };
  events.push({ ...buildIdentity, kind: 'attempt' });
  const built = await new Promise((resolveBuild, reject) => {
    build.once('error', reject);
    build.once('close', (code, signal) => resolveBuild({ code, signal }));
  });
  events.push({ ...buildIdentity, kind: 'settled', exit_code: built.code });
  commands = evaluateVerdict('command-acceptance', observation);
  console.log(`check command: ${commands.length} test/build clause rows passed`);
  if (phase) console.log(`integrated phases 16; files ${allFiles.length}; tests ${
    prior.reduce((sum, record) => sum + record.tests, passed + failed)}`);
}
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
if (process.env.ORACLE_QA_VERDICT_CHECK_EVIDENCE) writeJson(process.env.ORACLE_QA_VERDICT_CHECK_EVIDENCE, {
  command: 'npm run check', argv: process.argv, run_id, phase: phase ?? null, source_hash,
  all_test_files: allFiles, test_files: files, test_argv: child.spawnargs,
  build_argv: buildArgv, test_exit_code: result.code, exit_code: process.exitCode ?? 0,
  tests: passed + failed, passed, failed, unit_rows: rows, command_rows: commands,
  total_tests: prior.reduce((sum, record) => sum + record.tests, passed + failed),
  total_passed: prior.reduce((sum, record) => sum + record.passed, passed),
  total_failed: prior.reduce((sum, record) => sum + record.failed, failed),
  events, diagnostics,
});
}
