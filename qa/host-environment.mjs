import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { assertNodeLaunch, nodeSpawnEnvironment, registerValidatedExecutable, validatedExecutable } from './node-spawn.mjs';

let resolved;
export function fixtureExecutables(environment = process.env) {
  if (resolved) return resolved;
  const value = key => Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const system = value('SystemRoot') ?? 'C:\\Windows';
  const programFiles = value('ProgramFiles') ?? 'C:\\Program Files';
  const search = Object.entries(environment).filter(([key]) => key.toLowerCase() === 'path')
    .flatMap(([, paths]) => paths.split(delimiter)).filter(isAbsolute);
  const definitions = {
    node: [{ path: process.execPath, source: 'process.execPath' }],
    git: [
      ...search.map(path => ({ path: join(path, process.platform === 'win32' ? 'git.exe' : 'git'), source: 'worker search directory' })),
      { path: join(programFiles, 'Git/cmd/git.exe'), source: 'ProgramFiles/Git/cmd' },
    ],
    powershell: [
      { path: join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), source: 'SystemRoot Windows PowerShell installation' },
      { path: join(programFiles, 'PowerShell/7/pwsh.exe'), source: 'ProgramFiles PowerShell installation' },
    ],
    bash: [
      { path: join(programFiles, 'Git/bin/bash.exe'), source: 'ProgramFiles Git Bash installation' },
      ...search.map(path => ({ path: join(path, 'bash.exe'), source: 'worker search directory' })),
    ],
  };
  if (environment.ORACLE_QA_EXECUTABLES) {
    const inherited = JSON.parse(environment.ORACLE_QA_EXECUTABLES);
    for (const name of Object.keys(definitions)) {
      const entry = inherited[name];
      if (!entry?.validated || !isAbsolute(entry.path) || realpathSync(entry.path) !== entry.path ||
          !statSync(entry.path).isFile()) throw new Error(`Invalid owned executable: ${name}`);
      const cached = validatedExecutable(entry.path);
      if (!cached) {
        const args = name === 'powershell'
          ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
          : ['--version'];
        const env = nodeSpawnEnvironment(environment);
        if (name === 'node') assertNodeLaunch(entry.path, args, env, { nodeProfile: 'version' });
        const check = spawnSync(entry.path, args, {
          env, encoding: 'utf8', windowsHide: true, timeout: 15000,
        });
        if (check.status !== 0 || check.stdout?.trim() !== entry.version) throw new Error(`Invalid owned executable: ${name}`);
        entry.pid = check.pid;
        entry.pid_gone = true;
      } else if (cached.kind !== name || cached.version !== entry.version) {
        throw new Error(`Invalid owned executable: ${name}`);
      }
      registerValidatedExecutable(name, entry);
    }
    return resolved = inherited;
  }
  const result = {};
  for (const [name, candidates] of Object.entries(definitions)) {
    for (const candidate of candidates) {
      if (!isAbsolute(candidate.path)) continue;
      let path;
      try {
        path = realpathSync(candidate.path);
        if (!statSync(path).isFile()) continue;
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch { continue; }
      const cached = validatedExecutable(path);
      if (name === 'node' && cached?.kind === 'node') {
        result[name] = { ...cached, source: candidate.source };
        break;
      }
      const args = name === 'powershell'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
        : ['--version'];
      const env = nodeSpawnEnvironment(environment);
      if (name === 'node') assertNodeLaunch(path, args, env, { nodeProfile: 'version' });
      const check = spawnSync(path, args, { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const version = check.stdout?.trim() ?? '';
      const valid = name === 'node' ? /^v\d+\.\d+\.\d+/.test(version)
        : name === 'git' ? /^git version \d+\.\d+/.test(version)
        : name === 'bash' ? /^GNU bash, version \d+/.test(version) : /^\d+\.\d+/.test(version);
      if (check.status !== 0 || !valid) continue;
      result[name] = { path, source: candidate.source, args, version, exit_code: check.status, validated: true,
        pid: check.pid, pid_gone: true };
      registerValidatedExecutable(name, result[name]);
      break;
    }
    if (!result[name]) throw new Error(`Owned fixture executable not found: ${name}`);
  }
  return resolved = result;
}

export function bindFixtureEnvironment(environment, executables = fixtureExecutables()) {
  const clean = Object.fromEntries(Object.entries(nodeSpawnEnvironment(environment)).filter(([key]) => key.toLowerCase() !== 'path'));
  const system = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows';
  const bashDirectory = dirname(executables.bash.path);
  const gitRoot = /[\\/]usr[\\/]bin$/i.test(bashDirectory) ? dirname(dirname(bashDirectory)) : dirname(bashDirectory);
  // A new, single uppercase key survives Windows' case-sensitive eval workers.
  // No inherited search directory decides which fixture executable is run.
  clean.PATH = [...new Set([
    dirname(executables.node.path), dirname(executables.git.path), dirname(executables.powershell.path),
    join(gitRoot, 'bin'), join(gitRoot, 'usr/bin'), join(system, 'System32'), system,
  ])].join(delimiter);
  clean.ORACLE_QA_EXECUTABLES = JSON.stringify(executables);
  clean.ORACLE_QA_NODE = executables.node.path;
  clean.ORACLE_QA_GIT = executables.git.path;
  clean.ORACLE_QA_POWERSHELL = executables.powershell.path;
  clean.SENPI_GIT_BASH_PATH = executables.bash.path;
  return clean;
}
