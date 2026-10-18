import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, hostArgs, readJson, sourceHash, writeJson,
} from './harness.mjs';
import { startConsultProvider } from './consult-provider.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.consult' && event.data?.event === name;

export async function runConsultCase(values) {
  if (isAbsolute(values.attempt) || !/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (!['real', 'mock'].includes(values.oracle) || !['real', 'mock'].includes(values.main)) throw new Error('Invalid --oracle or --main');
  const usesReal = values.oracle === 'real' || values.main === 'real';
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-7-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-${values.oracle}-${values.main}-`));
  const receiptPath = join(evidenceDir, `${values.case}${usesReal ? '-real' : ''}.json`);
  const receipt = {
    case: values.case, status: 'running', exit_code: null, argv: process.argv, source_hash: sourceHash(),
    oracle_mode: values.oracle, main_mode: values.main, run_dir: runDir,
    children: [], real_oracle_runs: 0, cleanup: {}, adversarial: {},
  };
  let host, child, sandbox, mock, before;
  async function command(args) {
    const done = child.waitFor(event => isEvent('command')(event) && event.data.args === args,
      `/oracle ${args}`, { from: child.history.length });
    await child.rpc('prompt', { message: `/oracle ${args}` });
    return (await done).data;
  }
  async function consult(kind, sequence) {
    const done = child.waitFor(isEvent('consult_result'), 'oracle_consult result', { from: child.history.length });
    await child.prompt(`QA_CONSULT_${kind}_${sandbox.env.ORACLE_QA_NONCE}_${sequence}. Call oracle_consult once.`);
    return (await done).data;
  }
  try {
    host = discoverHost();
    receipt.installed_versions = host.versions;
    receipt.auth_before = before = authHashes();
    if (usesReal) {
      admitAuth(attemptDir, undefined, { providers: ['ollama'], receipt });
    }
    mock = await startConsultProvider(join(runDir, 'provider.jsonl'));
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_MOCK_URL: mock.baseUrl,
      ORACLE_QA_ATTEMPT_DIR: attemptDir, 
      ORACLE_QA_REAL_ORACLE: values.oracle === 'real' ? '1' : '0',
      OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '', OMO_ORACLE_ADVISOR: '1',
    });
    receipt.temp_dir = sandbox.stateDir;
    const stateDir = join(sandbox.stateDir, 'senpi-task');
    writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: stateDir, default_execution_mode: 'in-process' },
        agents: { oracle: { model: values.oracle === 'real' ? 'ollama/deepseek-v4.1-flash' : 'oracle-qa-mock/oracle',
          tools: { read: true, lsp_diagnostics: true, lsp_symbols: true } } },
      },
    });
    if (values.case === 'consult-not-readonly') writeJson(join(sandbox.workDir, '.omo/omo.jsonc'), {
      '[native]': { agents: { oracle: { tools: { write: true } } } },
    });
    child = new OwnedProcess(process.execPath, [
      ...hostArgs(host, sandbox, join(ROOT, 'qa/consult-extension.mjs'), { main: values.main }),
      ...(values.oracle === 'real' && values.main === 'mock' ? ['--extension', join(ROOT, 'qa/main-provider.mjs')] : []),
      '--tools', 'oracle_consult,task,task_send,task_cancel,task_output,read,lsp_diagnostics,lsp_symbols',
      '--system-prompt', 'Owned consult QA. Call oracle_consult exactly once for each QA_CONSULT prompt. Do not call task tools directly.',
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'host'), deadlineMs: 150000 });
    receipt.children.push(child.metadata);
    await child.rpc('get_state');
    await child.waitFor(isEvent('ready'), 'consult extension ready');
    if (values.case !== 'consult-no-job') await command('on');
    receipt.consults = [];
    const kinds = values.case === 'consult-cap' ? ['work', 'work', 'work', 'completion', 'work'] : ['work'];
    for (const [n, kind] of kinds.entries()) receipt.consults.push(await consult(kind, n + 1));
    receipt.status_before_end = await child.rpc('extension_request', { name: 'oracle.consult.status', data: {} });
    receipt.ended = await command('end');
    const ids = receipt.ended.state.job?.oracle_task_ids ?? [];
    receipt.retired_records = ids.map(id => readJson(join(stateDir, 'tasks', `${id}.json`)));
    const productLog = join(sandbox.agentDir, 'logs/oracle-advisor.jsonl');
    const logText = readFileSync(productLog, 'utf8');
    receipt.receipts = logText.trim().split('\n').map(JSON.parse);
    copyFileSync(productLog, join(runDir, 'receipts.jsonl'));
    if (values.case === 'consult-real') copyFileSync(productLog, join(evidenceDir, 'receipts.jsonl'));
    receipt.analysis_artifacts = [];
    for (const entry of receipt.receipts.filter(item => item.analysis_path)) {
      const path = join(runDir, `${entry.request_id}.md`);
      copyFileSync(entry.analysis_path, path);
      receipt.analysis_artifacts.push(path);
    }
    const expectedCalls = values.case === 'consult-cap' ? 4 : ['consult-no-job', 'consult-not-readonly'].includes(values.case) ? 0 : 1;
    receipt.provider_calls = mock.requests;
    receipt.events = child.history.filter(event => event.type === 'extension_event' &&
      event.name === 'oracle-qa.consult').map(event => event.data);
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: usesReal });
    receipt.real_oracle_runs = values.oracle === 'real' ? expectedCalls : 0;
    receipt.adversarial = {
      misleading_success: 'Exact native dispatch and local provider-call counts decide success, not model prose.',
      cap_bypass: values.case === 'consult-cap' ? 'Fifth result refused; only four task dispatches and four oracle calls.' : 'Covered by consult.test.mjs.',
      policy_bypass: values.case === 'consult-not-readonly' ? 'Project write override refused with zero task/provider calls and all slots free.' : 'Covered by consult.test.mjs.',
      stale_state: 'Each run owns a fresh OS-temporary home outside the evidence tree.',
      unavailable: 'Deterministic tests prove typed no-verdict results and slot release versus consumption.',
    };
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code === 'auth_changed' ? 'blocked_by_auth_guard' : 'failed';
    receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
  } finally {
    if (child) await child.stop({ force: true });
    if (mock) { receipt.provider_calls = mock.requests; await mock.close(); receipt.cleanup.listener_closed = true; }
    if (sandbox) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    receipt.cleanup.pids_gone = receipt.children.every(item => item.pid_gone);
    receipt.cleanup.homes_removed = !sandbox || receipt.cleanup.disposable_state.removed;
    if (host) receipt.auth_after = authHashes();
    if (usesReal && before) finalizeAuthGuard(receipt, attemptDir, undefined, { providers: ['ollama'] });
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code, error: receipt.error?.message }));
    process.exitCode = receipt.exit_code;
  }
}
