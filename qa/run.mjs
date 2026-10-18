import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import {
  ROOT, OwnedProcess, admitAuth, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, hostArgs, sourceHash, typedError, writeJson,
} from './harness.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { bindFixtureEnvironment } from './host-environment.mjs';

const { values } = parseArgs({
  options: {
    case: { type: 'string' }, attempt: { type: 'string' },
    oracle: { type: 'string', default: 'mock' }, main: { type: 'string', default: 'mock' },
  },
});
if (values.attempt === undefined) {
  const evidence = join(ROOT, '.omo/evidence');
  mkdirSync(evidence, { recursive: true });
  values.attempt = basename(mkdtempSync(join(evidence, 'run-')));
}
if (['acceptance', 'acceptance-oracle-down'].includes(values.case)) {
  await (await import('./cases/acceptance.mjs')).runAcceptanceCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['consult-admission-replay', 'consult-native-rejection'].includes(values.case)) {
  await (await import('./consult-lifecycle-case.mjs')).runConsultLifecycleCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['install-roundtrip', 'install-foreign-shim'].includes(values.case)) {
  await (await import('./install-case.mjs')).runInstallCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['stop-real', 'stop-forged'].includes(values.case)) {
  await (await import('./stop-case.mjs')).runStopCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['nudge-real', 'nudge-inactive'].includes(values.case)) {
  await (await import('./nudger-case.mjs')).runNudgerCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['consult-policy-change', 'consult-cancel-save', 'consult-seed-rebind', 'consult-checkpoint-matrix'].includes(values.case)) {
  await (await import('./consult-checkpoint-case.mjs')).runConsultCheckpointCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['consult-branch-switch-reserved', 'consult-reload-reserved', 'consult-cancel-reserved'].includes(values.case)) {
  await (await import('./consult-reservation-case.mjs')).runConsultReservationCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['consult-real', 'consult-cap', 'consult-not-readonly', 'consult-no-job'].includes(values.case)) {
  await (await import('./consult-case.mjs')).runConsultCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['resident-3', 'resident-dead', 'resident-stuck', 'shutdown-inflight', 'consult-cache-budget',
  'cancel-after-promotion', 'answered-error-words'].includes(values.case)) {
  await (await import('./transport-case.mjs')).runTransportCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['seed-bind', 'seed-invalid'].includes(values.case)) {
  await (await import('./cases/seed.mjs')).runSeedCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['oracle-readonly', 'oracle-write-attempt', 'oracle-consumer-visual',
  'policy-uninstall-after-unrelated-edit', 'oracle-project-override-write', 'oracle-profile-switch'].includes(values.case)) {
  await (await import('./oracle-policy-case.mjs')).runOraclePolicyCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['probe', 'probe-dead-target', 'probe-idle', 'probe-completion'].includes(values.case)) {
  await (await import('./capability-case.mjs')).runCapabilityCase(values);
  process.exit(process.exitCode ?? 0);
}
if (['lifecycle', 'lifecycle-killswitch'].includes(values.case)) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (!['mock', 'real'].includes(values.main)) throw new Error('Invalid --main');
  await (await import('./cases/lifecycle.mjs')).runLifecycle(values);
  process.exit(process.exitCode ?? 0);
}
if (values.case === 'child-entry') {
  await (await import('./cases/child-entry.mjs')).runChildEntry(values);
  process.exit(process.exitCode ?? 0);
}
if (['dossier-real', 'dossier-nonrepo'].includes(values.case)) {
  await (await import(`./cases/${values.case}.mjs`)).run({ attempt: values.attempt });
  process.exit(process.exitCode ?? 0);
}
if (['trigger-real', 'trigger-success-between', 'trigger-real-powershell'].includes(values.case)) {
  if (!['mock', 'real'].includes(values.oracle) || !['mock', 'real'].includes(values.main)) throw new Error('Invalid --oracle or --main');
  await (await import('./triggers-case.mjs')).runTriggerCase(values);
  process.exit(process.exitCode ?? 0);
}
if (!['host-smoke', 'host-missing-ext', 'unrelated-error'].includes(values.case)) throw new Error('Use --case host-smoke|host-missing-ext|unrelated-error');
if (!['mock', 'real'].includes(values.oracle) || !['mock', 'real'].includes(values.main)) throw new Error('Invalid --oracle or --main');
// Names, not arbitrary external paths: keep all evidence and disposable state in this product.
if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
const evidenceDir = join(attemptDir, 'task-1-piomo-oracle-advisor-mod');
mkdirSync(evidenceDir, { recursive: true });
const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
const rawDir = join(runDir, 'raw');
mkdirSync(rawDir);
const receiptPath = join(evidenceDir, `${values.case}.json`);
const authProviders = values.main === 'real' ? ['ollama'] : [];
const receipt = {
  case: values.case, status: 'running', exit_code: null, source_hash: sourceHash(),
  started_at: new Date().toISOString(), attempt_dir: attemptDir, run_dir: runDir,
  loading_mechanism: 'cli-extension-flag', route: 'owned-stdio-rpc',
  main_model: values.main === 'real' ? 'ollama/deepseek-v4.1-flash:off' : 'oracle-qa-mock/main',
  main_route_reason: values.main === 'real'
    ? 'Active native-cmd-glm-deepseek explore/quick physical route, thinking off for this disposable smoke.'
    : 'Scripted zero-cost local main; real engine/provider/tool pipeline.',
  oracle_mode: values.oracle, real_oracle_runs: 0, provider_calls: [],
  children: [], temp_dirs: [], evidence_dirs: [runDir], cleanup: {}, adversarial: {},
};
let host;
let owned;
let mock;
let authBefore;
const sandboxes = [];
receipt.cleanup.disposable_state = [];

