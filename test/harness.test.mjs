import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ROOT, OwnedProcess, cleanupDisposableState, disposableEnvironment, guardAuth, readJson, reserveRealOracleRuns } from '../qa/harness.mjs';
import { startMockProvider } from '../qa/mock-provider.mjs';
import cheapMain from '../qa/main-provider.mjs';
import { mainKey } from '../qa/auth-guard.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'oracle-harness-test-'));
after(() => rmSync(fixtures, { recursive: true, force: true }));

test('owned process cleanup works when the driver and child environments lack PATH', { timeout: 15000 }, async () => {
  const source = `
    import assert from 'node:assert/strict';
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'path') delete process.env[key];
    }
    const { OwnedProcess } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'qa/harness.mjs')).href)});
    assert.equal(Object.keys(process.env).some(key => key.toLowerCase() === 'path'), false);
    const child = new OwnedProcess(process.execPath,
      [${JSON.stringify(join(ROOT, 'qa/owned-process-fixture.mjs'))}, 'ready'],
      { env: {}, deadlineMs: 5000 });
    try {
      const ready = await child.waitFor(event => event.type === 'ready', 'owned child ready', { timeoutMs: 3000 });
      assert.equal(ready.path_present, false);
      await child.stop({ force: true });
    } catch (error) {
      child.child.kill();
      await child.exit;
      throw error;
    }
    assert.equal(child.metadata.pid_gone, true);
    assert.equal(child.metadata.timed_out, false);
    console.log(JSON.stringify({ pid_gone: true, path_present: false }));
  `;
  const environment = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    Path: 'fixture-parent-search-path',
  };
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { pid_gone: true, path_present: false });
});

