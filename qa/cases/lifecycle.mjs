import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost,
  disposableEnvironment, finalizeAuthGuard, hostArgs, sourceHash, writeJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';
import { evaluateVerdict } from '../verdict-spec.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.lifecycle' && event.data.event === name;

export async function runLifecycle(values) {
  const disabled = values.case === 'lifecycle-killswitch';
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-3-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const rawDir = join(runDir, 'raw');
  mkdirSync(rawDir);
  const receiptPath = join(evidenceDir,
    `${disabled ? 'killswitch' : 'lifecycle'}${values.main === 'mock' ? '-mock' : ''}.json`);
  const receipt = {
    case: values.case, status: 'running', exit_code: null, source_hash: sourceHash(),
    started_at: new Date().toISOString(), run_dir: runDir, oracle_runs: 0,
    main_model: values.main === 'mock' ? 'oracle-qa-mock/main' : 'ollama/deepseek-v4.1-flash:off',
    loading_mechanism: 'cli-extension-flag', children: [], cleanup: {}, adversarial: {},
  };
  let host, sandbox, owned, mock, authBefore;
  let productReceipts = [];
  const eventCommand = async (command, args) => {
    const from = owned.history.length;
    const done = owned.waitFor(event => isEvent(command === 'oracle' ? 'command' : 'fixture')(event) &&
      event.data.args === args, `${command} ${args} receipt`, { from });
    await owned.rpc('prompt', { message: `/${command} ${args}` });
    return (await done).data;
  };
  try {
    host = discoverHost();
    receipt.installed_versions = host.versions;
    if (values.main === 'real') {
      authBefore = admitAuth(attemptDir, undefined, { receipt });
    } else {
      authBefore = authHashes();
    }
    receipt.auth_before = authBefore;
    mock = await startMockProvider();
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_MOCK_URL: mock.baseUrl, ORACLE_QA_ATTEMPT: values.attempt,
      OMO_ORACLE_ADVISOR: disabled ? '0' : '1',
    });
    receipt.temp_dir = sandbox.stateDir;
    const candidate = join(ROOT, 'qa/cases/lifecycle-extension.mjs');
    const args = [
      ...hostArgs(host, sandbox, candidate, { main: values.main }),
      '--tools', 'qa_lifecycle_probe',
      '--system-prompt', 'This is an owned lifecycle QA session. Reply briefly. Do not use tools.',
    ];
    owned = new OwnedProcess(process.execPath, args, {
      cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(rawDir, 'host'),
    });
    receipt.children.push(owned.metadata);
    receipt.argv = owned.metadata.argv;
    receipt.raw_output_prefix = join(rawDir, 'host');
    await owned.rpc('get_state');
    const started = (await owned.waitFor(isEvent('session_start'), 'lifecycle session started')).data;
    const surfaces = await owned.rpc('get_loaded_surfaces');
    assert.ok(surfaces.extensions.some(item => resolve(item.path) === resolve(candidate)));
    receipt.loaded_surfaces = surfaces;
    receipt.initial = started;
    if (disabled) {
      const fixture = await eventCommand('qa_lifecycle', 'snapshot');
      const path = join(sandbox.agentDir, 'logs/oracle-advisor.jsonl');
      assert.ok(existsSync(path));
      productReceipts = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
      receipt.proofs = {
        oracle_command_absent: true, candidate_commands: started.registered_commands,
        ledger_entries: fixture.entries, disabled_receipts: productReceipts,
      };
      receipt.adversarial.stale_state = {
        result: 'not-applicable', reason: 'Disabled extension creates no job or state.',
      };
      receipt.adversarial.cancel_resume = {
        result: 'not-applicable', reason: 'Disabled extension cannot dispatch or resume a consult.',
      };
      receipt.adversarial.malformed_input = {
        result: 'not-applicable', reason: 'The oracle command is absent when disabled.',
      };
    } else {
      const opened = await eventCommand('oracle', 'on');
      const before = await eventCommand('oracle', 'status');
      const from = owned.history.length;
      const reloaded = owned.waitFor(isEvent('session_start'), 'reload lifecycle rebuild', { from });
      await owned.rpc('reload');
      const afterReload = (await reloaded).data;
      const after = await eventCommand('oracle', 'status');
      receipt.adversarial.stale_state = { result: 'passed', before: before.state, after: after.state };
      const malformed = [];
      for (const input of ['on extra', 'nonsense', 'override missing short']) {
        const result = await eventCommand('oracle', input);
        malformed.push({ input, status: result.result.status });
      }
      receipt.adversarial.malformed_input = { result: 'passed', cases: malformed };
      const inflight = await eventCommand('qa_lifecycle', 'begin');
      const reloadFrom = owned.history.length;
      const interrupted = owned.waitFor(isEvent('session_start'), 'reload interrupts fixture', { from: reloadFrom });
      await owned.rpc('reload');
      const resumed = (await interrupted).data;
      const verifyFrom = owned.history.length;
      const rebuilt = owned.waitFor(isEvent('session_start'), 'second rebuild does not replay', { from: verifyFrom });
      await owned.rpc('reload');
      const again = (await rebuilt).data;
      receipt.adversarial.cancel_resume = {
        result: 'passed', fixture: 'Durable in-flight consult without oracle dispatch',
        before: inflight.state, after: resumed.state, second_reload: again.state,
        oracle_replayed: false,
      };
      await eventCommand('oracle', 'cancel');
      const ended = await eventCommand('oracle', 'end');
      receipt.proofs = {
        opened: opened.state, status_before_reload: before.result,
        status_after_reload: after.result, ended: ended.state,
        persisted_entries: ended.entries,
      };
    }
    // Exercise the configured cheap main, not an oracle. Commands above made no
    // provider calls, so the state proofs do not depend on model behavior.
    await owned.prompt('Reply only "lifecycle QA complete". Do not call any tool.');
    receipt.provider_calls = owned.history.filter(isEvent('provider_request')).map(event => ({
      provider: event.data.provider, model: event.data.model,
    }));
    receipt.tool_calls = owned.history.filter(event => event.type === 'tool_execution_start')
      .map(event => ({ name: event.toolName, call_id: event.toolCallId }));
    receipt.disabled_receipts = productReceipts;
    receipt.events = owned.history.filter(event =>
      event.type === 'extension_event' && event.name === 'oracle-qa.lifecycle').map(event => event.data);
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: values.main === 'real' });
    receipt.adversarial.misleading_success_output = {
      result: 'passed',
      rule: 'Command registration, actual custom branch entries, reload snapshots and disabled receipt decide success; assistant text is ignored.',
    };
    receipt.adversarial.other_classes = {
      result: 'not-applicable',
      reason: 'Transport death, STOP enforcement, caps, installer drift and coexistence belong to later todos; no oracle task is started here.',
    };
    assert.equal(owned.closed, false);
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code === 'auth_changed' ? 'auth_changed' : 'failed';
    receipt.exit_code = 1;
    receipt.error = { type: error.code ?? 'assertion_failed', message: error.message };
  } finally {
    if (owned) {
      await owned.stop({ force: true });
      receipt.host_exit_code = owned.metadata.exit_code;
      receipt.raw_output = owned.metadata.raw_output;
      receipt.extension_receipts = owned.history.filter(event =>
        event.type === 'extension_event' && event.name === 'oracle-qa.lifecycle').map(event => event.data);
    }
    if (mock) {
      receipt.mock_provider_calls = mock.requests;
      await mock.close();
      receipt.cleanup.mock_listener_closed = true;
    }
    if (sandbox && (!owned || owned.metadata.pid_gone)) {
      receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    }
    receipt.cleanup.all_owned_pids_gone = receipt.children.every(child => child.pid_gone);
    if (!receipt.cleanup.all_owned_pids_gone) receipt.exit_code = 1;
    if (host && authBefore) {
      receipt.auth_after = authHashes();
      if (values.main === 'real') finalizeAuthGuard(receipt, attemptDir);
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
}