function sandboxFor(directory) {
  const sandbox = disposableEnvironment(host, directory, {
    ORACLE_QA_MOCK_URL: mock.baseUrl, ORACLE_QA_ATTEMPT: values.attempt,
  });
  sandboxes.push(sandbox);
  receipt.temp_dirs.push(sandbox.stateDir);
  return sandbox;
}
function removeSandbox(sandbox) {
  if (sandbox.cleaned) return;
  receipt.cleanup.disposable_state.push(cleanupDisposableState(sandbox));
  sandbox.cleaned = true;
}

async function command(command, args, name, options = {}) {
  const env = bindFixtureEnvironment(process.env);
  const child = new OwnedProcess(command === 'git' ? env.ORACLE_QA_GIT : command, args, {
    cwd: ROOT, env, rawPrefix: join(rawDir, name), ...options,
  });
  receipt.children.push(child.metadata);
  child.child.stdin.end();
  await child.exit;
  await child.stop();
  return child;
}
const probeEvents = process => process.history
  .filter(event => event.type === 'extension_event' && event.name === 'oracle-qa.probe')
  .map(event => event.data);
const isProbe = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.probe' && event.data.event === name;

async function adversarialChecks() {
  const misleading = await command(process.execPath, [join(ROOT, 'qa/owned-process-fixture.mjs'), 'misleading-success'], 'misleading-success');
  assert.equal(misleading.metadata.exit_code, 7);
  receipt.adversarial.misleading_success = {
    result: 'passed', stdout: misleading.stdout.trim(), exit_code: 7,
    rule: 'Human success text cannot pass the exit-code and receipt checks.',
  };
  // A live server keeps the command running without a sleep or a polling loop.
  const deadline = new OwnedProcess(process.execPath, [join(ROOT, 'qa/owned-process-fixture.mjs'), 'hang'], {
    cwd: runDir, rawPrefix: join(rawDir, 'owned-deadline'), deadlineMs: 250,
  });
  receipt.children.push(deadline.metadata);
  await deadline.exit;
  await deadline.stop();
  assert.equal(deadline.metadata.timed_out, true);
  receipt.adversarial.hung_long_command = { result: 'passed', ...deadline.metadata };

  const cancelDir = mkdtempSync(join(runDir, 'cancel-'));
  receipt.evidence_dirs.push(cancelDir);
  const cancelSandbox = sandboxFor(cancelDir);
  const cancel = new OwnedProcess(process.execPath,
    hostArgs(host, cancelSandbox, join(ROOT, 'qa/probe-extension.mjs'), { main: 'mock' }),
    { cwd: cancelSandbox.workDir, env: cancelSandbox.env, rawPrefix: join(rawDir, 'cancel-host') });
  receipt.children.push(cancel.metadata);
  try {
    await cancel.rpc('get_state');
    await cancel.waitFor(isProbe('session_start'), 'cancel host started');
    const admitted = cancel.waitFor(isProbe('provider_request'), 'cancel prompt reached provider', { from: cancel.history.length });
    const pending = cancel.prompt('QA_CANCEL_HANG: cancellation fixture.');
    pending.catch(() => {});
    await admitted;
    const streamingState = await cancel.rpc('get_state');
    assert.equal(streamingState.isStreaming, true);
    await cancel.stop({ force: true });
    await pending.catch(() => {});
    receipt.adversarial.cancel_resume = {
      killed_pid: cancel.metadata.pid, killed_pid_gone: cancel.metadata.pid_gone,
      streaming_before_kill: streamingState.isStreaming,
    };
  } finally { await cancel.stop({ force: true }); removeSandbox(cancelSandbox); }
  const resumeDir = mkdtempSync(join(runDir, 'resume-'));
  receipt.evidence_dirs.push(resumeDir);
  const resumeSandbox = sandboxFor(resumeDir);
  const resume = new OwnedProcess(process.execPath,
    hostArgs(host, resumeSandbox, join(ROOT, 'qa/probe-extension.mjs'), { main: 'mock' }),
    { cwd: resumeSandbox.workDir, env: resumeSandbox.env, rawPrefix: join(rawDir, 'resume-host') });
  receipt.children.push(resume.metadata);
  try {
    const state = await resume.rpc('get_state');
    await resume.waitFor(isProbe('session_start'), 'fresh resumed host started');
    receipt.adversarial.cancel_resume.new_session_id = state.sessionId;
    receipt.adversarial.stale_state = {
      result: 'passed', fresh_dirs: [cancelSandbox.stateDir, resumeSandbox.stateDir], reused_state: false,
      session_ids: [probeEvents(cancel).find(event => event.event === 'session_start').session_id, state.sessionId],
    };
  } finally { await resume.stop({ force: true }); removeSandbox(resumeSandbox); }
  receipt.adversarial.cancel_resume.result = 'passed';
}