test('unrelated startup failure is not relabelled as a missing extension', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(fixtures, 'startup-'));
  let run;
  t.after(async () => {
    if (run) await run.stop({ force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const product = join(directory, 'product');
  cpSync(ROOT, product, { recursive: true, filter: path =>
    !['.git', '.omo', 'dist'].includes(basename(path)) && !basename(path).startsWith('.dist-stage-') });
  const { OwnedProcess: FixtureProcess } = await import(pathToFileURL(join(product, 'qa/harness.mjs')).href);
  const attempt = `test-startup-${directory.split(/[\\/]/).at(-1)}`;
  const attemptDir = join(product, '.omo/evidence', attempt);
  const fixture = (name, source) => {
    const path = join(directory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, source);
    return path;
  };
  const engine = fixture('a/b/c/d/cli.mjs', 'console.log("success"); console.error("Unrelated startup fixture"); process.exitCode = 23;');
  const launcher = fixture('launcher.mjs', 'console.log("--extension, -e <path>");');
  const plugin = fixture('plugin.mjs', '');
  fixture('@code-yeongyu/senpi/package.json', '{"version":"fixture"}');
  fixture('omo-ai/package.json', '{"version":"fixture"}');
  const agent = join(directory, 'live-agent');
  mkdirSync(agent);
  run = new FixtureProcess(process.execPath,
    [join(product, 'qa/run.mjs'), '--case', 'host-missing-ext', '--attempt', attempt, '--main', 'mock'], {
      cwd: product, deadlineMs: 10000,
      env: { ...process.env, OMO_STABLE_SENPI_BUNDLE: engine, OMO_STABLE_REENTRY: launcher,
        OMO_STABLE_PLUGIN: plugin, ORACLE_QA_LIVE_AGENT: agent },
    });
  run.child.stdin.end();
  await run.exit;
  assert.equal(run.metadata.exit_code, 1, run.stderr);
  const receiptPath = join(attemptDir, 'task-1-piomo-oracle-advisor-mod/host-missing-ext.json');
  assert.equal(existsSync(receiptPath), true, run.stderr);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.error.type, 'host_exited');
  assert.equal(receipt.status, 'host_exited');
  assert.equal(receipt.cleanup.all_owned_pids_gone, true);
  assert.ok(receipt.cleanup.disposable_state.every(state => state.removed));
});

test('real oracle budget reserves before dispatch and refuses run 25', t => {
  const directory = mkdtempSync(join(fixtures, 'budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(reserveRealOracleRuns(directory, 23), 23);
  assert.equal(reserveRealOracleRuns(directory), 24);
  assert.throws(() => reserveRealOracleRuns(directory), { code: 'real_oracle_cap_exhausted' });
  assert.equal(readJson(join(directory, 'real-model-safety.json')).real_oracle_runs, 24);
  assert.throws(() => reserveRealOracleRuns(directory, -1), { code: 'invalid_run_count' });
});

test('changed credential hash persists a block and never resets the baseline', t => {
  const directory = mkdtempSync(join(fixtures, 'auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agent = join(directory, 'fake-live');
  mkdirSync(agent);
  writeFileSync(join(agent, 'auth.json'), '{"fixture":true}');
  const before = guardAuth(directory, agent, { before: true });
  assert.deepEqual(guardAuth(directory, agent), before);
  writeFileSync(join(agent, 'credential-pool-state.json'), '{}');
  assert.throws(() => guardAuth(directory, agent), { code: 'auth_changed' });
  assert.throws(() => guardAuth(directory, agent, { before: true }), { code: 'auth_changed' });
  assert.throws(() => reserveRealOracleRuns(directory), { code: 'auth_changed' });
  const state = readJson(join(directory, 'real-model-safety.json'));
  assert.equal(state.blocked, true);
  assert.deepEqual(state.auth_baseline, before);
});

test('mock oracle hook supplies verdicts and scripted tool calls over local HTTP', async t => {
  const mock = await startMockProvider({
    steps: [{ tool: 'example', arguments: { fixture: 1 } }, { text: '{"verdict":"STOP","reasons":["fixture"]}' }],
  });
  t.after(() => mock.close());
  const call = async () => {
    const response = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'oracle', stream: true, messages: [{ role: 'user', content: 'fixture' }] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const first = await call();
  assert.match(first, /tool_calls/);
  assert.match(first, /example/);
  const second = await call();
  assert.match(second, /STOP/);
  assert.equal(mock.requests.length, 2);
});

test('disposable runtime is outside evidence and cleanup retains only the owned transcript', t => {
  const directory = mkdtempSync(join(fixtures, 'state-'));
  const sandbox = disposableEnvironment({}, directory, { ORACLE_QA_ATTEMPT: 'unit' });
  t.after(() => {
    rmSync(sandbox.stateDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(sandbox.stateDir.startsWith(ROOT), false);
  writeFileSync(join(sandbox.sessionDir, 'owned.jsonl'), '{"fixture":true}\n');
  writeFileSync(join(sandbox.sessionDir, 'index.json'), '{}');
  const cleanup = cleanupDisposableState(sandbox);
  assert.equal(cleanup.removed, true);
  assert.ok(cleanup.removed_files >= 1);
  assert.deepEqual(readJson(join(sandbox.sessionDir, 'owned.jsonl')), { fixture: true });
  assert.deepEqual(readdirSync(sandbox.sessionDir), ['owned.jsonl']);
});

test('real main uses the configured read-only key rather than a stale inherited key', t => {
  const directory = mkdtempSync(join(fixtures, 'main-key-'));
  const authPath = join(directory, 'auth.json');
  const previousQaKey = process.env.ORACLE_QA_MAIN_KEY;
  const previousKey = process.env.OLLAMA_API_KEY;
  t.after(() => {
    if (previousQaKey === undefined) delete process.env.ORACLE_QA_MAIN_KEY;
    else process.env.ORACLE_QA_MAIN_KEY = previousQaKey;
    if (previousKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousKey;
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(authPath, '{"ollama":{"type":"api_key","key":"configured-fixture-key"}}');
  process.env.ORACLE_QA_MAIN_KEY = mainKey(directory);
  process.env.OLLAMA_API_KEY = 'stale-fixture-key';
  let registration;
  cheapMain({ registerProvider: (name, config) => { registration = { name, config }; } });
  assert.equal(registration.name, 'ollama');
  assert.equal(registration.config.apiKey, 'configured-fixture-key');
  assert.equal(readJson(authPath).ollama.key, 'configured-fixture-key');
});
