import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedProcess, ROOT, disposableEnvironment, hostArgs } from '../qa/harness.mjs';
import { assertHostRoute } from '../qa/route-guard.mjs';
import { isNodeExecutable, nodeSpawnEnvironment, validatedExecutable } from '../qa/node-spawn.mjs';
import { validateFixtureExecutable } from '../qa/fixture-executable.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'oracle-node-admission-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function observeSpawn(run) {
  const original = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    throw Object.assign(new Error('Spawn boundary reached'), { code: 'spawn_boundary_reached' });
  };
  syncBuiltinESMExports();
  try { run(calls); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

test('every unknown Node prefix is refused before child_process.spawn for ordinary fixtures', t => {
  const cwd = directory(t);
  const envFile = join(cwd, 'preload.env');
  const config = join(cwd, 'explicit-config.json');
  writeFileSync(envFile, 'NODE_OPTIONS=--import=data:text/javascript,throw%20new%20Error("UNAPPROVED_PRELOAD")\n');
  writeFileSync(config, JSON.stringify({ nodeOptions: { import: ['data:text/javascript,throw new Error("UNAPPROVED_CONFIG")'] } }));
  const script = join(ROOT, 'qa/owned-process-fixture.mjs');
  const prefixes = [
    [`--env-file=${envFile}`], [`--env-file-if-exists=${envFile}`], ['--env-file', envFile],
    [`--experimental-config-file=${config}`], ['--experimental-config-file', config],
    ['--env-file-if-exists', envFile], [`--env-f=${envFile}`],
    ['--experimental-default-config-file'], ['--trace-warnings'], ['-e', 'process.exit(1)'],
    ['--unknown-future-option=payload'], ['--'],
  ];
  observeSpawn(calls => {
    for (const prefix of prefixes) for (const before of [[], ['--no-warnings']]) {
      assert.throws(() => new OwnedProcess(process.execPath, [...before, ...prefix, script, 'misleading-success'], {
        cwd, env: { SystemRoot: process.env.SystemRoot },
      }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, 0, 'No child may be created, even if a preload would only throw.');
    }
  });
});

test('owned Node environment contains only allowed carriers and no inherited NODE variables', t => {
  const cwd = directory(t);
  observeSpawn(calls => {
    assert.throws(() => new OwnedProcess(process.execPath, [join(ROOT, 'qa/owned-process-fixture.mjs'), 'misleading-success'], {
      cwd, env: {
        SystemRoot: process.env.SystemRoot, PATH: '',
        NODE_OPTIONS: '--import=unapproved.mjs', Node_Path: cwd, NODE_EXTRA_CA_CERTS: 'unapproved.pem',
        NODE_REPL_EXTERNAL_MODULE: 'unapproved.mjs', NODE_FUTURE_LOADER: 'unapproved.mjs',
        UNAPPROVED_ENVIRONMENT: 'must not cross', ORACLE_QA_NONCE: 'preserved-fixture-value',
      },
    }), { code: 'spawn_boundary_reached' });
    assert.equal(calls.length, 1);
    const environment = calls[0].options.env;
    assert.deepEqual(Object.keys(environment).filter(key => key.toUpperCase().startsWith('NODE_')), []);
    assert.equal(environment.UNAPPROVED_ENVIRONMENT, undefined);
    assert.equal(environment.ORACLE_QA_NONCE, 'preserved-fixture-value');
    assert.equal(environment.SystemRoot, process.env.SystemRoot);
  });
});

test('default config discovery cannot be enabled by an unapproved Node option before spawn', t => {
  const cwd = directory(t);
  writeFileSync(join(cwd, 'node.config.json'), JSON.stringify({
    nodeOptions: { import: ['data:text/javascript,throw new Error("UNAPPROVED_DEFAULT_CONFIG")'] },
  }));
  observeSpawn(calls => {
    assert.throws(() => new OwnedProcess(process.execPath,
      ['--experimental-default-config-file', join(ROOT, 'qa/owned-process-fixture.mjs'), 'misleading-success'], {
        cwd, env: { SystemRoot: process.env.SystemRoot },
      }), { code: 'unsafe_qa_route' });
    assert.equal(calls.length, 0);
  });
});

test('approved Node purposes still refuse every extra or abbreviated prefix before spawning', t => {
  const cwd = directory(t);
  const script = join(ROOT, 'qa/owned-process-fixture.mjs');
  const checkPrefix = ['--test', '--test-isolation=none', '--test-reporter=./qa/verdict-test-reporter.mjs'];
  const entries = [
    ['version', ['--version', '--env-file=unapproved.env']],
    ['version', ['-v']],
    ['test', ['--test', '--env-file', 'unapproved.env', script]],
    ['test', ['--tes', script]],
    ['check', [...checkPrefix, '--experimental-config-file=unapproved.json', script]],
    ['check', ['--test', '--test-isolation', 'none', script]],
    ['exit', ['-e', 'process.exit(1)', '--env-file-if-exists=unapproved.env']],
    ['exit', ['--eval=process.exit(1)']],
  ];
  observeSpawn(calls => {
    for (const [nodeProfile, args] of entries) {
      assert.throws(() => new OwnedProcess(process.execPath, args, {
        cwd, env: { SystemRoot: process.env.SystemRoot }, nodeProfile,
      }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, 0);
    }
    assert.throws(() => new OwnedProcess(process.execPath, [script, 'misleading-success'], {
      cwd, env: { SystemRoot: process.env.SystemRoot },
    }), { code: 'spawn_boundary_reached' });
    assert.equal(calls.length, 1);
  });
});

test('full fixture and admitted host argv refuse every trailing loader before spawning', t => {
  const cwd = directory(t);
  const envFile = join(cwd, 'preload.env');
  const config = join(cwd, 'explicit-config.json');
  writeFileSync(envFile, 'NODE_OPTIONS=--import=data:text/javascript,throw%20new%20Error("TRAILING_PRELOAD")\n');
  writeFileSync(config, JSON.stringify({ nodeOptions: { import: ['data:text/javascript,throw new Error("TRAILING_CONFIG")'] } }));
  writeFileSync(join(cwd, 'node.config.json'), JSON.stringify({
    nodeOptions: { import: ['data:text/javascript,throw new Error("TRAILING_DEFAULT")'] },
  }));
  const sandbox = disposableEnvironment({}, cwd, { ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1' });
  t.after(() => rmSync(sandbox.stateDir, { recursive: true, force: true }));
  const host = { engine: join(cwd, 'never-start.mjs'), plugin: join(cwd, 'plugin') };
  const admitted = hostArgs(host, sandbox, join(cwd, 'candidate.mjs'), { main: 'mock' });
  assert.equal(assertHostRoute(admitted, sandbox.env, sandbox.workDir).policy, 'mock-only');
  const vectors = [
    [join(ROOT, 'qa/owned-process-fixture.mjs'), 'misleading-success'],
    admitted,
  ];
  const loaders = [
    [`--env-file=${envFile}`], ['--env-file', envFile],
    [`--env-file-if-exists=${envFile}`], ['--env-file-if-exists', envFile],
    [`--experimental-config-file=${config}`], ['--experimental-config-file', config],
    ['--experimental-default-config-file'],
  ];
  observeSpawn(calls => {
    for (const args of vectors) for (const loader of loaders) {
      for (const boundary of [[], ['--']]) {
        for (const position of [1, args.length]) {
          const changed = [...args.slice(0, position), ...boundary, ...loader, ...args.slice(position)];
          assert.throws(() => new OwnedProcess(process.execPath, changed, {
            cwd: sandbox.workDir, env: sandbox.env,
          }), { code: 'unsafe_qa_route' });
          assert.equal(calls.length, 0, 'Refusal must precede the actual spawn boundary and any child PID.');
        }
      }
    }
    for (const args of vectors) {
      for (const extra of ['unexpected-operand', '--unknown-future-option', '--env-f=ignored.env']) {
        assert.throws(() => new OwnedProcess(process.execPath, [...args, extra], {
          cwd: sandbox.workDir, env: sandbox.env,
        }), { code: 'unsafe_qa_route' });
        assert.equal(calls.length, 0);
      }
    }
    for (const position of [admitted.indexOf('--extension') + 1, admitted.indexOf('--session-dir') + 1]) {
      const changed = [...admitted];
      changed[position] = '--experimental-default-config-file';
      assert.throws(() => new OwnedProcess(process.execPath, changed, {
        cwd: sandbox.workDir, env: sandbox.env,
      }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, 0);
    }
  });
});

test('every owned child environment drops Node bootstrap carriers, including Git and cmd', t => {
  const cwd = directory(t);
  const sandbox = disposableEnvironment({}, cwd, { ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1' });
  t.after(() => rmSync(sandbox.stateDir, { recursive: true, force: true }));
  const executables = JSON.parse(sandbox.env.ORACLE_QA_EXECUTABLES);
  const commands = [[executables.git.path, ['--version']]];
  if (process.platform === 'win32') commands.push([join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', 'exit', '0']]);
  observeSpawn(calls => {
    for (const [command, args] of commands) {
      assert.throws(() => new OwnedProcess(command, args, {
        cwd, env: { ...sandbox.env, NODE_OPTIONS: '--import=unapproved.mjs', nOdE_PaTh: cwd, NODE_FUTURE_LOADER: cwd },
      }), { code: 'spawn_boundary_reached' });
      assert.deepEqual(Object.keys(calls.at(-1).options.env).filter(key => /^node_/i.test(key)), []);
    }
    assert.equal(calls.length, commands.length);
  });
});

test('validated shell wrappers refuse Node launch forms before a process starts', t => {
  const cwd = directory(t);
  const sandbox = disposableEnvironment({}, cwd, { ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1' });
  t.after(() => rmSync(sandbox.stateDir, { recursive: true, force: true }));
  const executables = JSON.parse(sandbox.env.ORACLE_QA_EXECUTABLES);
  const fixture = join(ROOT, 'qa/owned-process-fixture.mjs');
  const forms = [
    '--env-file=payload.env', '--env-file payload.env',
    '--env-file-if-exists=payload.env', '--env-file-if-exists payload.env',
    '--experimental-config-file=payload.json', '--experimental-config-file payload.json',
    '--experimental-default-config-file',
  ];
  observeSpawn(calls => {
    for (const form of forms) {
      const command = `"${process.execPath}" "${fixture}" misleading-success ${form}`;
      const wrappers = [
        [executables.git.path, ['-c', `alias.fixture=!${command}`, 'fixture']],
        [executables.bash.path, ['-c', command]],
        [executables.powershell.path, ['-NoProfile', '-Command', `& ${command}`]],
      ];
      if (process.platform === 'win32') {
        wrappers.push([join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', command]]);
      }
      for (const [executable, args] of wrappers) {
        assert.throws(() => new OwnedProcess(executable, args, { cwd, env: sandbox.env }),
          { code: 'unsafe_qa_route' });
        assert.equal(calls.length, 0, 'The launcher must refuse before the shell process starts.');
      }
    }
  });
});

test('every approved Node purpose rejects trailing loaders and extra operands', t => {
  const cwd = directory(t);
  const files = readdirSync(join(ROOT, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
  const purposes = [
    ['version', ['--version']],
    ['exit', ['-e', 'process.exit(1)']],
    ['test', ['--test', 'fixture.test.mjs']],
    ['check', ['--test', '--test-isolation=none', '--test-reporter=./qa/verdict-test-reporter.mjs', ...files]],
    ['syntax', ['--check', join(ROOT, 'qa/owned-process-fixture.mjs')]],
    ['containment', ['--test', '--test-isolation=none', '--test-name-pattern=^credential containment:', 'test/auth-guard.test.mjs']],
    ['script', [join(ROOT, 'scripts/build.mjs')]],
    ['script', [join(ROOT, 'qa/run.mjs'), '--case', 'stop-real', '--attempt', 'test-admission', '--main', 'mock', '--oracle', 'mock']],
    ['script', [join(ROOT, 'test/helpers/auth-runtime-client.mjs')]],
  ];
  observeSpawn(calls => {
    for (const [nodeProfile, args] of purposes) {
      const before = calls.length;
      assert.throws(() => new OwnedProcess(process.execPath, args, { cwd, env: {}, nodeProfile }),
        { code: 'spawn_boundary_reached' });
      assert.equal(calls.length, before + 1);
      for (const suffix of [
        ['--env-file=payload.env'], ['--env-file', 'payload.env'],
        ['--env-file-if-exists=payload.env'], ['--env-file-if-exists', 'payload.env'],
        ['--experimental-config-file=payload.json'], ['--experimental-config-file', 'payload.json'],
        ['--experimental-default-config-file'], ['extra-operand'], ['--', '--experimental-default-config-file'],
      ]) {
        assert.throws(() => new OwnedProcess(process.execPath, [...args, ...suffix], { cwd, env: {}, nodeProfile }),
          { code: 'unsafe_qa_route' });
        assert.equal(calls.length, before + 1);
      }
    }
    for (const position of [2, 4]) {
      const args = [join(ROOT, 'qa/run.mjs'), '--case', 'stop-real', '--attempt', 'test-admission', '--main', 'mock'];
      args[position] = '--experimental-default-config-file';
      const before = calls.length;
      assert.throws(() => new OwnedProcess(process.execPath, args, { cwd, env: {} }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, before);
    }
  });
});

test('real Node control exposes trailing preload execution but the guarded fixture cannot execute it', async t => {
  const cwd = directory(t);
  const fixture = join(ROOT, 'qa/owned-process-fixture.mjs');
  const envFile = join(cwd, 'preload.env');
  const preload = 'data:text/javascript,throw%20new%20Error("REAL_TRAILING_PRELOAD")';
  writeFileSync(envFile, `NODE_OPTIONS=--import=${preload}\n`);
  writeFileSync(join(cwd, 'node.config.json'), JSON.stringify({ nodeOptions: { import: [preload] } }));
  const env = nodeSpawnEnvironment({ SystemRoot: process.env.SystemRoot, PATH: '' });
  // Deliberate parser positive control, not an owned/admitted launch.
  const unsafe = childProcess.spawnSync(process.execPath, [fixture, 'misleading-success', `--env-file=${envFile}`], {
    cwd, env, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ok(unsafe.pid > 0);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /REAL_TRAILING_PRELOAD/);
  assert.equal(unsafe.stdout, '');
  assert.throws(() => new OwnedProcess(process.execPath, [fixture, 'misleading-success', `--env-file=${envFile}`], {
    cwd, env,
  }), { code: 'unsafe_qa_route' });
  const safe = new OwnedProcess(process.execPath, [fixture, 'misleading-success'], {
    cwd, env: { ...env, NODE_OPTIONS: `--import=${preload}` },
  });
  t.after(() => safe.stop({ force: true }));
  await safe.stop();
  assert.equal(safe.metadata.exit_code, 7);
  assert.equal(safe.metadata.pid_gone, true);
  assert.equal(safe.metadata.node_guard.full_argv_validated, true);
  assert.doesNotMatch(safe.stderr, /REAL_TRAILING_PRELOAD/);
});

test('renamed Node requires a resolved version receipt and cannot downgrade into a non-Node child', async t => {
  const cwd = directory(t);
  const renamed = join(cwd, process.platform === 'win32' ? 'renamed-runtime.exe' : 'renamed-runtime');
  copyFileSync(process.execPath, renamed);
  const args = [join(ROOT, 'qa/owned-process-fixture.mjs'), 'misleading-success'];
  observeSpawn(calls => {
    assert.throws(() => new OwnedProcess(renamed, [...args, '--env-file=payload.env'], { cwd, env: {} }),
      { code: 'unsafe_qa_route' });
    assert.equal(calls.length, 0);
  });
  const children = [];
  await validateFixtureExecutable('node', {
    candidates: [renamed], env: { SystemRoot: process.env.SystemRoot, PATH: '' },
    cwd, children, label: 'renamed-node-version',
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].pid_gone, true);
  assert.equal(isNodeExecutable(renamed), true);
  const record = validatedExecutable(renamed);
  observeSpawn(calls => {
    for (const suffix of [['--env-file=payload.env'], ['--experimental-config-file', 'payload.json']]) {
      assert.throws(() => new OwnedProcess(renamed, [...args, ...suffix], { cwd, env: {} }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, 0);
    }
    assert.throws(() => new OwnedProcess(renamed, args, {
      cwd, env: { ORACLE_QA_EXECUTABLES: JSON.stringify({ node: record }), ORACLE_QA_NODE: process.execPath },
    }), { code: 'unsafe_qa_route' });
    assert.equal(calls.length, 0);
    for (const env of [
      { oracle_qa_executables: JSON.stringify({ node: record }), oracle_qa_node: process.execPath },
      { ORACLE_QA_EXECUTABLES: JSON.stringify({ node: record }), ORACLE_QA_NODE: renamed, oracle_qa_node: process.execPath },
      { ORACLE_QA_EXECUTABLES: '{}' },
    ]) {
      assert.throws(() => new OwnedProcess(renamed, args, { cwd, env }), { code: 'unsafe_qa_route' });
      assert.equal(calls.length, 0);
    }
    assert.throws(() => new OwnedProcess(renamed, args, {
      cwd, env: { ORACLE_QA_EXECUTABLES: JSON.stringify({ node: record }), ORACLE_QA_NODE: renamed },
    }), { code: 'spawn_boundary_reached' });
    assert.equal(calls.length, 1);
  });
});
