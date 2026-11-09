import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, OwnedProcess, admitAuth, guardAuth, discoverHost, disposableEnvironment,
  cleanupDisposableState, finalizeAuthGuard, hostArgs, writeJson, typedError,
} from './harness.mjs';
import { startConsultProvider } from './consult-provider.mjs';

const attempt = `atlas-auto-20261105-${Date.now()}`;
const evidence = join(ROOT, '.omo/evidence', attempt);
mkdirSync(evidence, { recursive: true });
const receipt = { sessions: [], exit_code: 1, real_consults: 0 };
const isEvent = name => e => e.type === 'extension_event' &&
  e.name === 'oracle-qa.consult' && e.data?.event === name;
const installed = process.argv.includes('--installed');
if (installed) {
  const entry = process.env.ORACLE_QA_INSTALLED_ENTRY;
  if (!entry || !existsSync(entry)) throw typedError('installed_entry_required',
    'Provide an existing ORACLE_QA_INSTALLED_ENTRY for read-only installed QA.');
  receipt.installed_entry = entry;
}
const host = discoverHost();
const approvedFreshBaseline = process.argv.includes('--acknowledge-prior-auth-change');
if (approvedFreshBaseline) receipt.auth_rebaseline_approval = '#841 owner correction: current credentials, preserve history';
try {
  for (const driver of process.argv.includes('--atlas-only') ? ['atlas'] : ['sisyphus', 'atlas']) {
    if (driver === 'atlas') {
      receipt.auth_before = approvedFreshBaseline
        ? guardAuth(evidence, undefined, { before: true, providers: ['ollama'] })
        : admitAuth(evidence, undefined, { providers: ['ollama'], receipt });
    }
    const directory = join(evidence, driver);
    mkdirSync(directory, { recursive: true });
    const mock = await startConsultProvider(join(directory, 'provider.jsonl'));
    const sandbox = disposableEnvironment(host, directory, {
      ORACLE_QA_ATTEMPT: attempt, ORACLE_QA_ATTEMPT_DIR: evidence,
      ORACLE_QA_AUTO_DRIVER: driver, ORACLE_QA_REAL_ORACLE: '1',
      ORACLE_QA_MOCK_URL: mock.baseUrl, OMO_ORACLE_ADVISOR: '1',
      OMO_ORACLE_AUTO_ATLAS: '1',
      ...(installed ? { ORACLE_QA_INSTALLED_ENTRY: receipt.installed_entry } : {}),
      SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
      OMO_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
    });
    writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: join(sandbox.stateDir, 'senpi-task'), default_execution_mode: 'in-process' },
        agents: { oracle: { model: 'ollama/deepseek-v4.1-flash',
          tools: { read: true, lsp_diagnostics: true, lsp_symbols: true } } },
      },
    });
    let child;
    const row = { driver, preserved_sandbox: installed ? sandbox.stateDir : null,
      agent_dir: sandbox.agentDir, session_dir: sandbox.sessionDir };
    receipt.sessions.push(row);
    try {
    child = new OwnedProcess(process.execPath, [
      ...hostArgs(host, sandbox, join(ROOT, 'qa/auto-atlas-extension.mjs'), { main: 'mock' }),
      '--extension', join(ROOT, 'qa/main-provider.mjs'),
      '--tools', 'oracle_consult,task,task_send,task_cancel,task_output,read,lsp_diagnostics,lsp_symbols',
      '--system-prompt', 'Owned Atlas auto-start acceptance session.',
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(directory, 'host'), deadlineMs: 900000 });
      row.pid = child.metadata.pid;
      await child.rpc('get_state');
      await child.waitFor(isEvent('ready'), 'auto-start session ready', { timeoutMs: 60000 });
      row.before = await child.rpc('extension_request', { name: 'oracle.consult.status', data: {} });
      assert.equal(row.before.state.job?.status ?? null, driver === 'atlas' ? 'active' : null);
      if (driver === 'atlas') {
        const done = child.waitFor(isEvent('consult_result'), 'one real consult response',
          { from: child.history.length, timeoutMs: 900000 });
        receipt.real_consults++;
        await child.prompt(`QA_CONSULT_work_${sandbox.env.ORACLE_QA_NONCE}_1. Call oracle_consult once.`);
        row.consult = (await done).data;
        assert.equal(row.consult.result.details.status, 'answered');
        const ended = child.waitFor(e => isEvent('command')(e) && e.data.args === 'end',
          'retire owned oracle', { from: child.history.length });
        await child.rpc('prompt', { message: '/oracle end' });
        await ended;
        copyFileSync(join(sandbox.agentDir, 'logs/oracle-advisor.jsonl'), join(directory, 'receipts.jsonl'));
      } else {
        const end = child.waitFor(e => e.type === 'agent_end', 'Sisyphus normal turn',
          { from: child.history.length });
        await child.prompt('Hello.');
        await end;
        row.after = await child.rpc('extension_request', { name: 'oracle.consult.status', data: {} });
        assert.equal(row.after.state.job, null);
        assert.equal(row.after.native_calls.length, 0);
      }
      row.passed = true;
    } finally {
      if (child) {
        await child.stop({ force: true });
        row.process = child.metadata;
      }
      await mock.close();
      row.cleanup = installed ? { preserved: true, path: sandbox.stateDir } : cleanupDisposableState(sandbox);
    }
  }
  receipt.exit_code = 0;
} catch (error) {
  receipt.error = { message: error.message, stack: error.stack };
} finally {
  if (receipt.auth_before) finalizeAuthGuard(receipt, evidence, undefined, { providers: ['ollama'] });
  writeJson(join(evidence, 'receipt.json'), receipt);
}
console.log(JSON.stringify({ evidence, exit_code: receipt.exit_code,
  real_consults: receipt.real_consults, error: receipt.error }));
process.exitCode = receipt.exit_code;
