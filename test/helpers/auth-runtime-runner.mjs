import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { allowedNodeEnvironmentKey } from '../../qa/node-spawn.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
const directory = mkdtempSync(join(tmpdir(), 'oracle-auth-runtime-'));
const agent = join(directory, 'source');
mkdirSync(agent);
const auth = {
  ollama: { type: 'api_key', key: 'qa-runtime-fixture-main' },
  external: { type: 'oauth', access: 'qa-runtime-fixture-external', expires: 1000 },
};
const save = (target = agent) => writeFileSync(join(target, 'auth.json'), JSON.stringify(auth));
save();
writeFileSync(join(agent, 'credential-pool-state.json'), JSON.stringify({
  providers: { ollama: { lanes: {} }, external: { lanes: {} } },
}));
writeFileSync(join(directory, 'omo.jsonc'), '{"fixture":true}\n');
writeFileSync(join(directory, 'native-profile-selection.json'), '{"profile":"fixture-profile"}');
process.env.ORACLE_QA_AUTH_GUARD = 'scoped';
process.env.ORACLE_QA_LIVE_AGENT = agent;
process.env.ORACLE_QA_LIVE_AUTH_FILE = join(agent, 'auth.json');
process.env.OMO_STABLE_AGENT = agent;
process.env.SENPI_CODING_AGENT_DIR = agent;
process.env.OMO_CODING_AGENT_DIR = agent;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.RUNTIME_DIRECT_ALIAS = agent;
process.env.RUNTIME_NESTED_ALIAS = JSON.stringify({ prefix: `before:${agent}/after` });
process.env[`runtime:${agent}`] = 'fixture-metadata';
process.env.PATH = [agent, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':');
delete process.env.ORACLE_QA_GUARD_IPC;
const normalize = value => value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
const contains = value => normalize(value).includes(normalize(agent));
const carriers = environment => Object.entries(environment)
  .filter(([key, value]) => contains(key) || contains(value));
const inheritedEnvironment = { ...process.env };
const inheritedPathKey = Object.keys(inheritedEnvironment).find(key => key.toUpperCase() === 'PATH');
const expectedSearch = inheritedEnvironment[inheritedPathKey].split(process.platform === 'win32' ? ';' : ':')
  .filter(path => !contains(path)).join(process.platform === 'win32' ? ';' : ':');
