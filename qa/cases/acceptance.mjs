import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ROOT, OwnedProcess, REAL_OBSERVATION_CEILING_MS, admitAuth, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, hostArgs, readJson, sourceHash, typedError, writeJson,
} from '../harness.mjs';
import { fileHashes } from '../../scripts/build.mjs';
import { CORRECT, FIXTURE_TEST, ORIGINAL, SEED, startAcceptanceProvider } from './acceptance-provider.mjs';
import { evaluateVerdict, observeVerdict } from '../verdict-spec.mjs';
import { fixtureSetupError, fixtureShellCommand, resolveFixtureExecutable,
  runFixtureCommand, validateFixtureExecutable } from '../fixture-executable.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.acceptance' && event.data?.event === name;
const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !resolve(child).startsWith(`${resolve(ROOT)}${sep}`);
};
const pendingReal = {
  status: 'pending_real_qa',
  command: 'npm run qa -- --case acceptance --attempt <fresh-attempt> --main real --oracle real',
  reason: 'Real oracle plus cheap main observation was not authorized while the auth containment guard was pending.',
  gate_deciding: false,
};

export function summarizeEffects(runs, { main, oracle }) {
  const source = observation => ({
    mode: main === 'mock' && oracle === 'mock' ? 'mock' : 'real-observation',
    observation, artifacts: runs.map(run => run.evidence),
  });
  const tagged = (value, observation) => ({ value, source: source(observation) });
  const consults = runs.flatMap(run => {
    const records = new Map();
    for (const entry of run.receipts) {
      if (entry.event === 'consult' && entry.path && entry.model_called !== false) {
        records.set(entry.request_id, { ...entry, variant: run.name });
      } else if (entry.event === 'consult_effect' && records.has(entry.request_id)) {
        records.set(entry.request_id, { ...records.get(entry.request_id), ...entry });
      }
    }
    return [...records.values()];
  });
  const sum = (records, field) => records.length && records.every(entry => Number.isFinite(entry[field]))
    ? records.reduce((total, entry) => total + entry[field], 0) : null;
  const mainUsage = runs.flatMap(run => run.main_usage);
  const paths = Object.fromEntries(['spawn', 'revival', 'fresh_fallback'].map(path =>
    [path, consults.filter(entry => entry.path === path).length]));
  paths.fresh = paths.spawn + paths.fresh_fallback;
  const brokers = runs.filter(run => run.coordination.present);
  return {
    consults: tagged(consults.map(entry => ({
      variant: entry.variant, request_id: entry.request_id, kind: entry.kind,
      status: entry.status, path: entry.path, verdict: entry.verdict ?? null,
      redirect_id: entry.redirect_id ?? null, verdict_changed_direction: entry.verdict_changed_direction ?? null,
    })), 'Product consult receipts merged with later consult_effect entries, separately per owned job.'),
    paths: tagged(paths, 'Product consult receipt path; fresh = spawn + fresh_fallback.'),
    verdicts: tagged(Object.fromEntries(['CONTINUE', 'REDIRECT', 'STOP'].map(verdict =>
      [verdict, consults.filter(entry => entry.verdict === verdict).length])), 'Parsed product consult verdicts.'),
    verdict_changed_direction: tagged(consults.filter(entry => entry.verdict_changed_direction === true).length,
      'Final product direction facts after accepted STOP redirect or followed REDIRECT; not inferred from prose.'),
    direction_changes: tagged({
      changed: consults.filter(entry => entry.verdict_changed_direction === true).length,
      not_changed: consults.filter(entry => entry.verdict_changed_direction === false).length,
      unknown: consults.filter(entry => entry.verdict_changed_direction == null).length,
    }, 'Final product verdict_changed_direction; unrecorded direction facts stay unknown.'),
    repeated_failures_after_consult: tagged({
      recurred: consults.filter(entry => entry.same_failure_recurred_after === true).length,
      not_recurred: consults.filter(entry => entry.same_failure_recurred_after === false).length,
      unknown: consults.filter(entry => entry.same_failure_recurred_after == null).length,
    }, 'Final product same_failure_recurred_after receipt field; null stays unknown.'),
    oracle_tokens_vs_main_tokens: tagged({
      oracle: { input_tokens: sum(consults, 'input_tokens'), output_tokens: sum(consults, 'output_tokens'),
        reasoning_tokens: sum(consults, 'reasoning_tokens'),
        usage_status: [...new Set(consults.map(entry => entry.usage_status ?? 'unknown'))] },
      main: { input_tokens: sum(mainUsage, 'input'), output_tokens: sum(mainUsage, 'output'),
        cache_read_tokens: sum(mainUsage, 'cacheRead'), cache_write_tokens: sum(mainUsage, 'cacheWrite') },
      mock_usage_is_synthetic: main === 'mock' || oracle === 'mock',
      main_mode: main, oracle_mode: oracle,
    }, 'Oracle numbers come only from product receipts; main numbers come from persisted assistant message usage. Missing numbers remain null; mock SSE usage is synthetic, not savings.'),
    main_cache_wait_exceeded: tagged(consults.filter(entry => entry.main_cache_wait_exceeded === true).length,
      'Product consult receipt main_cache_wait_exceeded boolean.'),
    oracle_to_main_coordination_asks: tagged(brokers.length ? brokers.reduce((count, run) =>
      count + run.coordination.calls.filter(call => call.method === 'ask' &&
        call.from === 'oracle' && call.to === 'main').length, 0) : null,
    'Fake coordination broker own JSONL receipts when present; absent broker is null, never an invented zero.'),
    provider_calls: tagged(runs.flatMap(run => run.provider_calls.map(call => ({ variant: run.name, ...call }))),
      'Loopback provider request receipts and before_provider_request host events.'),
    token_savings: tagged(null, 'No control-run baseline was recorded; no savings estimate is claimed.'),
    coordination_limitations: tagged(main === 'mock' && oracle === 'mock' ? {
      asks_outside_consult_cap: true, other_peers_may_ask_resident_oracle: true, api_v1_exclusion_port: false,
    } : null, 'Coordination capabilities are not measured by a real observation; mock metadata only.'),
  };
}

