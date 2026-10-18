import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJson, typedError, withSafety, writeJson } from './safety-state.mjs';
import { authHashes, authObservation, authSourceAvailable, authVerdict, hostConfiguration, mainKey } from './auth-guard.mjs';
import { bindFixtureEnvironment } from './host-environment.mjs';
import { admitHostRoute, assertHostRoute, registerHostPrograms } from './route-guard.mjs';
import { assertNodeLaunch, nodeSpawnEnvironment, resolveOwnedExecutable } from './node-spawn.mjs';
export { readJson, typedError, writeJson } from './safety-state.mjs';
export { authHashes, hostConfiguration };

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HARNESS_DEADLINE_MS = 180000; // Owned QA lifetime, NOT a consult deadline.
export const REAL_OBSERVATION_CEILING_MS = 1800000;
export const REAL_ORACLE_LIMIT = 24;

export function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}
export function admitAuth(attemptDir, fixtureRoot, { real = true, receipt, ...options } = {}) {
  // Earlier records are read-only. Scoped attempts inherit only scoped guarded
  // entry changes; strict real-model admission keeps every historical latch.
  if (real || process.env.ORACLE_QA_AUTH_GUARD === 'scoped') {
    for (const entry of readdirSync(dirname(attemptDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const prior = join(dirname(attemptDir), entry.name);
      if (resolve(prior) === resolve(attemptDir)) continue;
      const path = join(prior, 'real-model-safety.json');
      if (existsSync(path) && authVerdict(readJson(path), undefined, { admission: true }).type === 'auth_changed') {
        if (receipt) receipt.blocking_auth_attempt = prior;
        throw typedError('auth_changed', 'A prior credential block requires owner decision before real-model QA.');
      }
    }
  }
  return guardAuth(attemptDir, fixtureRoot, { ...options, before: true });
}
export function guardAuth(attemptDir, fixtureRoot, options = {}) {
  if (process.env.ORACLE_QA_GUARD_IPC === '1') {
    if (!process.send) throw typedError('auth_guard_channel_unavailable');
    const id = randomUUID();
    return new Promise((resolveGuard, reject) => {
      const clean = () => {
        clearTimeout(timer);
        process.off('message', receive);
        process.off('disconnect', disconnected);
      };
      const receive = message => {
        if (message?.type !== 'oracle-qa.auth.reply' || message.id !== id) return;
        clean();
        if (message.error) reject(typedError(message.error.code, message.error.message));
        else resolveGuard(message.hashes);
      };
      const disconnected = () => { clean(); reject(typedError('auth_guard_channel_closed')); };
      const timer = setTimeout(() => {
        clean(); reject(typedError('auth_guard_channel_timeout'));
      }, 15000);
      process.on('message', receive);
      process.once('disconnect', disconnected);
      process.send({
        type: 'oracle-qa.auth.request', id, attemptDir,
        before: options.before === true, providers: options.providers,
      }, error => { if (error) { clean(); reject(typedError('auth_guard_channel_closed')); } });
    });
  }
  const verdict = withSafety(attemptDir, state => {
    const result = authVerdict(state, fixtureRoot, options);
    writeJson(join(attemptDir, 'auth-guard-receipt.json'), result.receipt);
    return result;
  });
  if (verdict.type === 'auth_changed') {
    throw typedError('auth_changed', 'Credential hashes changed; further real-model QA requires owner decision.');
  }
  return verdict.hashes;
}
export function finalizeAuthGuard(receipt, attemptDir, fixtureRoot, options = {}) {
  try {
    receipt.auth_after = guardAuth(attemptDir, fixtureRoot, options);
    receipt.auth_guard_passed = true;
  } catch (error) {
    receipt.auth_guard_passed = false;
    if (receipt.status !== 'blocked_by_auth_guard') receipt.status = 'auth_changed';
    receipt.exit_code = 1;
    receipt.error = { type: error.code, message: error.message };
  }
  return receipt;
}
export function finalizeAuthObservation(receipt, before, fixtureRoot, { changeStatus = true } = {}) {
  const verdict = authObservation(before, fixtureRoot);
  receipt.auth_after = verdict.hashes;
  receipt.auth_unchanged = verdict.unchanged;
  if (verdict.type === 'auth_changed') {
    if (changeStatus && receipt.status !== 'blocked_by_auth_guard') receipt.status = 'auth_changed';
    receipt.exit_code = 1;
  }
  return receipt;
}
export function reserveRealOracleRuns(attemptDir, count = 1) {
  if (!Number.isSafeInteger(count) || count < 1) throw typedError('invalid_run_count');
  return withSafety(attemptDir, state => {
    if (state.blocked) throw typedError('auth_changed', 'Real-model QA blocked after credential hashes changed.');
    if (state.real_oracle_runs + count > REAL_ORACLE_LIMIT) throw typedError('real_oracle_cap_exhausted');
    state.real_oracle_runs += count; // Reserve before dispatch; failures do not refund.
    return state.real_oracle_runs;
  });
}
export function discoverHost(environment = process.env) {
  const engine = environment.OMO_STABLE_SENPI_BUNDLE ?? 'C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js';
  // USERPROFILE is the stable profile's HOME here, not the installation owner.
  const globalRoot = resolve(dirname(engine), '../../../..');
  const lane = environment.OMO_STABLE_ROOT ?? 'C:/Users/USER/.omo-stable-500';
  const launcher = environment.OMO_STABLE_REENTRY ?? environment.OMO_BIN ?? join(lane, 'staging/omo-memory-selector-entry-r19.mjs');
  const plugin = environment.OMO_STABLE_PLUGIN ?? join(lane, 'staging/memory-rollback-5.1.34-r1/package/plugin');
  for (const path of [launcher, engine, plugin]) {
    if (!existsSync(path)) throw typedError('host_not_found', path);
  }
  if (!authSourceAvailable()) throw typedError('host_not_found', 'Credential source is unavailable.');
  const host = {
    launcher, engine, plugin,
    versions: {
      senpi: readJson(join(globalRoot, '@code-yeongyu/senpi/package.json')).version,
      omo_ai: readJson(join(globalRoot, 'omo-ai/package.json')).version,
    },
  };
  registerHostPrograms(host);
  return host;
}
export function sourceHash() {
  const digest = createHash('sha256');
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.omo', 'dist'].includes(entry.name) || entry.name.startsWith('.dist-stage-')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) digest.update(path.slice(ROOT.length)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  walk(ROOT);
  return digest.digest('hex');
}
export function pidGone(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
function killOwned(child) {
  if (!child.pid || pidGone(child.pid)) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true,
      env: nodeSpawnEnvironment(authVerdict(undefined, undefined, { environment: process.env }).environment),
    });
    if (result.status !== 0 && !pidGone(child.pid)) {
      throw typedError('cleanup_failed', result.error?.message ?? result.stderr);
    }
  } else child.kill('SIGKILL');
}

