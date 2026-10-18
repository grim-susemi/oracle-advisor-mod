import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost,
  disposableEnvironment, finalizeAuthGuard, hostArgs, sourceHash, writeJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';
import { evaluateVerdict } from '../verdict-spec.mjs';
export { assertSuppliedSeed } from '../verdict-primary.mjs';

const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.seed' && event.data.event === name;

export function assertSeedObservation(receipt, options = {}) {
  return evaluateVerdict(receipt.case, receipt, options);
}

export async function runSeedCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (!['mock', 'real'].includes(values.main) || !['mock', 'real'].includes(values.oracle)) throw new Error('Invalid --main or --oracle');
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-10-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const rawDir = join(runDir, 'raw');
  mkdirSync(rawDir);
  const receiptPath = join(evidenceDir, `${values.case}${values.main === 'mock' ? '-mock' : ''}.json`);
  const receipt = {
    case: values.case, status: 'running', exit_code: null, source_hash: sourceHash(),
    started_at: new Date().toISOString(), run_dir: runDir,
    main_mode: values.main, oracle_mode: values.oracle, real_oracle_runs: 0,
    loading_mechanism: 'cli-extension-flag', children: [], cleanup: {}, adversarial: {},
    fixture_provenance: 'This host case binds the SKILL example; seed.test.mjs separately verifies two captured ouroboros_generate_seed outputs and the extra hand-written fixtures.',
  };
  let host, sandbox, owned, mock, authBefore;
  const command = async (name, args) => {
    const from = owned.history.length;
    const complete = owned.waitFor(event =>
      isEvent(name === 'oracle' ? 'command' : 'fixture')(event) && event.data.args === args &&
        (name !== 'oracle' || event.data.command === name),
    `${name} ${args}`, { from });
    await owned.rpc('prompt', { message: `/${name} ${args}` });
    return (await complete).data;
  };
  try {
    host = discoverHost();
    receipt.installed_versions = host.versions;
    receipt.auth_before = authBefore = authHashes();
    if (values.main === 'real') {
      admitAuth(attemptDir, undefined, { receipt });
    }
    const skill = readFileSync(join(ROOT, 'test/fixtures/seed-skill.yaml'), 'utf8');
    mock = await startMockProvider({ steps: [
      { tool: 'oracle_bind_seed', arguments: { seed_yaml: skill } },
      { text: 'Owned Seed QA complete.' },
    ] });
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_MOCK_URL: mock.baseUrl, ORACLE_QA_ATTEMPT: values.attempt,
      OMO_ORACLE_ADVISOR: '1',
    });
    receipt.temp_dir = sandbox.stateDir;
    const candidate = join(ROOT, 'qa/cases/seed-extension.mjs');
    owned = new OwnedProcess(process.execPath, [
      ...hostArgs(host, sandbox, candidate, { main: values.main }),
      '--tools', 'oracle_bind_seed',
      '--system-prompt', 'Owned Seed QA. Follow the request and call only oracle_bind_seed if requested.',
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(rawDir, 'host') });
    receipt.children.push(owned.metadata);
    receipt.argv = owned.metadata.argv;
    await owned.rpc('get_state');
    await owned.waitFor(isEvent('session_start'), 'Seed session started');
    const surfaces = await owned.rpc('get_loaded_surfaces');
    assert.ok(surfaces.extensions.some(item => resolve(item.path) === resolve(candidate)));
    await command('oracle', 'on');
    const first = await command('qa_seed', 'skill');
    const shown = await command('oracle', 'status');
    receipt.proofs = { bound: first, status: shown.result };
    const invalidInputs = [];
    for (const input of ['missing', 'ambiguous', 'quoting']) {
      const bad = await command('qa_seed', input);
      invalidInputs.push({ input, ...bad });
    }
    receipt.adversarial.malformed_input = { result: 'passed', cases: invalidInputs };
    const from = owned.history.length;
    const reload = owned.waitFor(isEvent('session_start'), 'Seed reload pin restored', { from });
    await owned.rpc('reload');
    receipt.proofs.reload = (await reload).data;
    receipt.proofs.invalid_inputs = invalidInputs;
    if (values.case === 'seed-bind') {
      const unchanged = await command('qa_seed', 'skill');
      const rebound = await command('qa_seed', 'other');
      const held = await command('qa_seed', 'hold');
      const refused = await command('qa_seed', 'skill');
      receipt.adversarial.stop_scope_escape = { result: 'passed', held, refused };
      const override = await command('oracle', 'override qa-seed-stop Owner approves this Seed QA scope change.');
      const final = await command('qa_seed', 'skill');
      Object.assign(receipt.proofs, { unchanged, held, refused, override });
      receipt.proofs.rebound = rebound;
      receipt.proofs.final_binding = final;
    }
    // Exercise the registered product tool through the real engine/model adapter.
    // The local scripted main makes this gate deterministic, with no paid call.
    await command('qa_seed', 'model-window');
    const modelFrom = owned.history.length;
    receipt.model_event_from = owned.history.filter(event => event.type === 'extension_event' &&
      event.name === 'oracle-qa.seed').length;
    await owned.prompt(`Call oracle_bind_seed with this exact seed_yaml, then answer briefly:\n${skill}`);
    const window = owned.history.slice(modelFrom);
    const modelResult = window.find(isEvent('tool_result'))?.data;
    const supplied = window.filter(isEvent('tool_call')).map(event => event.data)
      .find(event => event.tool_call_id === modelResult?.tool_call_id);
    receipt.proofs.model_tool_call = modelResult;
    receipt.proofs.supplied_seed = supplied ? { text: supplied.seed_yaml } : null;
    const modelStatus = await command('oracle', 'status');
    receipt.proofs.model_status = modelStatus.result;
    if (values.case === 'seed-bind' && typeof modelStatus.result.job?.seed?.text === 'string') {
      const drift = await command('qa_seed', 'drift');
      receipt.proofs.supplied_seed_drift = drift;
    }
    const ended = await command('oracle', 'end');
    receipt.proofs.ended = ended.state;
    receipt.provider_calls = owned.history.filter(isEvent('provider_request')).map(event => event.data);
    receipt.events = owned.history.filter(event => event.type === 'extension_event' &&
      event.name === 'oracle-qa.seed').map(event => event.data);
    receipt.mock_oracle_runs = mock.requests.filter(request => request.model === 'oracle').length;
    assertSeedObservation(receipt, { real: values.main === 'real', skill, host: true });
    receipt.adversarial.misleading_success_output = {
      result: 'passed', rule: 'Only structured tool status, branch state, hash, source, epoch and reload results decide pass.',
    };
    receipt.adversarial.cancel_resume = { result: 'not-applicable', reason: 'Binding is synchronous and starts no worker.' };
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = ['auth_changed', 'scenario_not_reached'].includes(error.code) ? error.code : 'failed';
    receipt.exit_code = 1;
    receipt.error = { type: error.code ?? 'assertion_failed', message: error.message };
    if (error.code === 'auth_changed') receipt.blocked_by_auth_guard = { ...receipt.error };
  } finally {
    if (owned) {
      await owned.stop({ force: true });
      receipt.raw_output = owned.metadata.raw_output;
      receipt.extension_receipts = owned.history.filter(event =>
        event.type === 'extension_event' && event.name === 'oracle-qa.seed').map(event => event.data);
    }
    if (mock) {
      receipt.mock_provider_calls = mock.requests;
      await mock.close();
      receipt.cleanup.mock_listener_closed = true;
    }
    if (sandbox && (!owned || owned.metadata.pid_gone)) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    receipt.cleanup.all_owned_pids_gone = receipt.children.every(child => child.pid_gone);
    if (!receipt.cleanup.all_owned_pids_gone) receipt.exit_code = 1;
    if (host && authBefore) {
      receipt.auth_after = authHashes();
      if (values.main === 'real' && !receipt.blocked_by_auth_guard) {
        finalizeAuthGuard(receipt, attemptDir);
        if (!receipt.auth_guard_passed) receipt.blocked_by_auth_guard = receipt.error;
      }
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
}