export function assertAcceptanceObservation(proof, options = {}) {
  return evaluateVerdict(options.down ? 'acceptance-oracle-down' : 'acceptance', proof, options);
}

export async function runAcceptanceCase(values) {
  if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw typedError('invalid_attempt');
  if (!['mock', 'real'].includes(values.main) || !['mock', 'real'].includes(values.oracle)) throw typedError('invalid_model_mode');
  const down = values.case === 'acceptance-oracle-down';
  const real = values.main === 'real' || values.oracle === 'real';
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-13-piomo-oracle-advisor-mod');
  const summaryPath = join(evidenceDir, down ? 'effect-summary-oracle-down.json' : 'effect-summary.json');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-${real ? 'observation' : 'mock'}-`));
  const receipt = {
    case: values.case, status: 'running', exit_code: 1, source_hash: sourceHash(), argv: process.argv,
    started_at: new Date().toISOString(), run_dir: runDir, main_mode: values.main, oracle_mode: values.oracle,
    gate_deciding: !real, real_provider_calls: 0, real_oracle_runs: 0, variants: [], cleanup: {},
    pending_real_qa: real ? [] : [pendingReal],
    main_model: values.main === 'mock' ? 'oracle-qa-mock/main' : 'ollama/deepseek-v4.1-flash:high',
    main_route_source: values.main === 'mock' ? 'Scripted local provider' :
      'Active native-cmd-glm-deepseek explore alias flash-ollama-4-1-high; no live config write.',
  };
  let authBefore;
  try {
    if (real) {
      if (process.env.ORACLE_QA_AUTH_GUARD !== 'scoped') {
        throw typedError('pending_real_qa', 'Real acceptance observation requires the verified scoped auth guard.');
      }
      authBefore = admitAuth(attemptDir, undefined, { providers: ['ollama'], receipt });
    }
    const host = discoverHost();
    receipt.installed_versions = host.versions;
    // A second complete owned session exercises the optional broker without
    // introducing another model-dependent gate.
    for (const coordination of down ? [false] : [false, true]) {
      const name = coordination ? 'with-coordination' : 'without-coordination';
      const directory = join(runDir, name);
      mkdirSync(directory);
      const proof = { name, evidence: join(directory, 'receipt.json'), children: [], cleanup: {},
        receipts: [], main_usage: [], provider_calls: [], coordination: { present: coordination, calls: [] } };
      receipt.variants.push(proof);
      let sandbox, child, mock;
      async function command(command, args, label, expected = 0) {
        const result = await runFixtureCommand(command, args, {
          cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(directory, 'raw', label),
          children: proof.children, label, expected,
          nodeProfile: label === 'final-fixture-test' ? 'test' : 'script',
        });
        return result.stdout;
      }
      async function oracleCommand(args) {
        const done = child.waitFor(event => isEvent('command')(event) && event.data.args === args,
          `/oracle ${args}`, { from: child.history.length });
        await child.rpc('prompt', { message: `/oracle ${args}` });
        return (await done).data;
      }
      try {
        sandbox = disposableEnvironment(host, directory, {
          ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_ATTEMPT_DIR: attemptDir,
          ORACLE_QA_REAL_ORACLE: values.oracle === 'real' && !down ? '1' : '0',
          ORACLE_QA_COORDINATION: coordination ? '1' : '0',
          ORACLE_QA_COORDINATION_LOG: join(directory, 'coordination.jsonl'),
          OMO_ORACLE_ADVISOR: '1', OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
        });
        assert.ok(inside(tmpdir(), sandbox.stateDir), 'State must be under OS temp, not evidence or product.');
        proof.temp_dir = sandbox.stateDir;
        proof.agent_dir = sandbox.agentDir;
        const executable = resolveFixtureExecutable('node', { env: sandbox.env });
        proof.test_command = { command: fixtureShellCommand(executable, ['--test', 'fixture.test.mjs']),
          description: 'owned acceptance fixture', timeout: 30, run_in_background: false };
        mock = await startAcceptanceProvider(join(directory, 'provider.jsonl'), { down, testCommand: proof.test_command });
        sandbox.env.ORACLE_QA_MOCK_URL = mock.baseUrl;
        const taskState = join(sandbox.stateDir, 'senpi-task');
        proof.oracle_model = down ? 'oracle-qa-mock/invalid-oracle-acceptance'
          : values.oracle === 'mock' ? 'oracle-qa-mock/oracle' : 'ollama/deepseek-v4.1-flash';
        writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
          _migrations: ['2026-08-reasoning-unification'],
          '[native]': {
            task: { state_dir: taskState, default_execution_mode: 'in-process' },
            agents: { oracle: { model: proof.oracle_model } },
          },
        });
        writeFileSync(join(sandbox.workDir, 'normalize.mjs'), ORIGINAL);
        writeFileSync(join(sandbox.workDir, 'fixture.test.mjs'), FIXTURE_TEST);
        proof.fixture_validation = await validateFixtureExecutable('git', {
          cwd: sandbox.workDir, env: sandbox.env, children: proof.children,
          rawPrefix: join(directory, 'raw', 'git-version'), label: 'git-version',
        });
        await command(proof.fixture_validation.executable, ['init', '--quiet'], 'git-init');
        await command(proof.fixture_validation.executable,
          ['--no-optional-locks', 'add', '--', 'normalize.mjs', 'fixture.test.mjs'], 'git-add');
        proof.install = JSON.parse(await command(process.execPath, [
          join(ROOT, 'scripts/install.mjs'), '--agent-dir', sandbox.agentDir,
        ], 'install'));
        assert.equal(proof.install.status, 'installed');
        assert.deepEqual(fileHashes(proof.install.generation_path), proof.install.sha256);
        proof.installed_hashes = proof.install.sha256;
        const shim = join(sandbox.agentDir, 'extensions/omo-oracle-advisor.js');
        sandbox.env.ORACLE_QA_INSTALLED_ENTRY = shim;
        const args = hostArgs(host, sandbox, join(ROOT, 'qa/cases/acceptance-extension.mjs'), { main: values.main })
          .filter(arg => arg !== '--no-builtin-tools');
        // Loading the shim again is the same idempotent registration path the
        // installed host uses; the observer's earlier import wraps its APIs.
        args.push('--extension', shim);
        if (values.oracle === 'real' && values.main === 'mock' && !down) {
          args.push('--extension', join(ROOT, 'qa/main-provider.mjs'));
        }
        args.push('--system-prompt', 'Owned acceptance QA in a disposable fixture repository. ' +
          'Follow the requested bounded work. Consult when nudged; declare finish_intent before handoff. ' +
          'Do not weaken fixture.test.mjs; record any STOP disposition explicitly.');
        proof.host_launch = { argv: [process.execPath, ...args],
          policy: sandbox.env.ORACLE_QA_ROUTE_POLICY, admission: sandbox.env.ORACLE_QA_ROUTE_ADMISSION };
        try {
          child = new OwnedProcess(process.execPath, args, {
            cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(directory, 'raw/host'),
            deadlineMs: real ? REAL_OBSERVATION_CEILING_MS + 60000 : 180000,
          });
        } catch (error) {
          throw fixtureSetupError('spawn', process.execPath, error.code ?? error.message,
            { label: 'host', reason_detail: error.message });
        }
        proof.children.push(child.metadata);
        try { await child.rpc('get_state'); }
        catch (error) {
          if (child.metadata.spawn_error) {
            throw fixtureSetupError('spawn', process.execPath, child.metadata.spawn_error, { label: 'host' });
          }
          throw error;
        }
        if (values.main === 'real') {
          await child.rpc('set_thinking_level', { level: 'high', scope: 'turn' });
          proof.main_thinking_level = (await child.rpc('get_state')).thinkingLevel;
          assert.equal(proof.main_thinking_level, 'high');
        }
        proof.ready = (await child.waitFor(isEvent('ready'), 'installed acceptance candidate ready')).data;
        assert.equal(proof.ready.installed_entry, shim);
        proof.loaded_surfaces = await child.rpc('get_loaded_surfaces');
        assert.ok(proof.loaded_surfaces.extensions.some(item => resolve(item.path).toLowerCase() === resolve(shim).toLowerCase()));
        proof.node_validation = await child.rpc('extension_request', {
          name: 'oracle.acceptance.validate', data: { executable, test_command: proof.test_command, cwd: sandbox.workDir },
        });
        await oracleCommand('on');
        const settled = child.waitFor(event => event.type === 'agent_settled', 'acceptance main settled',
          { from: child.history.length, timeoutMs: real ? REAL_OBSERVATION_CEILING_MS : 150000,
            timeoutCode: real ? 'harness_ceiling' : 'harness_deadline' });
        proof.agent_end = await child.prompt(real && down
          ? `Bind this Seed:\n${SEED}\nMake one work oracle_consult about the normalization task. ` +
            'When the oracle is unavailable, continue without retrying it. Repair normalize.mjs, ' +
            `run the unchanged test via eval and tool.bash with this exact JSON argument object: ${JSON.stringify(proof.test_command)}. ` +
            'Make exactly one total consult across all kinds; do not call finish_intent or consult completion. Finish. Do not call task directly.'
          : real
          ? `Bind this Seed:\n${SEED}\nRepair normalize.mjs so the unchanged fixture test passes. ` +
            `First try the obvious lowercase-only fix and run the exact same test twice using eval and tool.bash ` +
            `with this exact JSON argument object, without a pipeline or any change: ${JSON.stringify(proof.test_command)}. ` +
            'Follow the failure nudge with a work consult. Correct the implementation and verify. ' +
            'Ask a work consult about weakening the test (Seed drift), observe the verdict, and if STOP ' +
            'attempt one blocked edit then record a redirect disposition preserving the test. ' +
            'Review the corrected plan with a third work consult, declare finish_intent, consult completion, ' +
            'try a fifth consult, then finish. Model responses are observation-only; do not call task directly.'
          : 'Execute the owned normalization acceptance fixture and finish the main turn.',
        real ? { timeoutMs: REAL_OBSERVATION_CEILING_MS, ceiling: true } : {});
        await settled;
        const messages = (await child.rpc('get_messages')).messages;
        proof.main_usage = messages.filter(message => message.role === 'assistant' && message.usage).map(message => message.usage);
        proof.main_finished = messages.some(message => message.role === 'assistant' && message.stopReason === 'stop');
        proof.events = child.history.filter(event => event.type === 'extension_event' &&
          event.name === 'oracle-qa.acceptance').map(event => event.data);
        proof.snapshot = await child.rpc('extension_request', { name: 'oracle.acceptance.status', data: {} });
        proof.coordination = proof.snapshot.coordination;
        proof.status_before_end = await oracleCommand('status');
        const tools = proof.events.filter(event => event.event === 'tool');
        const consults = tools.filter(event => event.name === 'oracle_consult');
        proof.fixture_after = {
          implementation: readFileSync(join(sandbox.workDir, 'normalize.mjs'), 'utf8'),
          test: readFileSync(join(sandbox.workDir, 'fixture.test.mjs'), 'utf8'),
        };
        // Independent real command verifies the fixture bytes, not main prose.
        await command(executable, ['--test', 'fixture.test.mjs'], 'final-fixture-test', null);
        proof.events = child.history.filter(event => event.type === 'extension_event' &&
          event.name === 'oracle-qa.acceptance').map(event => event.data);
        proof.fixture_verification_at = proof.events.length;
        proof.fixture_verification = { event: 'evidence', kind: 'fixture_verification',
          exit_code: proof.children.at(-1).exit_code, argv: proof.children.at(-1).argv, cwd: sandbox.workDir };
        proof.events.push(proof.fixture_verification);
        proof.oracle_http_calls = values.oracle === 'mock' || down
          ? mock.requests.filter(call => call.model === 'oracle').length : null;
        proof.ended = await oracleCommand('end');
        proof.after_end = await child.rpc('extension_request', { name: 'oracle.acceptance.status', data: {} });
        proof.retired_records = proof.ended.state.job.oracle_task_ids.map(id => readJson(join(taskState, 'tasks', `${id}.json`)));
        const log = join(sandbox.agentDir, 'logs/oracle-advisor.jsonl');
        const text = readFileSync(log, 'utf8');
        proof.receipts = text.trim().split('\n').filter(Boolean).map(JSON.parse);
        for (const entry of proof.receipts) {
          appendFileSync(join(evidenceDir, 'receipts.jsonl'), JSON.stringify({
            ...entry, qa_source: { mode: real ? 'real-observation' : 'mock', variant: name, artifact: proof.evidence },
          }) + '\n');
        }
        writeFileSync(join(directory, 'receipts.jsonl'), text);
        proof.analysis_artifacts = [];
        for (const entry of proof.receipts.filter(entry => entry.event === 'consult' && entry.analysis_path)) {
          const path = join(directory, `${entry.request_id}.md`);
          writeFileSync(path, readFileSync(entry.analysis_path));
          proof.analysis_artifacts.push({ path, source: entry.analysis_path });
        }
        proof.events = child.history.filter(event => event.type === 'extension_event' &&
          event.name === 'oracle-qa.acceptance').map(event => event.data);
        proof.events.splice(proof.fixture_verification_at, 0, proof.fixture_verification);
        proof.mock_provider_calls = mock.requests;
        proof.effect_summary = summarizeEffects([proof], values);
        if (real) observeVerdict(values.case, proof, { down, coordination, host: true });
        else assertAcceptanceObservation(proof, { down, coordination, host: true });
        proof.status = real ? 'observed' : 'passed';
      } catch (error) {
        proof.status = error.code ?? 'failed';
        if (error.fixture_setup) proof.fixture_setup = error.fixture_setup;
        throw error;
      } finally {
        if (child) {
          // Preserve observations even when the safety ceiling, not the product,
          // ends an incomplete run. Never synthesize completion or usage.
          proof.events = child.history.filter(event => event.type === 'extension_event' &&
            event.name === 'oracle-qa.acceptance').map(event => event.data);
          if (proof.fixture_verification) proof.events.splice(proof.fixture_verification_at, 0, proof.fixture_verification);
          if (!proof.snapshot && !child.closed) {
            try {
              proof.snapshot = await child.rpc('extension_request', { name: 'oracle.acceptance.status', data: {} });
              proof.coordination = proof.snapshot.coordination;
              const messages = (await child.rpc('get_messages')).messages;
              proof.main_usage = messages.filter(message => message.role === 'assistant' && message.usage).map(message => message.usage);
            } catch (error) { proof.partial_observation_error = error.message; }
          }
        }
        if (child) await child.stop({ force: true });
        const log = sandbox && join(sandbox.agentDir, 'logs/oracle-advisor.jsonl');
        if (log && existsSync(log) && !proof.receipts.length) {
          const text = readFileSync(log, 'utf8');
          proof.receipts = text.trim().split('\n').filter(Boolean).map(JSON.parse);
          writeFileSync(join(directory, 'receipts.jsonl'), text);
        }
        if (mock) { proof.mock_provider_calls = mock.requests; await mock.close(); proof.cleanup.listener_closed = true; }
        proof.provider_calls = real ? (proof.events ?? []).filter(event => event.event === 'provider_request') : mock?.requests ?? [];
        proof.cleanup.pids_gone = proof.children.every(item => item.pid_gone);
        assert.equal(proof.cleanup.pids_gone, true);
        if (sandbox) proof.cleanup.disposable_state = cleanupDisposableState(sandbox);
        proof.cleanup.write_scope = {
          writable_state_root: sandbox?.stateDir ?? null, under_os_temp: !!sandbox && inside(tmpdir(), sandbox.stateDir),
          retained_evidence_root: directory, live_installation_written: false,
          fixture_and_installer_targets_within_temp: !!sandbox && [sandbox.agentDir, sandbox.workDir, sandbox.home]
            .every(path => relative(sandbox.stateDir, path) && !relative(sandbox.stateDir, path).startsWith('..')),
        };
        writeJson(proof.evidence, proof);
      }
    }
    receipt.real_oracle_runs = real && values.oracle === 'real'
      ? receipt.variants.reduce((count, run) => count + (run.snapshot?.native_calls ?? []).filter(call => call.name === 'task').length, 0) : 0;
    receipt.real_provider_calls = receipt.variants.reduce((count, run) => count +
      run.provider_calls.filter(call => call.provider && call.provider !== 'oracle-qa-mock').length, 0);
    if (!real) assert.equal(receipt.real_provider_calls, 0);
    receipt.status = real ? 'observed' : 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code ?? 'failed';
    if (real && error.code === 'harness_ceiling') {
      receipt.exit_code = 1;
      receipt.observation_complete = false;
      receipt.product_result = null;
    }
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
    if (error.fixture_setup) receipt.fixture_setup = error.fixture_setup;
  } finally {
    receipt.real_oracle_runs = real && values.oracle === 'real' && !down
      ? receipt.variants.reduce((count, run) => count + (run.snapshot?.native_calls ?? []).filter(call => call.name === 'task').length, 0) : 0;
    receipt.real_provider_calls = receipt.variants.reduce((count, run) => count +
      run.provider_calls.filter(call => call.provider && call.provider !== 'oracle-qa-mock').length, 0);
    if (receipt.variants.length) {
      const summary = summarizeEffects(receipt.variants, values);
      writeJson(join(runDir, 'effect-summary.json'), summary);
      writeJson(summaryPath, summary);
      receipt.effect_summary = summaryPath;
    }
    if (real && receipt.variants.length) {
      receipt.harness_ceiling_ms = REAL_OBSERVATION_CEILING_MS;
      receipt.observation_complete ??= receipt.status === 'observed';
    }
    if (real && authBefore) finalizeAuthGuard(receipt, attemptDir, undefined, { providers: ['ollama'] });
    receipt.cleanup.all_owned_pids_gone = receipt.variants.every(run => run.cleanup.pids_gone);
    receipt.cleanup.all_temporary_homes_removed = receipt.variants.every(run => run.cleanup.disposable_state?.removed);
    receipt.cleanup.zero_live_installations = receipt.variants.every(run => run.cleanup.write_scope?.live_installation_written === false);
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    const receiptPath = join(evidenceDir, `${values.case}${real ? '-real' : ''}.json`);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code, error: receipt.error?.message }));
    process.exitCode = receipt.exit_code;
  }
}
