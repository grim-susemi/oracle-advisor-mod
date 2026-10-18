import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  fixtureSetupError, fixtureShellCommand, resolveFixtureExecutable,
  runFixtureCommand, validateFixtureExecutable, validateShellFixture,
} from '../qa/fixture-executable.mjs';
import nudgerQA from '../qa/nudger-extension.mjs';
import { REGISTRATION_KEY } from '../src/extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'oracle-fixture-executable-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('Node resolves absolutely even when owned PATH is empty', () => {
  const executable = resolveFixtureExecutable('node', { env: { PATH: '' } });
  assert.equal(isAbsolute(executable), true);
  assert.equal(executable, resolve(process.execPath));
});

test('Git resolves only absolute owned search directories and rejects missing executables', t => {
  const path = directory(t);
  assert.throws(() => resolveFixtureExecutable('git', {
    env: { PATH: '.' }, candidates: [join(path, 'absent-git')],
  }), error => error.code === 'fixture_setup_failed' &&
    error.fixture_setup.stage === 'executable_validation' && error.fixture_setup.reason === 'not_found');
  assert.throws(() => resolveFixtureExecutable('git', {
    env: {}, candidates: ['git'],
  }), { code: 'fixture_setup_failed' });
  assert.equal(resolveFixtureExecutable('git', { env: {}, candidates: [process.execPath] }),
    resolve(process.execPath));
});

test('shell command preserves executable spaces and argument metacharacters as literal bytes', () => {
  const executable = resolve('fixture tools', "node's.exe");
  assert.equal(fixtureShellCommand(executable, ['-e', "process.exit(1); '$HOME'"]),
    `'${executable.replace(/\\/g, '/').replaceAll("'", "'\\''")}' '-e' 'process.exit(1); '\\''$HOME'\\'''`);
});

test('version validation retains owned command receipts and raw output', async t => {
  const path = directory(t);
  const children = [];
  const validation = await validateFixtureExecutable('node', {
    env: { PATH: '' }, cwd: path, children, rawPrefix: join(path, 'node-version'),
    label: 'node-version',
  });
  assert.equal(validation.event, 'fixture_validation');
  assert.equal(validation.runner, 'owned_process');
  assert.equal(validation.call_id, 'node-version');
  assert.equal(validation.executable, resolve(process.execPath));
  assert.equal(validation.command, validation.executable);
  assert.deepEqual(validation.args, ['--version']);
  assert.match(validation.version, /^v\d+\.\d+\.\d+/);
  assert.equal(validation.valid, true);
  assert.equal(children.length, 1);
  assert.equal(children[0].qa_label, 'node-version');
  assert.equal(children[0].exit_code, 0);
  assert.equal(children[0].pid_gone, true);
  assert.deepEqual(children[0].argv, [validation.executable, '--version']);
  assert.equal(children[0].raw_output.stdout, join(path, 'node-version.stdout.log'));
});

test('non-executable Git candidate is validation failure, not a product result', async t => {
  const path = directory(t);
  const children = [];
  await assert.rejects(validateFixtureExecutable('git', {
    env: { PATH: '' }, cwd: path, children, candidates: [process.execPath],
  }), error => error.code === 'fixture_setup_failed' &&
    error.fixture_setup.stage === 'executable_validation' &&
    error.fixture_setup.reason === 'unexpected_version');
  assert.equal(children[0].pid_gone, true);
});

test('spawn failure remains distinct from executable validation and retains runner receipt', async t => {
  const path = directory(t);
  const children = [];
  await assert.rejects(runFixtureCommand(join(path, 'missing-executable'), [], {
    env: { PATH: '' }, cwd: path, children, label: 'missing-spawn',
  }), error => error.code === 'fixture_setup_failed' && error.fixture_setup.stage === 'spawn');
  assert.equal(children.length, 1);
  assert.equal(children[0].qa_label, 'missing-spawn');
  assert.match(children[0].spawn_error, /ENOENT/);
  assert.equal(children[0].pid_gone, true);
});