// Single directly owned process; no wrapper, shared daemon, shell, or owner's pane.
export class OwnedProcess {
  constructor(command, args, { cwd, env, rawPrefix, deadlineMs = HARNESS_DEADLINE_MS, nodeProfile = 'script' } = {}) {
    this.events = new EventEmitter();
    this.history = [];
    this.stdout = '';
    this.stderr = '';
    this.sequence = 0;
    this.closed = false;
    if (rawPrefix) {
      mkdirSync(dirname(rawPrefix), { recursive: true });
      writeFileSync(`${rawPrefix}.stdout.log`, '');
      writeFileSync(`${rawPrefix}.stderr.log`, '');
    }
    this.metadata = { argv: [command, ...args], cwd, pid: null, exit_code: null, signal: null, deadline_ms: deadlineMs, timed_out: false };
    const sanitized = authVerdict(undefined, undefined, { environment: env ?? process.env }).environment;
    const childEnvironment = nodeSpawnEnvironment(sanitized);
    command = resolveOwnedExecutable(command, childEnvironment, cwd);
    this.metadata.resolved_executable = command;
    this.metadata.node_guard = assertNodeLaunch(command, args, childEnvironment, { nodeProfile, cwd });
    this.metadata.route_guard = assertHostRoute(args, childEnvironment, cwd, command, { nodeProfile });
    if (this.metadata.route_guard) this.metadata.fixture_environment = {
      path_keys: Object.keys(childEnvironment).filter(key => key.toLowerCase() === 'path'),
      PATH: childEnvironment.PATH,
      executables: JSON.parse(childEnvironment.ORACLE_QA_EXECUTABLES ?? 'null'),
      bash: childEnvironment.SENPI_GIT_BASH_PATH,
    };
    const guardChannel = childEnvironment.ORACLE_QA_GUARD_IPC === '1';
    this.child = spawn(command, args, {
      cwd, env: childEnvironment,
      stdio: guardChannel ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (guardChannel) this.child.on('message', message => {
      if (message?.type !== 'oracle-qa.auth.request') return;
      const reply = { type: 'oracle-qa.auth.reply', id: message.id };
      try {
        if (typeof message.attemptDir !== 'string' || message.attemptDir !== childEnvironment.ORACLE_QA_ATTEMPT_DIR ||
            typeof message.id !== 'string') throw typedError('auth_guard_context_mismatch');
        if (message.providers !== undefined && (!Array.isArray(message.providers) ||
            message.providers.some(provider => typeof provider !== 'string'))) {
          throw typedError('invalid_guard_providers');
        }
        reply.hashes = guardAuth(message.attemptDir, undefined, {
          before: message.before === true, providers: message.providers,
        });
      } catch (error) {
        reply.error = { code: error.code ?? 'auth_guard_failed', message: error.message };
      }
      if (this.child.connected) this.child.send(reply, () => {});
    });
    this.metadata.pid = this.child.pid ?? null;
    this.child.stdout.on('data', chunk => {
      this.stdout += chunk;
      if (rawPrefix) appendFileSync(`${rawPrefix}.stdout.log`, chunk);
    });
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk;
      if (rawPrefix) appendFileSync(`${rawPrefix}.stderr.log`, chunk);
    });
    this.child.stdin.on('error', () => {}); // Close/error is the authoritative failed receipt.
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        this.history.push(event);
        this.events.emit('record', event);
      } catch { /* Human stdout is kept raw, never interpreted as success. */ }
    });
    this.exit = new Promise(resolveExit => {
      this.child.once('error', error => {
        this.metadata.spawn_error = error.message;
        this.events.emit('process_error', error);
      });
      this.child.once('close', (code, signal) => {
        clearTimeout(this.deadline);
        this.closed = true;
        Object.assign(this.metadata, { exit_code: code, signal });
        if (rawPrefix) {
          this.metadata.raw_output = { stdout: `${rawPrefix}.stdout.log`, stderr: `${rawPrefix}.stderr.log` };
        }
        this.events.emit('closed', this.metadata);
        resolveExit(this.metadata);
      });
    });
    this.deadline = setTimeout(() => {
      this.metadata.timed_out = true;
      try { killOwned(this.child); } catch (error) { this.metadata.cleanup_error = error.message; }
    }, deadlineMs);
  }
  waitFor(predicate, label, { timeoutMs = 45000, from = 0, timeoutCode = 'harness_deadline' } = {}) {
    const existing = this.history.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(typedError('host_exited', `${label}: host already exited`));
    const waiting = new Promise((resolveWait, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.events.off('record', record);
        this.events.off('closed', closed);
        this.events.off('process_error', failed);
      };
      const record = event => { if (predicate(event)) { clean(); resolveWait(event); } };
      const closed = () => { clean(); reject(typedError('host_exited', `${label}: owned PID ${this.metadata.pid} exited`)); };
      const failed = error => { clean(); reject(error); };
      const timer = setTimeout(() => { clean(); reject(typedError(timeoutCode, label)); }, timeoutMs);
      this.events.on('record', record);
      this.events.on('closed', closed);
      this.events.on('process_error', failed);
    });
    // Keep a subscription safe while its triggering RPC is still being admitted.
    waiting.catch(() => {});
    return waiting;
  }
  async rpc(type, data = {}) {
    const id = `qa-${++this.sequence}`;
    const response = this.waitFor(event => event.type === 'response' && event.id === id, `RPC ${type}`);
    this.child.stdin.write(JSON.stringify({ type, id, ...data }) + '\n');
    const result = await response;
    if (!result.success) throw typedError(result.errorCode ?? 'rpc_failed', `${type}: ${result.error}`);
    return result.data;
  }
  async prompt(message, { timeoutMs = 45000, ceiling = false } = {}) {
    // Subscribe before sending so a fast local provider cannot race the observer.
    const from = this.history.length;
    const finished = this.waitFor(event => event.type === 'agent_end', 'prompt agent_end', {
      from, timeoutMs, timeoutCode: ceiling ? 'harness_ceiling' : 'harness_deadline',
    });
    try {
      await this.rpc('prompt', { message });
      const result = await finished;
      const errors = (result.messages ?? []).filter(entry =>
        entry.role === 'assistant' && ['error', 'aborted'].includes(entry.stopReason));
      if (errors.length) {
        const quota = this.history.slice(from).some(event =>
          event.type === 'extension_event' && event.data?.event === 'provider_response' && event.data.status === 429);
        throw typedError(quota ? 'quota' : 'provider_error',
          errors.map(entry => entry.errorMessage ?? entry.stopReason).join('; '));
      }
      return result;
    } catch (error) {
      // Observe the pending event rejection when admission failed.
      finished.catch(() => {});
      throw error;
    }
  }
  async stop({ force = false } = {}) {
    if (!this.closed) {
      this.metadata.termination_reason = force ? 'owned-pid-cleanup' : 'stdin-eof';
      if (force) killOwned(this.child);
      else this.child.stdin.end();
    }
    const result = await this.exit;
    result.pid_gone = pidGone(result.pid);
    if (!result.pid_gone) throw typedError('cleanup_failed', `Owned PID ${result.pid} still alive`);
    return result;
  }
}

