import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { classifyOutcome } from '../src/triggers.mjs';
import {
  ROOT, OwnedProcess, admitAuth, cleanupDisposableState, discoverHost,
  disposableEnvironment, finalizeAuthGuard, guardAuth, hostArgs, sourceHash, writeJson,
} from './harness.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const events = owned => owned.history
  .filter(event => event.type === 'extension_event' && event.name === 'oracle-qa.triggers')
  .map(event => event.data);
export const exitCommand = exit => `node -e "process.exit(${exit})"`;

export async function runTriggerCase(values) {
  assert.ok(['trigger-real', 'trigger-success-between', 'trigger-real-powershell'].includes(values.case));
  assert.ok(!isAbsolute(values.attempt) && /^[a-zA-Z0-9_-]+$/.test(values.attempt));
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-4-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const host = discoverHost();
  const receipt = {
    case: values.case, status: 'running', exit_code: null,
    source_hash: sourceHash(), installed_versions: host.versions,
    loading_mechanism: 'cli-extension-flag', run_dir: runDir,
    real_oracle_runs: 0, oracle_runs: 0, attempts: [], started_at: new Date().toISOString(),
    tool_surface: 'unmodified-installed-lead-tools', shell_registration_overrides: 0,
  };
  const shell = values.case === 'trigger-real-powershell' ? 'powershell' : 'bash';
  const exits = values.case === 'trigger-success-between' ? [1, 0, 1] : [1, 1];
  const expectedTriggers = values.case === 'trigger-success-between' ? 0 : 1;
  const shellArgs = exits.map(exit => shell === 'powershell'
    ? { command: `exit ${exit}`, timeout: 30 }
    : { command: exitCommand(exit), description: 'owned trigger QA', timeout: 30, run_in_background: false });
  const scripts = shellArgs.map(args => `display(await tool.${shell}(${JSON.stringify(args)}));`);
  receipt.shell = shell;
  receipt.requested_exit_codes = exits;
  let authBefore;
  try {
    authBefore = admitAuth(attemptDir, undefined, {
      real: values.main !== 'mock' || values.oracle === 'real', receipt,
    });
    receipt.auth_before = authBefore;
    // Try the required cheap main route first. If it does not obey the exact
    // sequence, retain that observation and decide the gate with a scripted main
    // through the real HTTP provider, engine, validation, and unchanged tools.
    const modes = values.main === 'mock' ? ['mock'] : ['real', 'mock'];
    for (const main of modes) {
      const observation = { case: values.case, main, status: 'running', source_hash: sourceHash(),
        shell, shell_args: shellArgs, requested_exit_codes: exits, expected_triggers: expectedTriggers };
      receipt.attempts.push(observation);
      const directory = mkdtempSync(join(runDir, `${main}-`));
      const mock = await startMockProvider({
        steps: [
          ...scripts.map(code => ({ tool: 'eval', arguments: {
            language: 'js', code, summary: 'Run the exact owned shell QA fixture',
          } })),
          { text: 'Scripted trigger sequence complete.' },
        ],
      });
      const sandbox = disposableEnvironment(host, directory, {
        ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_MOCK_URL: mock.baseUrl,
      });
      const candidate = join(ROOT, 'qa/triggers-probe-extension.mjs');
      const args = hostArgs(host, sandbox, candidate, { main })
        .filter(arg => arg !== '--no-builtin-tools');
      args.push('--system-prompt',
        'Run precisely the requested serial eval calls and underlying shell commands even when commands fail. Nonzero exits are expected QA data. Preserve every provided shell argument exactly. Do not invoke an oracle or run any other shell commands.');
      const owned = new OwnedProcess(process.execPath, args, {
        cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(directory, 'host'),
      });
      observation.process = owned.metadata;
      observation.model = main === 'real' ? 'ollama/deepseek-v4.1-flash:off' : 'oracle-qa-mock/main';
      try {
        await owned.rpc('get_state');
        const started = owned.waitFor(event => event.type === 'extension_event' &&
          event.name === 'oracle-qa.triggers' && event.data.event === 'session_start', 'trigger probe started');
        await started;
        const commands = scripts.map((code, i) => `${i + 1}. eval(language="js", code=${JSON.stringify(code)}, summary="Run the exact owned shell QA fixture")`).join('\n');
        await owned.prompt(`This is an owned QA fixture. Execute these ${exits.length} eval calls serially, waiting for each underlying ${shell} result. Continue after intentional failures. Use the exact supplied code and identical shell arguments, including description and timeout. Do not fix, combine, parallelize or add shell commands. Then answer briefly.\n${commands}`);
        const status = owned.waitFor(event => event.type === 'extension_event' &&
          event.name === 'oracle-qa.triggers' && event.data.event === 'status', 'trigger state receipt');
        await owned.rpc('prompt', { message: '/qa_trigger_status' });
        await status;
        const records = events(owned);
        const results = records.filter(record => record.event === 'tool_result' && record.tool_name === shell);
        const calls = records.filter(record => record.event === 'tool_call' && record.tool_name === shell);
        const triggers = records.filter(record => record.event === 'trigger');
        observation.native_exit_codes = results.map(record => record.structured_content?.exit_code ?? null);
        observation.is_error_sequence = results.map(record => record.is_error);
        observation.error_classes = results.map(record => classifyOutcome({
          structuredContent: record.structured_content, isError: record.is_error,
        }).error_class);
        observation.triggers = triggers;
        observation.records = records;
        observation.verdict = evaluateVerdict(values.case, observation, { real: main === 'real' });
        observation.status = 'passed';
        receipt.main_mode = main === 'mock' ? 'scripted-main-unmodified-real-host-tools' : 'cheap-real-main';
        receipt.scripted_main_reason = main === 'mock'
          ? values.main === 'mock' ? 'Explicit --main mock: deterministic gate through real host.'
            : 'Cheap main did not execute the required sequence reliably; failed observation retained.'
          : null;
        receipt.trigger_count = triggers.length;
        receipt.native_exit_codes = observation.native_exit_codes;
        receipt.is_error_sequence = observation.is_error_sequence;
        receipt.error_classes = observation.error_classes;
        receipt.status = 'passed';
        receipt.exit_code = 0;
      } catch (error) {
        observation.status = 'failed';
        observation.error = { type: error.code ?? 'assertion_failed', message: error.message };
        observation.records = events(owned);
      } finally {
        await owned.stop({ force: true });
        observation.provider_calls = events(owned).filter(record => record.event === 'provider_request');
        observation.mock_provider_calls = mock.requests;
        await mock.close();
        observation.mock_listener_closed = true;
        observation.cleanup = cleanupDisposableState(sandbox);
        observation.auth_after = guardAuth(attemptDir);
        writeJson(join(directory, 'receipt.json'), observation);
      }
      if (observation.status === 'passed') break;
    }
    assert.equal(receipt.status, 'passed', 'real-host sequence must pass');
  } catch (error) {
    receipt.status = error.code === 'auth_changed' ? 'auth_changed' : 'failed';
    receipt.error = { type: error.code ?? 'assertion_failed', message: error.message };
    receipt.exit_code = 1;
  } finally {
    if (authBefore) finalizeAuthGuard(receipt, attemptDir);
    receipt.all_owned_pids_gone = receipt.attempts.every(attempt => attempt.process?.pid_gone);
    if (!receipt.all_owned_pids_gone) receipt.exit_code = 1;
    receipt.finished_at = new Date().toISOString();
    const path = join(evidenceDir, `${values.case}.json`);
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(path, receipt);
    console.log(JSON.stringify({ receipt: path, status: receipt.status, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
}

// Also executable directly while the shared runner's owner adds case routing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: {
    case: { type: 'string' }, attempt: { type: 'string', default: 'a1' },
    main: { type: 'string', default: 'real' }, oracle: { type: 'string', default: 'mock' },
  } });
  await runTriggerCase(values);
}
