import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { authVerdict } from './auth-guard.mjs';
import { OwnedProcess, typedError } from './harness.mjs';
import { registerValidatedExecutable } from './node-spawn.mjs';

export function fixtureSetupError(stage, executable, reason, extra = {}) {
  return Object.assign(typedError('fixture_setup_failed', `${stage}: ${reason}`), {
    fixture_setup: { stage, executable, reason, ...extra },
  });
}

export function resolveFixtureExecutable(name, { env = process.env, candidates } = {}) {
  const environment = authVerdict(undefined, undefined, { environment: env }).environment;
  if (!candidates) {
    if (name === 'node') candidates = [environment.ORACLE_QA_NODE ?? process.execPath];
    else if (name === 'git') {
      if (environment.ORACLE_QA_GIT) candidates = [environment.ORACLE_QA_GIT];
      else {
      const search = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
      candidates = search.split(process.platform === 'win32' ? ';' : ':')
        .filter(path => isAbsolute(path)).map(path => join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (process.platform === 'win32') {
        const programFiles = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PROGRAMFILES')?.[1];
        if (programFiles && isAbsolute(programFiles)) candidates.push(join(programFiles, 'Git', 'cmd', 'git.exe'));
      }
      }
    } else throw fixtureSetupError('executable_validation', name, 'unsupported_executable');
  }
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try {
      const absolute = realpathSync(path);
      if (!statSync(absolute).isFile()) continue;
      accessSync(absolute, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return resolve(absolute);
    } catch { /* A search candidate is not a runnable fixture executable. */ }
  }
  throw fixtureSetupError('executable_validation', name, 'not_found');
}

export function fixtureShellCommand(executable, args) {
  if (!isAbsolute(executable)) throw fixtureSetupError('executable_validation', executable, 'not_absolute');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return [executable.replace(/\\/g, '/'), ...args].map(quote).join(' ');
}

export async function runFixtureCommand(executable, args, {
  env, cwd, rawPrefix, children, label, expected = 0, nodeProfile = 'script',
} = {}) {
  let owned;
  try {
    owned = new OwnedProcess(executable, args, { cwd, env, rawPrefix, nodeProfile });
  } catch (error) {
    throw fixtureSetupError('spawn', executable, error.code ?? error.message, { label });
  }
  owned.metadata.qa_label = label;
  children.push(owned.metadata);
  owned.child.stdin.end();
  await owned.exit;
  await owned.stop();
  if (owned.metadata.spawn_error) {
    throw fixtureSetupError('spawn', executable, owned.metadata.spawn_error, { label });
  }
  if (expected !== null && owned.metadata.exit_code !== expected) {
    throw fixtureSetupError('command', executable, 'unexpected_exit', {
      label, exit_code: owned.metadata.exit_code, expected_exit_code: expected,
    });
  }
  return { stdout: owned.stdout, stderr: owned.stderr, metadata: owned.metadata };
}

export async function validateFixtureExecutable(name, options) {
  const executable = resolveFixtureExecutable(name, options);
  const args = ['--version'];
  const result = await runFixtureCommand(executable, args, { ...options, expected: null, nodeProfile: 'version' });
  if (result.metadata.exit_code !== 0) {
    throw fixtureSetupError('executable_validation', executable, 'version_command_failed', {
      label: options.label, exit_code: result.metadata.exit_code,
    });
  }
  const version = result.stdout.trim();
  if (!(name === 'node' ? /^v\d+\.\d+\.\d+(?:[-+.\w]*)$/ : /^git version \d+\.\d+(?:[.\w-]*)$/).test(version)) {
    throw fixtureSetupError('executable_validation', executable, 'unexpected_version', { label: options.label });
  }
  registerValidatedExecutable(name, { path: executable, args, version, exit_code: result.metadata.exit_code, validated: true,
    pid: result.metadata.pid, pid_gone: result.metadata.pid_gone });
  return {
    event: 'fixture_validation', runner: 'owned_process', call_id: options.label,
    executable, command: executable, args, exit_code: result.metadata.exit_code, version, valid: true,
  };
}

export function validateShellFixture(executable, observation) {
  const args = ['--version'];
  const command = fixtureShellCommand(executable, args);
  const version = (observation?.content ?? []).filter(part => part.type === 'text')
    .map(part => part.text).join('\n').trim();
  const exit_code = Number.isSafeInteger(observation?.structured_content?.exit_code)
    ? observation.structured_content.exit_code : observation?.details?.status === 'completed' ? 0 : null;
  if (!observation?.call_id || observation.input?.command !== command ||
      observation.is_error !== false || exit_code !== 0 ||
      !/^v\d+\.\d+\.\d+(?:[-+.\w]*)$/.test(version)) {
    throw fixtureSetupError('executable_validation', executable, 'shell_validation_failed', {
      call_id: observation?.call_id ?? null, exit_code,
    });
  }
  const fixture_args = ['-e', 'process.exit(1)'];
  return {
    event: 'fixture_validation', runner: 'bash', call_id: observation.call_id,
    executable, command, args, exit_code, version, valid: true,
    fixture_command: fixtureShellCommand(executable, fixture_args), fixture_args,
  };
}