export function disposableEnvironment(host, runDir, extra = {}) {
  const environment = bindFixtureEnvironment(process.env);
  const args = process.argv.slice(2);
  const explicitReal = args.some((arg, index) =>
    ['--main=real', '--oracle=real'].includes(arg) ||
    (['--main', '--oracle'].includes(arg) && args[index + 1] === 'real'));
  const authorized = process.env.ORACLE_QA_ROUTE_POLICY === 'real-authorized';
  for (const key of Object.keys(environment)) {
    if (/^(PI_SESSION_|PI_GOAL_|OMO_AGENT_TOOLKIT_|OMO_DAG_|OMO_HERDR_|SENPI_HOST_|PI_HOST_)/.test(key) ||
        ['OMO_BIN', 'SENPI_BIN', 'OMO_PACKAGE_DIR', 'SENPI_PACKAGE_DIR', 'PI_PACKAGE_DIR'].includes(key)) delete environment[key];
  }
  const stateDir = mkdtempSync(join(tmpdir(), `oracle-advisor-qa-${extra.ORACLE_QA_ATTEMPT ?? basename(runDir)}-`));
  const home = join(stateDir, 'home');
  const agent = join(home, '.omo', 'agent');
  const workDir = join(stateDir, 'work');
  const sessions = join(runDir, 'sessions');
  mkdirSync(agent, { recursive: true });
  mkdirSync(workDir);
  mkdirSync(sessions, { recursive: true });
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
    OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
    OMO_CODING_AGENT_SESSION_DIR: sessions, SENPI_CODING_AGENT_SESSION_DIR: sessions,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    OMO_RUNTIME: 'node', SENPI_RUNTIME: 'node', OMO_NATIVE: '1',
    SENPI_BRAND: JSON.stringify({ name: 'OmO', command: 'omo', configDir: '.omo', envPrefix: 'OMO' }),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', OMO_TELEMETRY: '0', DO_NOT_TRACK: '1',
    SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events',
    OMO_RPC_CLIENT_CAPABILITIES: 'extension_events',
    ORACLE_QA_LOADING: 'cli-extension-flag', ORACLE_QA_NONCE: randomUUID(),
    ...(host.engine ? { ORACLE_QA_HOST_ENGINE: resolve(host.engine) } : {}),
    ...(host.launcher ? { ORACLE_QA_HOST_LAUNCHER: resolve(host.launcher) } : {}),
    ORACLE_QA_GUARD_IPC: '1',
    ORACLE_QA_PROBE_LOG: join(runDir, 'probe.jsonl'),
    ...extra,
    ORACLE_QA_ROUTE_POLICY: explicitReal && authorized ? 'real-authorized' : 'mock-only',
    ORACLE_QA_ROUTE_POLICY_REASON: !explicitReal ? 'no-explicit-real-route'
      : authorized ? 'explicit-real-route-and-parent-authorization' : 'parent-not-authorized',
  });
  // No live state root survives through stable-lane helper variables.
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OMO_STABLE_') && !['OMO_STABLE_NODE'].includes(key)) delete environment[key];
  }
  writeJson(join(agent, 'settings.json'), {
    quietStartup: true, packages: [], extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
  });
  writeJson(join(home, '.omo/omo.jsonc'), {
    '[native]': { agents: { oracle: { model: 'oracle-qa-mock/oracle', tools: { read: true } } } },
  });
  return { env: environment, stateDir, workDir, home, agentDir: agent, sessionDir: sessions };
}

