import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost, disposableEnvironment,
  guardAuth, hostArgs, readJson, sourceHash, typedError, writeJson,
} from './harness.mjs';
import { startTransportProvider } from './transport-provider.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.transport' && event.data?.event === name;
const terminal = task => ['completed', 'failed', 'error', 'lost', 'cancelled', 'interrupted', 'timed_out'].includes(task.status);

export async function runTransportCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (!['real', 'mock'].includes(values.oracle) || !['real', 'mock'].includes(values.main)) throw new Error('Invalid --oracle or --main');
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-6-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-${values.oracle}-${values.main}-`));
  const usesReal = values.oracle === 'real' || values.main === 'real';
  const receiptPath = join(evidenceDir, `${values.case}${usesReal
    ? values.oracle === 'real' ? '-real-blocked' : '-real-main-blocked' : ''}.json`);
  const receipt = { case: values.case, status: 'running', exit_code: null, argv: process.argv,
    source_hash: sourceHash(), oracle_mode: values.oracle, main_mode: values.main, run_dir: runDir,
    real_oracle_runs: 0, children: [], cleanup: {}, blocked_by_auth_guard: [], adversarial: {},
  };
  const oracleAnswers = values.case === 'answered-error-words' ? [
    'CONTINUE safely.',
    'The read-only logs show no resident session; avoid reusing it.',
    'The change handles HTTP 429 quota responses correctly.',
    'Keep provider stream timeout handling unchanged.',
  ].map(analysis => `${analysis}\n{"verdict":"CONTINUE","reasons":[]}`) : [];
  let host, sandbox, child, mock, taskState, before;
  let sequence = 0;
  let pending;
  const request = (name, data = {}) => child.rpc('extension_request', { name: `oracle.transport.${name}`, data });
  async function command(args, timeoutMs = 45000) {
    const done = child.waitFor(event => isEvent('command')(event) && event.data.args === args,
      `/oracle ${args}`, { from: child.history.length, timeoutMs });
    await child.rpc('prompt', { message: `/oracle ${args}` });
    return (await done).data;
  }
  async function consult({ hold = false, shutdown = false, cache = false, esc = false, cancel = false } = {}) {
    const from = child.history.length;
    const result = child.waitFor(isEvent('consult_result'), 'transport consult result', { from });
    const held = hold ? once(mock.events, 'held', { signal: AbortSignal.timeout(25000) }) : null;
    held?.catch(() => {});
    const promoted = cache ? child.waitFor(isEvent('native_task_returned'), 'foreground background promotion', { from }) : null;
    pending = child.prompt(`QA_TRANSPORT_RUN_${sandbox.env.ORACLE_QA_NONCE}_${++sequence} ${hold ? 'QA_TRANSPORT_HOLD' : ''}. Call qa_transport_run exactly once, then answer.`);
    pending.catch(() => {});
    if (hold) {
      const [admitted] = await held;
      await request('provider_hold', admitted);
      let closed;
      if (cache) {
        receipt.promotion_event = (await promoted).data;
        (receipt.promotion_events ??= []).push(receipt.promotion_event);
        if (cancel || esc || shutdown) {
          closed = once(mock.events, 'closed', { signal: AbortSignal.timeout(15000) });
          closed.catch(() => {});
        } else {
          mock.release(admitted.index);
          receipt.fixture_releases = (receipt.fixture_releases ?? 0) + 1;
        }
      }
      if (shutdown) {
        await request('shutdown').catch(error => { if (!child.closed) throw error; });
        await child.exit;
        // RPC detaches its event sink before shutdown handlers finish. The
        // observer writes synchronously before emitting, so its durable receipt
        // proves the real hook after the owned process's close event.
        const persisted = readFileSync(sandbox.env.ORACLE_QA_PROBE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
        receipt.shutdown_event = persisted.findLast(event => event.event === 'shutdown_complete');
        const observed = persisted.findLast(event => event.event === 'consult_result');
        receipt.shutdown_consult_result = observed;
        await pending.catch(error => { receipt.shutdown_prompt_error = { code: error.code, message: error.message }; });
        pending = null;
        if (closed) await closed;
        return observed;
      } else if (esc) {
        await child.rpc('abort');
      } else if (cancel || !cache) {
        receipt.cancel_command = await command('cancel', cache ? 3000 : 45000);
        if (cache) receipt.cancel_completed_before_release = true;
      }
      if (closed) await closed;
    }
    const observed = (await result).data;
    await pending.catch(error => {
      if (!shutdown && !esc) throw error;
      receipt.shutdown_prompt_error = { code: error.code, message: error.message };
    });
    pending = null;
    return observed;
  }
  try {
    if (['resident-stuck', 'shutdown-inflight', 'consult-cache-budget', 'cancel-after-promotion'].includes(values.case) &&
      values.oracle !== 'mock') {
      throw typedError('scenario_requires_controlled_oracle',
        `${values.case} requires --oracle mock to observe a controlled local provider hold; --main may be real or mock.`);
    }
    host = discoverHost();
    receipt.installed_versions = host.versions;
    receipt.auth_hashes_observed = authHashes();
    if (usesReal) {
      before = admitAuth(attemptDir, undefined, { receipt });
    } else before = authHashes();
    receipt.auth_before = before;
    mock = await startTransportProvider(join(runDir, 'provider.jsonl'), [...oracleAnswers]);
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_MOCK_URL: mock.baseUrl,
      ORACLE_QA_REAL_ORACLE: values.oracle === 'real' ? '1' : '0',
      ORACLE_QA_ATTEMPT_DIR: attemptDir, 
      OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '', OMO_ORACLE_ADVISOR: '1',
    });
    taskState = join(sandbox.stateDir, 'senpi-task');
    receipt.temp_dir = sandbox.stateDir;
    writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: taskState, default_execution_mode: 'in-process' },
        agents: { oracle: { model: values.oracle === 'real' ? 'ollama/deepseek-v4.1-flash' : 'oracle-qa-mock/oracle',
          tools: { read: true, lsp_diagnostics: true, lsp_symbols: true } } },
      },
    });
    if (['consult-cache-budget', 'cancel-after-promotion'].includes(values.case)) {
      const settings = readJson(join(sandbox.agentDir, 'settings.json'));
      settings.promptCache = { safetyBufferSeconds: 299 };
      writeJson(join(sandbox.agentDir, 'settings.json'), settings);
      receipt.prompt_cache = settings.promptCache;
    }
    const args = [...hostArgs(host, sandbox, join(ROOT, 'qa/transport-extension.mjs'), { main: values.main }),
      ...(values.oracle === 'real' && values.main === 'mock' ? ['--extension', join(ROOT, 'qa/main-provider.mjs')] : []),
      '--tools', 'qa_transport_run,oracle_consult,task,task_send,task_cancel,task_output,read,lsp_diagnostics,lsp_symbols',
      '--system-prompt', 'Use qa_transport_run exactly once for each QA_TRANSPORT_RUN prompt. Do not call native task tools directly.'];
    child = new OwnedProcess(process.execPath, args, { cwd: sandbox.workDir, env: sandbox.env,
      rawPrefix: join(runDir, 'host'), deadlineMs: 150000 });
    receipt.children.push(child.metadata);
    await child.rpc('get_state');
    const ready = (await child.waitFor(isEvent('ready'), 'transport extension ready')).data;
    receipt.decision = ready.decision;
    await command('on');
    receipt.consults = [];
    if (values.case === 'resident-3') {
      for (let n = 0; n < 3; n++) receipt.consults.push(await consult());
    } else if (values.case === 'resident-dead') {
      receipt.consults.push(await consult());
      receipt.dead_target = await request('dead');
      receipt.consults.push(await consult());
    } else if (values.case === 'resident-stuck') {
      receipt.variant = 'fresh-only: normal answer, then never-completing run cancelled by /oracle cancel';
      receipt.consults.push(await consult());
      receipt.consults.push(await consult({ hold: true }));
      receipt.consults.push(await consult({ hold: true, esc: true }));
    } else if (values.case === 'shutdown-inflight') {
      receipt.consults.push(await consult({ hold: true, shutdown: true }));
    } else if (values.case === 'consult-cache-budget') {
      receipt.consults.push(await consult({ hold: true, cache: true }));
    } else if (values.case === 'cancel-after-promotion') {
      receipt.consults.push(await consult({ hold: true, cache: true, cancel: true }));
      receipt.after_cancel = await request('status');
      receipt.consults.push(await consult({ hold: true, cache: true, esc: true }));
      receipt.consults.push(await consult({ hold: true, cache: true, shutdown: true }));
    } else if (values.case === 'answered-error-words') {
      for (const answer of oracleAnswers) {
        const result = await consult();
        receipt.consults.push(result);
      }
    } else throw new Error(`Unknown transport case ${values.case}`);
    if (!child.closed) {
      receipt.status_command = await command('status');
      // Custom status text is product output, not model recollection.
      receipt.status_message = child.history.filter(isEvent('visible'))
        .map(event => event.data.message).findLast(message => message?.customType === 'oracle-advisor-status');
      receipt.before_end = await request('status');
      receipt.ended = await command('end');
      await child.stop({ force: true });
    }
    const ids = (receipt.ended?.state ?? receipt.shutdown_event?.state).job.oracle_task_ids;
    receipt.retired_records = ids.map(id => readJson(join(taskState, 'tasks', `${id}.json`)));
    receipt.cleanup.running_oracle_records = receipt.retired_records.filter(task => !terminal(task)).length;
    receipt.cleanup.resident_sessions = receipt.retired_records.filter(task =>
      task.residency_state === 'resident' || task.resident || task.resident_session || task.resident_handle).length;
    receipt.mock_provider_calls = mock.requests;
    receipt.oracle_answers = oracleAnswers;
    receipt.events = readFileSync(sandbox.env.ORACLE_QA_PROBE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: usesReal });
    receipt.adversarial = {
      misleading_success: 'Native snapshots, durable records, path, exact provider call count and PID absence decide success.',
      stale_state: 'Fresh disposable state root for this run; each spawn dossier includes prior verdict ids.',
      hung_command: values.case === 'resident-stuck' ? 'Never-ending oracle ended by /oracle cancel, not a product deadline.' : 'Owned harness has a 150-second cleanup deadline.',
      cancel_resume: values.case === 'resident-stuck' || values.case === 'shutdown-inflight' ? 'Cancellation observed, no additional oracle call.' : 'Covered by deterministic transport tests.',
      native_refusals: 'Unit tests include isError=false lane_capacity, not_continuable, not_found and no-resident-session.',
    };
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code === 'auth_changed' ? 'blocked_by_auth_guard' : 'failed';
    receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
    if (error.code === 'auth_changed') receipt.blocked_by_auth_guard.push({
      case: values.case, code: error.code, message: error.message,
      blocking_attempt: receipt.blocking_auth_attempt, oracle_mode: values.oracle, main_mode: values.main,
    });
  } finally {
    if (child) {
      await child.stop({ force: true });
      if (pending) await pending.catch(() => {});
      const log = sandbox?.env.ORACLE_QA_PROBE_LOG;
      receipt.event_log_path = log;
      receipt.events = log && existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : child.history.filter(event => event.type === 'extension_event' && event.name === 'oracle-qa.transport')
          .map(event => event.data);
    }
    if (mock) { receipt.mock_provider_calls = mock.requests; await mock.close(); receipt.cleanup.listener_closed = true; }
    if (sandbox) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    receipt.cleanup.pids_gone = receipt.children.every(child => child.pid_gone);
    receipt.cleanup.homes_removed = !sandbox || receipt.cleanup.disposable_state.removed;
    if (host) receipt.auth_after = authHashes();
    if (usesReal && before) {
      try { guardAuth(attemptDir); }
      catch (error) {
        receipt.status = 'blocked_by_auth_guard'; receipt.exit_code = 1;
        receipt.blocked_by_auth_guard.push({ case: values.case, code: error.code, message: error.message });
      }
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code,
      error: receipt.error?.message }));
    process.exitCode = receipt.exit_code;
  }
}