const initialCarriers = carriers(process.env).length;
let child;
let sandbox;
let summary;
try {
  let moduleRoot = ROOT;
  if (mode === 'repro') {
    moduleRoot = join(directory, 'copy');
    cpSync(ROOT, moduleRoot, { recursive: true, filter: path =>
      !['.git', '.omo', 'dist'].includes(basename(path)) && !basename(path).startsWith('.dist-stage-') });
  }
  const guard = await import(pathToFileURL(join(moduleRoot, 'qa/auth-guard.mjs')).href);
  assert.ok(initialCarriers > 0);
  assert.equal(carriers(process.env).length, 0);
  assert.equal(process.env['ORACLE_QA_' + 'LIVE_AGENT'], undefined);
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (!contains(key) && !contains(value)) assert.equal(process.env[key] === value, true);
  }

  if (mode === 'environment') {
    const before = guard.authHashes();
    process.env.ORACLE_QA_LIVE_AGENT = join(directory, 'different-source');
    assert.deepEqual(guard.authHashes(), before);
    delete process.env.ORACLE_QA_LIVE_AGENT;
    summary = { mode, environment_carriers: carriers(process.env).length,
      initial_carriers: initialCarriers, locator_read_once: true, lookup_undefined: true };
  } else if (mode === 'repro') {
    const before = readFileSync(join(agent, 'auth.json'), 'utf8');
    const variants = [
      ['concat', "'ORACLE_QA_' + 'LIVE_AGENT'", "'auth' + '.json'"],
      ['template', "`${'ORACLE_QA_'}${'LIVE_AGENT'}`", "`${'auth'}.${'json'}`"],
      ['array-join', "['ORACLE', 'QA', 'LIVE', 'AGENT'].join('_')", "['auth', 'json'].join('.')"],
      ['buffer', "Buffer.from('T1JBQ0xFX1FBX0xJVkVfQUdFTlQ=', 'base64').toString()",
        "Buffer.from('YXV0aC5qc29u', 'base64').toString()"],
    ];
    const results = [];
    for (const [name, locator, file] of variants) {
      const path = join(moduleRoot, 'qa', `runtime-repro-${name}.mjs`);
      writeFileSync(path, [
        "import { writeJson } from './safety-state.mjs';",
        "import { join } from 'node:path';",
        `const name = ${locator};`,
        'export const lookup = () => process.env[name];',
        `export const attempt = () => writeJson(join(process.env[name], ${file}), { fixture: true });`,
      ].join('\n'));
      const injected = await import(pathToFileURL(path).href);
      assert.equal(injected.lookup(), undefined);
      // Execute the retained writer expression: path construction fails before
      // writeJson can run because the computed lookup no longer has a value.
      assert.throws(injected.attempt, { code: 'ERR_INVALID_ARG_TYPE' });
      assert.equal(readFileSync(join(agent, 'auth.json'), 'utf8'), before);
      results.push({ name, lookup_undefined: true, writer_unreachable: true, file_unchanged: true });
    }
    summary = { mode, temp_repo_copy: true, results };
  } else if (mode === 'metadata') {
    const harness = await import(pathToFileURL(join(ROOT, 'qa/harness.mjs')).href);
    const provider = (await import(pathToFileURL(join(ROOT, 'qa/main-provider.mjs')).href)).default;
    assert.equal(guard.authSourceAvailable(), true);
    const snapshot = guard.hostConfiguration({ profile: true });
    assert.deepEqual(snapshot, { config: '{"fixture":true}\n', active_profile: 'fixture-profile' });
    assert.equal(JSON.stringify(snapshot).includes(agent), false);
    const host = { engine: 'fixture-engine', plugin: 'fixture-plugin' };
    for (const [env, options] of [
      [{}, { main: 'real' }],
      [{ ORACLE_QA_REAL_ORACLE: '1' }, { main: 'mock' }],
      [{}, { main: 'mock', realOracle: true }],
    ]) {
      const owned = { env: { ...env, ORACLE_QA_ROUTE_POLICY: 'real-authorized' }, sessionDir: join(directory, 'sessions') };
      const argv = harness.hostArgs(host, owned, 'fixture-candidate', options);
      assert.equal(owned.env.ORACLE_QA_MAIN_KEY === auth.ollama.key, true);
      assert.equal(argv.includes(auth.ollama.key), false);
      process.env.ORACLE_QA_MAIN_KEY = owned.env.ORACLE_QA_MAIN_KEY;
      let registration;
      provider({ registerProvider: (name, config) => { registration = { name, config }; } });
      assert.equal(registration.name, 'ollama');
      assert.equal(registration.config.apiKey === auth.ollama.key, true);
    }
    rmSync(agent, { recursive: true });
    const mock = { env: { ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1' }, sessionDir: join(directory, 'sessions') };
    harness.hostArgs(host, mock, 'fixture-candidate', { main: 'mock' });
    assert.deepEqual(mock.env, {
      ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1', ORACLE_QA_ROUTE_ADMISSION: 'mock-only-v1',
      ORACLE_QA_HOST_ENGINE: resolve(host.engine),
    });
    summary = { mode, key_handoff_routes: 3, no_key_in_argv: true,
      configuration_values_only: true, fully_mock_source_read: false };
  } else if (mode === 'bridge') {
    const harness = await import(pathToFileURL(join(ROOT, 'qa/harness.mjs')).href);
    const attempt = join(directory, 'attempt');
    const run = join(directory, 'run');
    sandbox = harness.disposableEnvironment({}, run, {
      ORACLE_QA_ATTEMPT: 'runtime-fixture', ORACLE_QA_ATTEMPT_DIR: attempt,
    });
    const environment = {
      ...sandbox.env, ORACLE_QA_GUARD_IPC: '1', ORACLE_QA_LIVE_AGENT: agent,
      LATE_DIRECT_ALIAS: agent, LATE_NESTED_ALIAS: JSON.stringify({ path: `${agent}/nested` }),
      [`late:${agent}`]: 'fixture-metadata',
    };
    let passedEnvironment;
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, argv, options) => {
      passedEnvironment = options.env;
      return originalSpawn(command, argv, options);
    };
    syncBuiltinESMExports();
    try {
      child = new harness.OwnedProcess(process.execPath,
        [join(ROOT, 'test/helpers/auth-runtime-client.mjs')], {
          cwd: ROOT, env: environment, deadlineMs: 15000,
        });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    assert.equal(passedEnvironment !== undefined, true);
    assert.equal(carriers(passedEnvironment).length, 0);
    assert.equal(passedEnvironment.SENPI_CODING_AGENT_DIR, sandbox.agentDir);
    const passedPathKey = Object.keys(passedEnvironment).find(key => key.toUpperCase() === 'PATH');
    assert.equal(passedPathKey !== undefined, true);
    assert.equal(passedEnvironment[passedPathKey], sandbox.env.PATH);
    assert.equal(passedEnvironment[passedPathKey].includes(agent), false);
    assert.equal(JSON.parse(passedEnvironment.ORACLE_QA_EXECUTABLES).node.validated, true);
    for (const [key, value] of Object.entries(environment)) {
      if (!contains(key) && !contains(value)) {
        assert.equal(passedEnvironment[key], allowedNodeEnvironmentKey(key) ? value : undefined);
      }
    }
    const osNames = process.platform === 'win32'
      ? ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'] : ['PATH'];
    for (const name of osNames) {
      const key = Object.keys(passedEnvironment).find(candidate => candidate.toUpperCase() === name);
      assert.equal(key !== undefined, true);
      if (name !== 'PATH') assert.equal(passedEnvironment[key] === inheritedEnvironment[key], true);
    }
    const baseline = await child.waitFor(event => event.phase === 'baseline', 'parent guard baseline');
    assert.equal(baseline.computed_locator_undefined, true);
    auth.external.access = 'qa-runtime-fixture-external-updated';
    auth.external.expires = 2000;
    save();
    const externalResult = child.waitFor(event => event.phase === 'external', 'external refresh verdict');
    child.child.stdin.write('external\n');
    assert.equal((await externalResult).admitted, 1);
    auth.ollama.key = 'qa-runtime-fixture-rotated';
    const decoded = Buffer.from(Buffer.from(agent).toString('base64'), 'base64').toString();
    save(decoded);
    const guardedResult = child.waitFor(event => event.phase === 'guarded', 'guarded change verdict');
    child.child.stdin.write('guarded\n');
    const stopped = await guardedResult;
    assert.equal(stopped.admitted, 0);
    assert.equal(stopped.code, 'auth_changed');
    assert.equal(harness.readJson(join(attempt, 'real-model-safety.json')).blocked, true);
    assert.throws(() => harness.reserveRealOracleRuns(attempt), { code: 'auth_changed' });
    for (const name of ['real-model-safety.json', 'auth-guard-receipt.json']) {
      assert.equal(readFileSync(join(attempt, name), 'utf8').includes('qa-runtime-fixture-'), false);
    }
    summary = { mode, inspected_actual_spawn_env: true, spawn_env_carriers: 0,
      owned_directory_preserved: true, child_locator_undefined: true,
      safe_search_path_preserved: true,
      os_environment_preserved: osNames, all_other_environment_values_preserved: true,
      external_change_continued: true, buffer_root_guarded_change_blocked: true,
      further_reservation_refused: true, real_model_calls: 0 };
  } else throw new Error('Unknown runtime fixture mode');
} finally {
  if (child) await child.stop();
  if (sandbox) {
    const harness = await import(pathToFileURL(join(ROOT, 'qa/harness.mjs')).href);
    harness.cleanupDisposableState(sandbox);
  }
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({
  ...summary, temporary_state_removed: !existsSync(directory),
  owned_pid_gone: !child || child.metadata.pid_gone,
}));