export function cleanupDisposableState(sandbox) {
  let files = 0;
  let bytes = 0;
  const count = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) count(path);
      else if (entry.isFile()) { files++; bytes += statSync(path).size; }
    }
  };
  count(sandbox.stateDir);
  rmSync(sandbox.stateDir, { recursive: true, force: true });
  // Keep the owned transcript, not generated session indexes or extension state.
  for (const entry of readdirSync(sandbox.sessionDir)) {
    if (entry !== 'owned.jsonl') rmSync(join(sandbox.sessionDir, entry), { recursive: true, force: true });
  }
  const result = { path: sandbox.stateDir, removed_files: files, removed_bytes: bytes, removed: !existsSync(sandbox.stateDir) };
  if (!result.removed) throw typedError('cleanup_failed', sandbox.stateDir);
  return result;
}

export function hostArgs(host, sandbox, candidate, {
  main, mockExtension = join(ROOT, 'qa/mock-extension.mjs'),
  realOracle = sandbox.env.ORACLE_QA_REAL_ORACLE === '1',
} = {}) {
  registerHostPrograms(host);
  sandbox.env.ORACLE_QA_HOST_ENGINE = resolve(host.engine);
  if (host.launcher) sandbox.env.ORACLE_QA_HOST_LAUNCHER = resolve(host.launcher);
  admitHostRoute(sandbox.env, { main, realOracle });
  if (main === 'real' || realOracle) sandbox.env.ORACLE_QA_MAIN_KEY = mainKey();
  return [
    host.engine, '--mode', 'rpc', '--offline', '--no-extensions',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
    '--no-approve', '--no-builtin-tools',
    '--extension', host.plugin, '--extension', mockExtension, '--extension', resolve(candidate),
    ...(main === 'real' ? ['--extension', join(ROOT, 'qa/main-provider.mjs')] : []),
    '--session-dir', sandbox.sessionDir, '--session', join(sandbox.sessionDir, 'owned.jsonl'),
    '--provider', main === 'mock' ? 'oracle-qa-mock' : 'ollama',
    '--model', main === 'mock' ? 'main' : 'deepseek-v4.1-flash', '--thinking', 'off',
    '--omo-senpi-memory-disabled', '--omo-senpi-builtin-mcps-disabled',
    '--omo-senpi-config-watch-disabled', '--omo-senpi-model-profile-disabled',
    '--omo-senpi-ulw-loop-disabled', '--omo-senpi-telemetry-disabled',
  ];
}
