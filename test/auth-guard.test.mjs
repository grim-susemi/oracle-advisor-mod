import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  ROOT, admitAuth, finalizeAuthGuard, guardAuth, readJson, reserveRealOracleRuns,
} from '../qa/harness.mjs';
import { authVerdict, mainKey } from '../qa/auth-guard.mjs';
import { assertNodeLaunch, nodeSpawnEnvironment } from '../qa/node-spawn.mjs';

function fixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-auth-guard-'));
  const agent = join(directory, 'fixture-agent');
  mkdirSync(agent);
  const previous = process.env.ORACLE_QA_AUTH_GUARD;
  if (mode === undefined) delete process.env.ORACLE_QA_AUTH_GUARD;
  else process.env.ORACLE_QA_AUTH_GUARD = mode;
  t.after(() => {
    if (previous === undefined) delete process.env.ORACLE_QA_AUTH_GUARD;
    else process.env.ORACLE_QA_AUTH_GUARD = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const auth = {
    ollama: { type: 'api_key', key: 'fixture-main-private' },
    external: { type: 'oauth', access: 'fixture-access-private', refresh: 'fixture-refresh-private', expires: 1000 },
    oracle: { type: 'oauth', access: 'fixture-oracle-private', expires: 1000 },
  };
  const pool = { schemaVersion: 1, installationKey: 'fixture-installation-private',
    providers: { ollama: { lanes: {} }, external: { lanes: {} } } };
  const save = () => {
    writeFileSync(join(agent, 'auth.json'), JSON.stringify(auth));
    writeFileSync(join(agent, 'credential-pool-state.json'), JSON.stringify(pool));
  };
  save();
  const guard = options => guardAuth(directory, agent, options);
  const state = () => readJson(join(directory, 'real-model-safety.json'));
  const receipt = () => readJson(join(directory, 'auth-guard-receipt.json'));
  return { directory, agent, auth, pool, save, guard, state, receipt };
}

test('strict default blocks an unrelated refresh and keeps its original baseline', t => {
  const f = fixture(t);
  const baseline = f.guard({ before: true });
  f.auth.external.access = 'fixture-refreshed-private';
  f.auth.external.expires = 2000;
  f.save();
  assert.throws(() => f.guard(), { code: 'auth_changed' });
  assert.deepEqual(f.state().auth_baseline, baseline);
  assert.equal(f.state().blocked, true);
  process.env.ORACLE_QA_AUTH_GUARD = 'scoped';
  assert.throws(() => f.guard({ before: true }), { code: 'auth_changed' });
  assert.throws(() => f.guard(), { code: 'auth_changed' });
  assert.throws(() => reserveRealOracleRuns(f.directory), { code: 'auth_changed' });
  assert.deepEqual(f.state().auth_baseline, baseline);
  assert.equal(f.state().auth_scoped_baseline, undefined);
});

for (const recordedMode of [undefined, 'strict']) {
  test(`scoped admission ignores a historical ${recordedMode ?? 'legacy strict'} block without rewriting it`, t => {
    const f = fixture(t);
    const prior = join(f.directory, 'attempts', 'a1');
    guardAuth(prior, f.agent, { before: true });
    f.auth.external.access = 'fixture-refreshed-private';
    f.save();
    assert.throws(() => guardAuth(prior, f.agent), { code: 'auth_changed' });
    if (recordedMode === undefined) {
      const state = readJson(join(prior, 'real-model-safety.json'));
      delete state.auth_guard_mode;
      writeFileSync(join(prior, 'real-model-safety.json'), JSON.stringify(state));
    }
    const historical = ['real-model-safety.json', 'auth-guard-receipt.json']
      .map(name => readFileSync(join(prior, name), 'utf8'));
    process.env.ORACLE_QA_AUTH_GUARD = 'scoped';
    const current = join(f.directory, 'attempts', 'fresh');
    admitAuth(current, f.agent);
    assert.equal(readJson(join(current, 'real-model-safety.json')).blocked, false);
    assert.equal(readJson(join(current, 'real-model-safety.json')).auth_guard_mode, 'scoped');
    assert.deepEqual(['real-model-safety.json', 'auth-guard-receipt.json']
      .map(name => readFileSync(join(prior, name), 'utf8')), historical);
    assert.throws(() => admitAuth(prior, f.agent), { code: 'auth_changed' });
  });
}

for (const source of ['auth', 'pool']) {
  test(`scoped admission refuses an earlier scoped guarded ${source} block even for a different guarded set`, t => {
    const f = fixture(t, 'scoped');
    const prior = join(f.directory, 'attempts', 'earlier');
    guardAuth(prior, f.agent, { before: true });
    if (source === 'auth') f.auth.ollama.key = 'fixture-rotated-private';
    else f.pool.providers.ollama.lanes.stored = { slots: {} };
    f.save();
    assert.throws(() => guardAuth(prior, f.agent), { code: 'auth_changed' });
    const historical = readFileSync(join(prior, 'real-model-safety.json'), 'utf8');
    const current = join(f.directory, 'attempts', 'fresh');
    const receipt = {};
    assert.throws(() => admitAuth(current, f.agent, { providers: [], real: false, receipt }),
      { code: 'auth_changed' });
    assert.equal(receipt.blocking_auth_attempt, prior);
    assert.equal(existsSync(join(current, 'real-model-safety.json')), false);
    assert.equal(readFileSync(join(prior, 'real-model-safety.json'), 'utf8'), historical);
    assert.throws(() => admitAuth(prior, f.agent), { code: 'auth_changed' });
  });
}

for (const mode of [undefined, 'scope']) {
  for (const priorMode of [undefined, 'scoped']) {
    test(`${mode ?? 'default'} strict admission retains the cross-attempt latch for ${priorMode ?? 'strict'} blocks`, t => {
      const f = fixture(t, priorMode);
      const prior = join(f.directory, 'attempts', 'earlier');
      guardAuth(prior, f.agent, { before: true });
      f.auth.ollama.key = 'fixture-rotated-private';
      f.save();
      assert.throws(() => guardAuth(prior, f.agent), { code: 'auth_changed' });
      const historical = readFileSync(join(prior, 'real-model-safety.json'), 'utf8');
      if (mode === undefined) delete process.env.ORACLE_QA_AUTH_GUARD;
      else process.env.ORACLE_QA_AUTH_GUARD = mode;
      const current = join(f.directory, 'attempts', 'fresh');
      assert.throws(() => admitAuth(current, f.agent), { code: 'auth_changed' });
      assert.equal(existsSync(join(current, 'real-model-safety.json')), false);
      assert.equal(readFileSync(join(prior, 'real-model-safety.json'), 'utf8'), historical);
    });
  }
}

test('scoped historical admission requires a changed guarded entry, while a current parse block still refuses', t => {
  const f = fixture(t, 'scoped');
  const prior = join(f.directory, 'attempts', 'earlier');
  guardAuth(prior, f.agent, { before: true });
  writeFileSync(join(f.agent, 'auth.json'), 'fixture-malformed-private');
  assert.throws(() => guardAuth(prior, f.agent), { code: 'auth_changed' });
  f.save();
  admitAuth(join(f.directory, 'attempts', 'fresh'), f.agent);
  assert.throws(() => admitAuth(prior, f.agent), { code: 'auth_changed' });
});

test('scoped guard permits an external auth/pool refresh and records only safe metadata', t => {
  const f = fixture(t, 'scoped');
  f.guard({ before: true });
  const baseline = f.state().auth_scoped_baseline;
  f.auth.external.access = 'fixture-refreshed-private';
  f.auth.external.expires = 2000;
  f.pool.providers.external.lanes.stored = { slots: { slot: { stateVersion: 1 } } };
  f.save();
  f.guard();
  assert.equal(f.state().blocked, false);
  assert.deepEqual(f.state().auth_scoped_baseline, baseline);
  const receipt = f.receipt();
  assert.deepEqual(receipt.guarded_providers, ['ollama']);
  assert.deepEqual(receipt.events, [{
    event: 'concurrent_external_change', providers: ['external'],
    expires_before: { external: [1000] }, expires_after: { external: [2000] },
  }]);
  f.guard();
  assert.equal(f.receipt().events.length, 1);
  for (const name of readdirSync(f.directory).filter(name => name.endsWith('.json'))) {
    const serialized = readFileSync(join(f.directory, name), 'utf8');
    assert.doesNotMatch(serialized, /fixture-[a-z-]*private/);
    assert.doesNotMatch(serialized, /"(access|refresh|key|installationKey)"\s*:/);
  }
});

for (const source of ['auth', 'pool']) {
  test(`scoped guard blocks a guarded ${source} entry and persists the block`, t => {
    const f = fixture(t, 'scoped');
    f.guard({ before: true });
    const baseline = f.state().auth_scoped_baseline;
    if (source === 'auth') f.auth.ollama.key = 'fixture-rotated-private';
    else f.pool.providers.ollama.lanes.stored = { slots: {} };
    f.save();
    assert.throws(() => f.guard(), { code: 'auth_changed' });
    assert.equal(f.state().blocked, true);
    assert.deepEqual(f.state().auth_scoped_baseline, baseline);
    assert.throws(() => reserveRealOracleRuns(f.directory), { code: 'auth_changed' });
    assert.doesNotMatch(JSON.stringify(f.receipt()), /fixture-[a-z-]*private/);
  });
}

test('scoped guard includes a distinct real oracle provider supplied by the case', t => {
  const f = fixture(t, 'scoped');
  const providers = ['ollama', 'oracle'];
  f.guard({ before: true, providers });
  assert.deepEqual(f.receipt().guarded_providers, providers);
  f.auth.oracle.access = 'fixture-rotated-oracle-private';
  f.save();
  assert.throws(() => f.guard({ providers }), { code: 'auth_changed' });
});

test('scoped baseline cannot be narrowed or reset by another before check', t => {
  const f = fixture(t, 'scoped');
  f.guard({ before: true, providers: ['ollama', 'oracle'] });
  assert.throws(() => f.guard({ before: true, providers: ['ollama'] }), { code: 'auth_changed' });
});

for (const mode of [undefined, 'scoped']) {
  for (const name of ['auth.json', 'credential-pool-state.json']) {
    test(`${mode ?? 'strict'} guard blocks an initial parse failure in ${name} without leaking parser text`, t => {
      const f = fixture(t, mode);
      writeFileSync(join(f.agent, name), '{"access":"fixture-malformed-private"');
      assert.throws(() => f.guard({ before: true }), error =>
        error.code === 'auth_changed' && !error.message.includes('fixture-malformed-private'));
      assert.equal(f.state().blocked, true);
      assert.equal(f.receipt().reason, 'auth_parse_failed');
      assert.throws(() => reserveRealOracleRuns(f.directory), { code: 'auth_changed' });
      assert.doesNotMatch(JSON.stringify(f.state()), /fixture-malformed-private/);
    });
  }
}

test('scoped comparison ignores JSON formatting and object-key order but detects removal', t => {
  const f = fixture(t, 'scoped');
  f.guard();
  f.auth.ollama = { key: f.auth.ollama.key, type: 'api_key' };
  writeFileSync(join(f.agent, 'auth.json'), JSON.stringify(f.auth, null, 2));
  f.guard();
  delete f.auth.ollama;
  f.save();
  assert.throws(() => f.guard(), { code: 'auth_changed' });
});

test('scoped guard leaves missing files absent and blocks a newly added guarded entry', t => {
  const f = fixture(t, 'scoped');
  rmSync(join(f.agent, 'auth.json'));
  rmSync(join(f.agent, 'credential-pool-state.json'));
  assert.deepEqual(f.guard(), { 'auth.json': null, 'credential-pool-state.json': null });
  assert.deepEqual(readdirSync(f.agent), []);
  f.save();
  assert.throws(() => f.guard(), { code: 'auth_changed' });
});

test('scoped guard records additions and removals of external providers without widening its scope', t => {
  const f = fixture(t, 'scoped');
  f.guard({ providers: [] });
  delete f.auth.external;
  delete f.pool.providers.external;
  f.auth.added = { type: 'oauth', accounts: [{ access: 'fixture-nested-private', expires: 3000 }] };
  f.save();
  f.guard({ providers: [] });
  assert.deepEqual(f.receipt().guarded_providers, []);
  assert.deepEqual(f.receipt().events[0].providers, ['added', 'external']);
  assert.deepEqual(f.receipt().events[0].expires_after, { added: [3000], external: [] });
  assert.doesNotMatch(JSON.stringify(f.state()), /fixture-nested-private/);
});

for (const mode of [undefined, 'scoped']) {
  test(`${mode ?? 'strict'} guard retains its block after malformed JSON is repaired`, t => {
    const f = fixture(t, mode);
    f.guard();
    writeFileSync(join(f.agent, 'auth.json'), 'not-json fixture-malformed-private');
    assert.throws(() => f.guard(), { code: 'auth_changed' });
    f.save();
    assert.throws(() => f.guard({ before: true }), { code: 'auth_changed' });
  });
}

const staticSourceRoot = join(tmpdir(), 'oracle-static-source-fixture');
function inspectStaticContainment(root) {
  // The unchanged static scanner uses known fixture metadata. The actual
  // runtime source has already been erased from the environment.
  const previous = process.env.ORACLE_QA_LIVE_AGENT;
  process.env.ORACLE_QA_LIVE_AGENT = staticSourceRoot;
  try { return containmentFindings(root); }
  finally {
    if (previous === undefined) delete process.env.ORACLE_QA_LIVE_AGENT;
    else process.env.ORACLE_QA_LIVE_AGENT = previous;
  }
}

function containmentFindings(root) {
  const findings = [];
  const normalize = value => value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
  const resolvedRoot = normalize(process.env.ORACLE_QA_LIVE_AGENT);
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const source = readFileSync(path, 'utf8');
        const file = relative(root, path).replace(/\\/g, '/');
        const add = rule => findings.push({ file, rule });
        if (file === 'qa/auth-guard.mjs') {
          // No namespace, default, local, dynamic or re-exported imports: this
          // module cannot acquire a writer, including the project's writeJson.
          const allowedImports = {
            'node:fs': ['existsSync', 'readFileSync'],
            'node:crypto': ['createHash'],
            'node:path': ['dirname', 'join'],
          };
          const imports = [...source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;/g)];
          for (const [, bindings, , module] of imports) {
            if (!/^\{[\w\s,]+\}$/.test(bindings) || !allowedImports[module] ||
                bindings.slice(1, -1).split(',').map(name => name.trim()).filter(Boolean)
                  .some(name => !allowedImports[module].includes(name))) add('guard_import_capability');
          }
          const remainder = source.replace(/\bimport\s+[\s\S]*?\s+from\s*(['"])[^'"]+\1\s*;/g, '');
          if (/\b(?:import|require|eval|Function|AuthStorage|writeJson|getBuiltinModule|createRequire)\b/.test(remainder)) add('guard_dynamic_capability');
          for (const match of source.matchAll(/\bexport\s+function\s+(\w+)/g)) {
            if (!['authHashes', 'authObservation', 'authVerdict', 'mainKey', 'authSourceAvailable', 'hostConfiguration'].includes(match[1])) add('guard_path_export');
          }
          if (/\bexport\s+(?!function\b)/.test(source)) add('guard_indirect_export');
        } else {
          if (normalize(source).includes(resolvedRoot)) add('resolved_credential_root');
          // The credential root, not just its filenames, is private. A writer
          // cannot construct any child path by concatenation, templates or join.
          for (const token of ['auth.json', 'credential-pool-state.json', 'ORACLE_QA_LIVE_AUTH_FILE',
            'ORACLE_QA_LIVE_AGENT', 'OMO_STABLE_AGENT', 'liveAgentDir', 'credentialRoot',
            'home/.omo/agent', 'home\\\\.omo\\\\agent', 'liveAuthPath', 'credentialPoolStatePath']) {
            if (source.includes(token)) add(`credential_token:${token}`);
          }
          for (const match of source.matchAll(/\b(?:import|export)\s+([^;]*?)\s+from\s*(['"])([^'"]*auth-guard\.mjs)\2/g)) {
            const bindings = match[1];
            if (!/^\{[\w\s,]+\}$/.test(bindings) ||
                bindings.slice(1, -1).split(',').map(name => name.trim()).filter(Boolean)
                  .some(name => !['authHashes', 'authObservation', 'authVerdict', 'mainKey', 'authSourceAvailable', 'hostConfiguration'].includes(name))) add('guard_path_import');
          }
          if (/\bimport\s*\([^)]*auth-guard\.mjs/.test(source) ||
              /\brequire\s*\([^)]*auth-guard\.mjs/.test(source)) add('guard_dynamic_import');
        }
      }
    }
  }
  for (const tree of ['src', 'qa', 'scripts']) walk(join(root, tree));
  return findings;
}

test('credential containment: only the read-only guard knows credential paths', () => {
  assert.deepEqual(inspectStaticContainment(ROOT), []);
});

const containmentInjections = [
  ['writeJson', "import { writeJson } from './safety-state.mjs';\nwriteJson(process.env.ORACLE_QA_LIVE_AUTH_FILE, { fixture: true });\n"],
  ['aliased-writeFileSync', "import { writeFileSync as persist } from 'node:fs';\npersist(process.env.ORACLE_QA_LIVE_AUTH_FILE, 'fixture');\n"],
  ['destructured-writeFile', "import fs from 'node:fs';\nconst { writeFile } = fs;\nwriteFile(process.env.ORACLE_QA_LIVE_AUTH_FILE, 'fixture', () => {});\n"],
  ['promises-writeFile', "import fs from 'node:fs';\nfs.promises.writeFile(process.env.ORACLE_QA_LIVE_AUTH_FILE, 'fixture');\n"],
  ['createWriteStream', "import { createWriteStream } from 'node:fs';\ncreateWriteStream(process.env.ORACLE_QA_LIVE_AUTH_FILE);\n"],
  ['second-path-import', "import { liveAuthPath } from './auth-guard.mjs';\nvoid liveAuthPath;\n"],
  ['concat-filename', "import { writeJson } from './safety-state.mjs';\nimport { join } from 'node:path';\nconst file = 'auth' + '.json';\nwriteJson(join(process.env.ORACLE_QA_LIVE_AGENT, file), { fixture: true });\n"],
  ['template-filename', "import { writeJson } from './safety-state.mjs';\nimport { join } from 'node:path';\nconst file = `${'auth'}.${'json'}`;\nwriteJson(join(process.env.ORACLE_QA_LIVE_AGENT, file), { fixture: true });\n"],
  ['array-join-filename', "import { writeJson } from './safety-state.mjs';\nimport { join } from 'node:path';\nconst file = ['auth', 'json'].join('.');\nwriteJson(join(process.env.ORACLE_QA_LIVE_AGENT, file), { fixture: true });\n"],
  ['resolved-root', "import { writeJson } from './safety-state.mjs';\nimport { join } from 'node:path';\nwriteJson(join('C:/Users/USER/.omo-stable-500/home/.omo/agent', ['auth', 'json'].join('.')), { fixture: true });\n"],
  ['resolved-current-root', `import { writeJson } from './safety-state.mjs';\nimport { join } from 'node:path';\nwriteJson(join(${JSON.stringify(staticSourceRoot)}, ['auth', 'json'].join('.')), { fixture: true });\n`],
  ['root-helper-import', "import { credentialRoot } from './auth-guard.mjs';\nvoid credentialRoot;\n"],
  ['root-access-only', "void process.env.ORACLE_QA_LIVE_AGENT;\n"],
  ['host-root-helper', "import { discoverHost } from './harness.mjs';\nconst source = discoverHost().liveAgentDir;\nvoid source;\n"],
];

test('each injected repo copy fails the actual containment test without executing its module', t => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-containment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const results = [];
  for (const [name, injection] of containmentInjections) {
    const copy = join(directory, name);
    cpSync(ROOT, copy, { recursive: true, filter: path =>
      !['.git', '.omo', 'dist'].includes(basename(path)) && !basename(path).startsWith('.dist-stage-') });
    assert.deepEqual(inspectStaticContainment(copy), [], `${name}: copied baseline`);
    writeFileSync(join(copy, 'qa/injected-credential.mjs'), injection);
    const args = ['--test', '--test-isolation=none',
      '--test-name-pattern=^credential containment:', 'test/auth-guard.test.mjs'];
    const env = nodeSpawnEnvironment(process.env);
    assertNodeLaunch(process.execPath, args, env, { nodeProfile: 'containment', cwd: copy });
    const result = spawnSync(process.execPath, args, {
      cwd: copy, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 1, `${name}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /injected-credential\.mjs/);
    results.push({ injection: name, baseline_findings: 0, containment_exit_code: result.status,
      findings: inspectStaticContainment(copy), injected_module_executed: false });
  }
  for (const result of results) console.log(`CONTAINMENT_INJECTION ${JSON.stringify(result)}`);
});

test('the guard cannot import writers even without a credential literal at the injection site', t => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-guard-capability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const tree of ['src', 'qa', 'scripts']) mkdirSync(join(directory, tree));
  const source = readFileSync(join(ROOT, 'qa/auth-guard.mjs'), 'utf8');
  for (const injection of [
    "import { writeJson } from './safety-state.mjs';",
    "import { writeFileSync as persist } from 'node:fs';",
    "import fs from 'node:fs'; const { writeFile } = fs;",
    "import * as fs from 'node:fs'; fs.promises.writeFile(target, value);",
    "import { createWriteStream } from 'node:fs';",
    "const fs = process.getBuiltinModule('fs');",
  ]) {
    writeFileSync(join(directory, 'qa/auth-guard.mjs'), source + '\n' + injection);
    assert.ok(inspectStaticContainment(directory).length > 0, injection);
  }
});

for (const mode of [undefined, 'scoped']) {
  test(`${mode ?? 'strict'} case finalization follows the central guard after an external refresh`, async t => {
    const f = fixture(t, mode);
    f.guard({ before: true });
    f.auth.external.access = 'fixture-refreshed-private';
    f.auth.external.expires = 2000;
    f.save();
    const receipt = { status: 'passed', exit_code: 0, all_owned_pids_gone: true };
    finalizeAuthGuard(receipt, f.directory, f.agent);
    assert.equal(receipt.exit_code, mode === 'scoped' ? 0 : 1);
    assert.equal(receipt.auth_guard_passed, mode === 'scoped');
    assert.equal(receipt.status, mode === 'scoped' ? 'passed' : 'auth_changed');
    if (mode === 'scoped') assert.deepEqual(f.receipt().events[0].providers, ['external']);
  });
}

test('the cached source supplies key-only host registration and path-free configuration values', () => {
  const result = runtimeFixture('metadata');
  assert.equal(result.key_handoff_routes, 3);
  assert.equal(result.no_key_in_argv, true);
  assert.equal(result.configuration_values_only, true);
  assert.equal(result.fully_mock_source_read, false);
});

test('the key API retains reference resolution and rejects command keys and malformed JSON safely', t => {
  const f = fixture(t, 'scoped');
  f.auth.ollama = { type: 'api_key', key: '${FIXTURE_KEY}', env: { FIXTURE_KEY: 'fixture-reference-private' } };
  f.save();
  assert.equal(mainKey(f.agent), 'fixture-reference-private');
  f.auth.ollama.key = '!must-not-execute';
  f.save();
  assert.throws(() => mainKey(f.agent), /command-valued keys are not executed/);
  writeFileSync(join(f.agent, 'auth.json'), '{"key":"fixture-malformed-private"');
  assert.throws(() => mainKey(f.agent), error => error.message.startsWith('missing_main_credential:') &&
    !error.message.includes('fixture-malformed-private'));
});

function runtimeFixture(mode) {
  const args = [join(ROOT, 'test/helpers/auth-runtime-runner.mjs'), mode];
  const env = nodeSpawnEnvironment(authVerdict(undefined, undefined, { environment: process.env }).environment);
  assertNodeLaunch(process.execPath, args, env);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 30000,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.temporary_state_removed, true);
  console.log(`RUNTIME_AUTH ${JSON.stringify(observation)}`);
  return observation;
}

test('runtime guard deletes every environment key or value carrying the captured source', () => {
  const result = runtimeFixture('environment');
  assert.equal(result.environment_carriers, 0);
  assert.equal(result.locator_read_once, true);
});

test('runtime-built locator repros on a temp copy cannot reach a credential writer', () => {
  const result = runtimeFixture('repro');
  assert.equal(result.temp_repo_copy, true);
  assert.equal(result.results.length, 4);
  assert.ok(result.results.every(row => row.lookup_undefined && row.writer_unreachable && row.file_unchanged));
});

test('the actual owned spawn environment is source-free and parent hash verdicts still gate dispatch', () => {
  const result = runtimeFixture('bridge');
  assert.equal(result.inspected_actual_spawn_env, true);
  assert.equal(result.spawn_env_carriers, 0);
  assert.equal(result.external_change_continued, true);
  assert.equal(result.buffer_root_guarded_change_blocked, true);
  assert.equal(result.further_reservation_refused, true);
  assert.equal(result.all_other_environment_values_preserved, true);
  for (const name of process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'] : ['PATH']) {
    assert.equal(result.os_environment_preserved.includes(name), true);
  }
});