test('fixture setup command exit mismatch is typed while expected fixture failures remain observations', async t => {
  const path = directory(t);
  const children = [];
  await assert.rejects(runFixtureCommand(process.execPath, ['-e', 'process.exit(7)'], {
    env: {}, cwd: path, children, label: 'setup-failure', nodeProfile: 'exit',
  }), error => error.code === 'fixture_setup_failed' && error.fixture_setup.stage === 'command' &&
    error.fixture_setup.exit_code === 7);
  const result = await runFixtureCommand(process.execPath, ['-e', 'process.exit(1)'], {
    env: {}, cwd: path, children, label: 'intentional-failure', expected: null, nodeProfile: 'exit',
  });
  assert.equal(result.metadata.exit_code, 1);
  assert.equal(children.every(child => child.pid_gone), true);
});

test('native shell validation requires correlated successful --version execution', () => {
  const executable = resolve(process.execPath);
  const command = fixtureShellCommand(executable, ['--version']);
  const observed = { call_id: 'native-version', input: { command }, is_error: false,
    structured_content: { exit_code: 0 }, content: [{ type: 'text', text: 'v24.10.0\n' }] };
  const validation = validateShellFixture(executable, observed);
  assert.deepEqual(validation, {
    event: 'fixture_validation', runner: 'bash', call_id: 'native-version',
    executable, command, args: ['--version'], exit_code: 0, version: 'v24.10.0', valid: true,
    fixture_command: fixtureShellCommand(executable, ['-e', 'process.exit(1)']),
    fixture_args: ['-e', 'process.exit(1)'],
  });
  assert.deepEqual(validateShellFixture(executable, {
    ...observed, structured_content: null, details: { status: 'completed' },
  }), validation);
  assert.throws(() => validateShellFixture(executable, {
    ...observed, structured_content: { exit_code: 127 }, details: { status: 'completed' },
  }), { code: 'fixture_setup_failed' });
  for (const altered of [
    { call_id: undefined }, { input: { command: 'node --version' } },
    { is_error: true }, { structured_content: { exit_code: 127 } },
    { structured_content: null }, { content: [{ type: 'text', text: 'git version 2.50.0' }] },
  ]) {
    assert.throws(() => validateShellFixture(executable, { ...observed, ...altered }),
      error => error.code === 'fixture_setup_failed' && error.fixture_setup.stage === 'executable_validation');
  }
  assert.equal(fixtureSetupError('spawn', executable, 'ENOENT').fixture_setup.stage, 'spawn');
});

test('absolute Git validates and initializes an owned fixture before any host exists', async t => {
  const path = directory(t);
  const children = [];
  const validation = await validateFixtureExecutable('git', {
    env: process.env, cwd: path, children, label: 'git-version',
    rawPrefix: join(path, 'raw', 'git-version'),
  });
  assert.equal(isAbsolute(validation.executable), true);
  assert.match(validation.version, /^git version /);
  const env = { PATH: '', HOME: path, USERPROFILE: path };
  writeFileSync(join(path, 'fixture.mjs'), 'export default true;\n');
  for (const [label, args] of [
    ['git-init', ['init', '--quiet']],
    ['git-add', ['--no-optional-locks', 'add', '--', 'fixture.mjs']],
  ]) {
    await runFixtureCommand(validation.executable, args, {
      env, cwd: path, children, label, rawPrefix: join(path, 'raw', label),
    });
  }
  assert.deepEqual(children.map(child => child.qa_label), ['git-version', 'git-init', 'git-add']);
  assert.equal(children.every(child => child.argv[0] === validation.executable &&
    child.exit_code === 0 && child.pid_gone), true);
});

