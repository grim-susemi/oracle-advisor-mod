import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ROOT, OwnedProcess, REAL_OBSERVATION_CEILING_MS, admitAuth, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, hostArgs, readJson, sourceHash, writeJson,
} from './harness.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { evaluateVerdict, observeVerdict } from './verdict-spec.mjs';
import { fixtureSetupError, fixtureShellCommand, resolveFixtureExecutable } from './fixture-executable.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.nudger' && event.data?.event === name;

export function assertNudgeObservation(receipt, options = {}) {
  return evaluateVerdict(receipt.case, receipt, options);
}

export async function runNudgerCase(values) {
  assert.ok(['nudge-real', 'nudge-inactive'].includes(values.case));
  assert.ok(!isAbsolute(values.attempt) && /^[A-Za-z0-9_-]+$/.test(values.attempt));
  assert.ok(['mock', 'real'].includes(values.main) && ['mock', 'real'].includes(values.oracle));
  const real = values.main === 'real' || values.oracle === 'real';
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-9-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const receiptPath = join(evidenceDir, `${values.case}${real ? '-real' : ''}.json`);
  const active = values.case === 'nudge-real';
  const receipt = {
    case: values.case, status: 'running', exit_code: null, argv: process.argv,
    source_hash: sourceHash(), started_at: new Date().toISOString(), run_dir: runDir,
    main_mode: values.main, oracle_mode: values.oracle, real_oracle_runs: 0, gate_deciding: !real,
    children: [], cleanup: {}, adversarial: {},
  };
  let child, mock, sandbox, authBefore;
  async function command(args) {
    const done = child.waitFor(event => isEvent('command')(event) && event.data.args === args,
      `/oracle ${args}`, { from: child.history.length });
    await child.rpc('prompt', { message: `/oracle ${args}` });
    return (await done).data;
  }
  try {
    if (real) receipt.auth_before = authBefore = admitAuth(attemptDir, undefined, { providers: ['ollama'], receipt });
    const host = discoverHost();
    receipt.installed_versions = host.versions;
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: values.attempt,
      ORACLE_QA_ATTEMPT_DIR: attemptDir, ORACLE_QA_REAL_ORACLE: values.oracle === 'real' ? '1' : '0',
      OMO_ORACLE_ADVISOR: '1', OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
    });
    receipt.temp_dir = sandbox.stateDir;
    const executable = resolveFixtureExecutable('node', { env: sandbox.env });
    const shellArgs = { command: fixtureShellCommand(executable, ['-e', 'process.exit(1)']), description: 'owned nudger QA',
      timeout: 30, run_in_background: false };
    const failureStep = () => ({ tool: 'eval', arguments: {
      language: 'js', code: `display(await tool.bash(${JSON.stringify(shellArgs)}));`,
      summary: 'Run the intentional owned nudger failure fixture',
    } });
    mock = await startMockProvider({ steps: [
      failureStep(), failureStep(),
      ...(active ? [
        { tool: 'oracle_consult', arguments: { kind: 'work', question: 'Review the two intentional fixture failures.' } },
        { text: JSON.stringify({ verdict: 'REDIRECT', reasons: [{ text: 'Change the failing fixture command before retrying.' }] }) },
      ] : []),
      { tool: 'oracle_advisor', arguments: { action: 'finish_intent' } },
      { text: 'Owned nudge QA finished.' },
    ] });
    sandbox.env.ORACLE_QA_MOCK_URL = mock.baseUrl;
    receipt.fixture_command = shellArgs;
    const taskState = join(sandbox.stateDir, 'senpi-task');
    writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: taskState, default_execution_mode: 'in-process' },
        agents: { oracle: { model: values.oracle === 'real' ? 'ollama/deepseek-v4.1-flash' : 'oracle-qa-mock/oracle',
          tools: { read: true, lsp_symbols: true } } },
      },
    });
    const args = hostArgs(host, sandbox, join(ROOT, 'qa/nudger-extension.mjs'), { main: values.main })
      .filter(arg => arg !== '--no-builtin-tools');
    if (values.oracle === 'real' && values.main === 'mock') args.push('--extension', join(ROOT, 'qa/main-provider.mjs'));
    args.push('--system-prompt', 'Owned nudge QA. Execute the requested calls. Intentional command failures are QA data. Do not call task tools directly. Consult at most once.');
    try {
      child = new OwnedProcess(process.execPath, args, {
        cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'host'),
        deadlineMs: real ? REAL_OBSERVATION_CEILING_MS + 60000 : 180000,
      });
    } catch (error) {
      throw fixtureSetupError('spawn', process.execPath, error.code ?? error.message, { label: 'host' });
    }
    receipt.children.push(child.metadata);
    receipt.host_argv = child.metadata.argv;
    try { await child.rpc('get_state'); }
    catch (error) {
      if (child.metadata.spawn_error) {
        throw fixtureSetupError('spawn', process.execPath, child.metadata.spawn_error, { label: 'host' });
      }
      throw error;
    }
    await child.waitFor(isEvent('ready'), 'nudger extension ready');
    try {
      receipt.fixture_validation = await child.rpc('extension_request', {
        name: 'oracle.nudger.validate', data: { executable },
      });
    } catch (error) {
      throw fixtureSetupError('executable_validation', executable, error.message);
    }
    if (active) await command('on');
    receipt.agent_end = await child.prompt(real
      ? 'Using eval and tool.bash, run this exact JSON argument object exactly twice as separate failing commands; ' +
        `do not repair, replace, or repeat it beyond those two calls: ${JSON.stringify(shellArgs)}. ` +
        (active ? 'If nudged, make one work oracle_consult about those intentional failures. ' : 'Do not start a job or call oracle_consult. ') +
        'Then call oracle_advisor with action finish_intent once and finish.'
      : 'Run the owned nudge QA fixture, then declare finish intent.',
    real ? { timeoutMs: REAL_OBSERVATION_CEILING_MS, ceiling: true } : {});
    receipt.snapshot = await child.rpc('extension_request', { name: 'oracle.nudger.status', data: {} });
    receipt.events = child.history.filter(event => event.type === 'extension_event' &&
      event.name === 'oracle-qa.nudger').map(event => event.data);
    receipt.operations = receipt.events.filter(event => event.event === 'operation_result');
    const log = join(sandbox.agentDir, 'logs/oracle-advisor.jsonl');
    receipt.receipts = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    receipt.mock_oracle_runs = mock.requests.filter(request => request.model === 'oracle').length;
    if (existsSync(log)) copyFileSync(log, join(runDir, 'receipts.jsonl'));
    receipt.adversarial = {
      misleading_prose: 'Not used for verdicts: product notices, parsed verdict and exact native/provider dispatch counts are asserted.',
      inactive: active ? 'Covered by the separate nudge-inactive case.' : 'Real native failures and finish_intent produce no ledger writes, notices or oracle calls.',
      output_preservation: active ? 'Product patch retained native content and exact structuredContent/details identities.' : 'No patches.',
      stale_state: 'Fresh OS-temporary home outside evidence; removed after this run.',
      retry: 'Zero task_send calls; exactly one oracle call for the active fixture and zero otherwise.',
    };
    if (active) {
      receipt.ended = await command('end');
      receipt.retired_records = receipt.ended.state.job.oracle_task_ids.map(id =>
        readJson(join(taskState, 'tasks', `${id}.json`)));
    }
    receipt.events = child.history.filter(event => event.type === 'extension_event' &&
      event.name === 'oracle-qa.nudger').map(event => event.data);
    if (real) observeVerdict(values.case, receipt, { host: true, oracle: values.oracle });
    else assertNudgeObservation(receipt, { host: true, oracle: values.oracle });
    receipt.status = real ? 'observed' : 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = ['fixture_setup_failed', 'harness_ceiling', 'scenario_not_reached'].includes(error.code) ? error.code : 'failed';
    receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
    if (error.fixture_setup) receipt.fixture_setup = error.fixture_setup;
  } finally {
    if (child) {
      receipt.events = child.history.filter(event => event.type === 'extension_event' &&
        event.name === 'oracle-qa.nudger').map(event => event.data);
      receipt.real_oracle_runs = values.oracle === 'real'
        ? receipt.events.filter(event => event.event === 'native_call' && event.name === 'task').length : 0;
      receipt.real_provider_calls = receipt.events.filter(event => event.event === 'provider_request');
    }
    if (child) await child.stop({ force: true });
    if (mock) {
      receipt.provider_calls = mock.requests;
      await mock.close();
      receipt.cleanup.listener_closed = true;
    }
    if (sandbox) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    receipt.cleanup.pids_gone = receipt.children.every(process => process.pid_gone);
    receipt.cleanup.homes_removed = !sandbox || receipt.cleanup.disposable_state.removed;
    if (!receipt.cleanup.pids_gone || !receipt.cleanup.homes_removed) receipt.exit_code = 1;
    if (real && authBefore) finalizeAuthGuard(receipt, attemptDir, undefined, { providers: ['ollama'] });
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code, error: receipt.error?.message }));
    process.exitCode = receipt.exit_code;
  }
}