try {
  host = discoverHost();
  receipt.host = host;
  receipt.installed_versions = host.versions;
  receipt.main_credential_source = values.main === 'real' ? 'live-auth-readonly-via-environment-path' : 'local-mock';
  // The stable launcher is guarded to its live root. Help is read-only; execution
  // uses the exact same installed engine + pinned plugin with isolated roots.
  const help = await command(process.execPath, [host.launcher, '--help'], 'launcher-help');
  assert.equal(help.metadata.exit_code, 0, 'installed launcher --help');
  if (!/--extension,\s*-e\s*<path>/.test(help.stdout)) throw typedError('extension_loading_unavailable');
  receipt.launcher_help = help.metadata;
  authBefore = admitAuth(attemptDir, undefined, { real: values.main === 'real', providers: authProviders, receipt });
  receipt.auth_before = authBefore;
  mock = await startMockProvider();
  const sandbox = sandboxFor(runDir);
  // Working hook for later native task(oracle) cases: a disposable config points
  // the oracle at the local fixture; no live config or credential is copied.
  writeJson(join(sandbox.home, '.omo', 'omo.json'), {
    '[native]': { agents: { oracle: { model: values.oracle === 'mock' ? 'oracle-qa-mock/oracle' : 'chatgpt-subscription/gpt-6.1-sol' } } },
  });
  const candidate = join(ROOT, 'qa/probe-extension.mjs');
  const loadingPath = values.case === 'host-missing-ext' ? join(runDir, 'missing-extension.mjs') : candidate;
  const args = [...hostArgs(host, sandbox, loadingPath, { main: values.main }),
    '--tools', 'qa_probe_tool',
    '--system-prompt', 'Follow the exact QA prompt. Use only the requested probe tool, then answer briefly.',
  ];
  if (values.case === 'unrelated-error') args[args.indexOf('--model') + 1] = 'oracle-qa-nonexistent-model';
  owned = new OwnedProcess(process.execPath, args, {
    cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(rawDir, 'host'),
  });
  receipt.children.push(owned.metadata);
  receipt.argv = owned.metadata.argv;
  receipt.pid = owned.metadata.pid;
  await owned.rpc('get_state');
  const surfaces = await owned.rpc('get_loaded_surfaces');
  receipt.loaded_surfaces = surfaces;
  const loaded = surfaces.extensions.some(extension => resolve(extension.path).toLowerCase() === resolve(loadingPath).toLowerCase());
  if (!loaded || values.case === 'host-missing-ext') {
    throw typedError('extension_not_loaded', `Candidate extension absent from loaded surfaces: ${loadingPath}`);
  }
  const started = await owned.waitFor(isProbe('session_start'), 'candidate load receipt');
  assert.equal(started.data.loading_mechanism, 'cli-extension-flag');
  const initial = await owned.rpc('get_state');
  const commandReceipt = owned.waitFor(isProbe('command'), 'registered command');
  await owned.rpc('prompt', { message: '/qa_probe owned-command' });
  assert.equal((await commandReceipt).data.args, 'owned-command');
  const marker = `QA_TOOL_${sandbox.env.ORACLE_QA_NONCE}`;
  const called = owned.waitFor(isProbe('tool'), 'model calls candidate tool');
  await owned.prompt(`Call qa_probe_tool exactly once with marker "${marker}", then reply with "first prompt complete". Use no other tool.`);
  assert.equal((await called).data.marker, marker);
  await owned.prompt('This is the second prompt. Reply only "second prompt complete"; do not call a tool.');
  const final = await owned.rpc('get_state');
  assert.equal(final.sessionId, initial.sessionId);
  const messages = await owned.rpc('get_messages');
  const userMessages = messages.messages.filter(message => message.role === 'user');
  assert.equal(userMessages.length, 2);
  const errors = messages.messages.filter(message => message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason));
  if (errors.length) throw typedError('provider_error', errors.map(message => message.errorMessage ?? message.stopReason).join('; '));
  const after = owned.history.length;
  const reloaded = owned.waitFor(isProbe('session_start'), 'reload re-runs session_start', { from: after });
  receipt.reload_response = await owned.rpc('reload');
  assert.equal((await reloaded).data.session_id, started.data.session_id);
  receipt.proofs = {
    extension_loaded: true, command_ran: true, prompt_count: userMessages.length,
    same_session: true, model_called_candidate_tool: true, reload_session_start: true,
    session_id: initial.sessionId,
  };
  assert.equal(owned.closed, false, 'host must remain alive through all proofs');
  // Proofs are complete; end only this owned tree rather than depending on
  // installed plugin shutdown hooks. The planned termination is recorded.
  await owned.stop({ force: true });
  receipt.proofs.expected_owned_termination = owned.metadata.termination_reason;
  removeSandbox(sandbox);
  await adversarialChecks();
  receipt.status = 'passed';
  receipt.exit_code = 0;
} catch (error) {
  receipt.status = error.code ?? 'failed';
  receipt.error = { type: error.code ?? 'assertion_failed', message: error.message };
  receipt.exit_code = 1;
} finally {
  if (owned) {
    try { await owned.stop({ force: true }); } catch (error) {
      receipt.cleanup.error = error.message;
      receipt.exit_code = 1;
    }
    receipt.provider_calls = probeEvents(owned).filter(event => event.event === 'provider_request')
      .map(({ provider, model, session_id }) => ({ provider, model, session_id }));
    receipt.real_provider_calls = receipt.provider_calls.filter(call => call.provider !== 'oracle-qa-mock').length;
    receipt.probe_receipts = probeEvents(owned);
    receipt.host_exit_code = owned.metadata.exit_code;
    receipt.raw_output = owned.metadata.raw_output;
  }
  if (mock) {
    receipt.mock_provider_calls = mock.requests;
    await mock.close();
    receipt.cleanup.mock_listener_closed = true;
  }
  if (receipt.children.every(child => !child.pid || child.pid_gone)) {
    try { for (const sandbox of sandboxes) removeSandbox(sandbox); } catch (error) {
      receipt.cleanup.state_error = error.message;
      receipt.exit_code = 1;
    }
  }
  if (host && authBefore) {
    finalizeAuthGuard(receipt, attemptDir, undefined, { providers: authProviders });
  }
  writeJson(join(runDir, 'receipt.json'), receipt);
  writeJson(receiptPath, receipt);
  const git = await command('git', ['--no-optional-locks', 'status', '--short'], 'git-status');
  receipt.adversarial.dirty_worktree = {
    result: 'recorded', new_repo: true, status: git.stdout.trim(), exit_code: git.metadata.exit_code,
  };
  receipt.adversarial.other_classes = 'Not applicable: installer drift, STOP gates, oracle revival, task ownership and coexistence belong to later todos.';
  receipt.cleanup.all_owned_pids_gone = receipt.children.every(child => child.pid_gone);
  if (!receipt.cleanup.all_owned_pids_gone) receipt.exit_code = 1;
  receipt.finished_at = new Date().toISOString();
  writeJson(join(runDir, 'receipt.json'), receipt); // Keep failed runs even when the named case is rerun.
  writeJson(receiptPath, receipt);
  const hostDoc = readFileSync(join(ROOT, 'qa/HOST.md'), 'utf8');
  writeFileSync(join(evidenceDir, 'HOST.md'), hostDoc);
  console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code, pid: receipt.pid, pid_gone: receipt.cleanup.all_owned_pids_gone }));
  process.exitCode = receipt.exit_code;
}
