import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureExecutables, bindFixtureEnvironment } from '../qa/host-environment.mjs';
import { exitCommand } from '../qa/triggers-case.mjs';
import { assertNodeLaunch } from '../qa/node-spawn.mjs';

test('owned fixtures use a single controlled uppercase PATH rather than conflicting parent casing', () => {
  const executables = fixtureExecutables();
  const environment = bindFixtureEnvironment({
    SystemRoot: process.env.SystemRoot, Path: 'C:\\absent-one', PATH: 'C:\\absent-two',
  }, executables);
  assert.deepEqual(Object.keys(environment).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  assert.equal(environment.PATH.includes('absent-'), false);
  for (const [name, executable] of Object.entries(executables)) {
    assert.equal(executable.validated, true);
    assert.equal(executable.exit_code, 0);
    assert.ok(environment.PATH.split(delimiter).includes(dirname(executable.path)), name);
  }
  for (const [name, args] of [['node', ['--version']], ['git', ['--version']],
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']]]) {
    assertNodeLaunch(environment[`ORACLE_QA_${name.toUpperCase()}`], args, environment,
      { nodeProfile: name === 'node' ? 'version' : 'script' });
    const result = spawnSync(environment[`ORACLE_QA_${name.toUpperCase()}`], args, {
      env: { ...environment, PATH: '' }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), executables[name].version);
  }
});

test('trigger fixture retains canonical command bytes while resolving Node through the owned environment', () => {
  assert.deepEqual([1, 0, 1].map(exitCommand), [
    'node -e "process.exit(1)"', 'node -e "process.exit(0)"', 'node -e "process.exit(1)"',
  ]);
  const executables = fixtureExecutables();
  const environment = bindFixtureEnvironment({ SystemRoot: process.env.SystemRoot, Path: 'C:\\absent-parent' }, executables);
  assertNodeLaunch('node', ['--version'], environment, { nodeProfile: 'version' });
  const result = spawnSync('node', ['--version'], { env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), executables.node.version);
});