test('nudge validation observes the native shell call before opening a job and before the failure pair', async t => {
  const path = mkdtempSync(join(tmpdir(), 'oracle-fixture-nudger-'));
  const priorRegistration = globalThis[REGISTRATION_KEY];
  const variables = {
    HOME: path, USERPROFILE: path, SENPI_CODING_AGENT_DIR: join(path, 'agent'),
    OMO_CODING_AGENT_DIR: join(path, 'agent'), OMO_PROFILE: '', OCX_PROFILE: '',
    OPENCODE_CONFIG_DIR: '', OMO_ORACLE_ADVISOR: '1',
    ORACLE_QA_PROBE_LOG: join(path, 'probe.jsonl'), ORACLE_QA_REAL_ORACLE: '0',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  delete globalThis[REGISTRATION_KEY];
  Object.assign(process.env, variables);
  const events = [];
  const handlers = new Map();
  let sequence = 0, failureCalls = 0;
  const children = [];
  const executable = resolveFixtureExecutable('node');
  const failureCommand = fixtureShellCommand(executable, ['-e', 'process.exit(1)']);
  const fake = createFakePi({
    cwd: path,
    async executeTool(name, input) {
      assert.equal(name, 'bash');
      const toolCallId = `native-fixture-${++sequence}`;
      const call = { type: 'tool_call', toolName: name, toolCallId, input };
      await fake.emit('tool_call', call);
      const failed = input.command === failureCommand;
      const outcome = await runFixtureCommand(executable, failed ? ['-e', 'process.exit(1)'] : ['--version'], {
        cwd: path, env: { PATH: '' }, children, label: toolCallId, expected: null,
        nodeProfile: failed ? 'exit' : 'version',
      });
      const result = {
        ...call, type: 'tool_result', isError: failed, content: [{ type: 'text', text: outcome.stdout.trim() }],
        details: failed ? undefined : { status: 'completed' },
      };
      if (failed) failureCalls++;
      await fake.emit('tool_result', result);
      return { result };
    },
  });
  fake.pi.rpc = {
    emit(_name, event) { events.push(event); },
    handle(name, handler) { handlers.set(name, handler); },
  };
  t.after(async () => {
    try { await fake.emit('session_shutdown'); }
    finally {
      if (priorRegistration === undefined) delete globalThis[REGISTRATION_KEY];
      else globalThis[REGISTRATION_KEY] = priorRegistration;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(path, { recursive: true, force: true });
    }
  });
  nudgerQA(fake.pi);
  await fake.emit('session_start');
  const validation = await handlers.get('oracle.nudger.validate')({ executable });
  assert.equal(validation.call_id, 'native-fixture-1');
  assert.equal(validation.fixture_command, failureCommand);
  assert.equal(events.filter(event => event.event === 'fixture_validation').length, 1);
  assert.equal(globalThis[REGISTRATION_KEY].runtime.ledger.state.job, null);
  await fake.command('oracle', 'on');
  const shellArgs = { command: failureCommand, timeout: 30, run_in_background: false };
  await fake.ctx.executeTool('bash', shellArgs);
  await fake.ctx.executeTool('bash', shellArgs);
  assert.equal(failureCalls, 2);
  const attempts = events.filter(event => event.event === 'evidence' && event.kind === 'attempt');
  assert.deepEqual(attempts.slice(1).map(event => event.input), [shellArgs, shellArgs]);
  const validationIndex = events.indexOf(events.find(event => event.event === 'fixture_validation'));
  const openIndex = events.findIndex(event => event.event === 'evidence' && event.kind === 'command_start' &&
    event.name === 'oracle' && event.args === 'on');
  assert.ok(validationIndex < openIndex);
  assert.equal(events.filter(event => event.event === 'result_patch').length, 1);
  assert.equal(events.find(event => event.event === 'result_patch').call_id, 'native-fixture-3');
  const before = sequence;
  await assert.rejects(handlers.get('oracle.nudger.validate')({ executable }), {
    code: 'fixture_setup_failed',
  });
  assert.equal(sequence, before);
  assert.equal(children.every(child => child.pid_gone), true);
});
