import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ROOT, OwnedProcess, admitAuth, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, hostArgs, sourceHash, writeJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';

// Two real consults on the ollama route (oracle role) with the main model mocked.
// R1: completion consult -> task args carry the pin; R2: work consult -> no model arg.
// --oracle mock runs the same two consults against the local mock oracle (zero provider calls).
const EVIDENCE_DIR = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/r3-advisor-seams/task-10';
const CANDIDATE = join(ROOT, 'qa/cases/r3-seams-extension.mjs');
const TOOLS = 'oracle_consult,oracle_bind_seed,oracle_advisor,oracle_record_stop,task,task_send,task_cancel,task_output,read';
const MOCK_VERDICTS = {
  continue: { verdict: 'CONTINUE', reasons: ['QA scripted verdict.'] },
  redirect: { verdict: 'REDIRECT', reasons: [{ text: 'QA scripted redirect.' }] },
};
const VERDICT = JSON.stringify(MOCK_VERDICTS[process.env.ORACLE_QA_R3_MOCK_VERDICT || 'continue']);
const consultStep = kind => ({ tool: 'oracle_consult', arguments: { kind, question: `Check the plan (${kind}).` } });
const LEGACY_KEYS = ['description', 'prompt', 'run_in_background', 'subagent_type'];
const PIN_LEVEL = 'off';

const sha256 = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
const isEvent = name => event => event.type === 'extension_event' && event.name === 'oracle-qa.r3-seams' && event.data?.event === name;
const rowsOf = (child, name) => child.history.filter(isEvent(name)).map(e => e.data);
const jsonOf = value => JSON.stringify(value);
const ck = (id, expected, observed, ok) => ({ id, expected, observed, ok: Boolean(ok) });

export async function runR3SeamsRealCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (values.main !== 'mock' || !['mock', 'real'].includes(values.oracle)) throw new Error('r3-seams-real needs --main mock and --oracle mock|real');
  const real = values.oracle === 'real';
  const providers = real ? ['ollama'] : [];
  const oracleModel = real ? 'ollama/deepseek-v4.1-flash' : 'oracle-qa-mock/oracle';
  const shortModel = real ? 'deepseek-v4.1-flash' : 'oracle';
  const pin = `${oracleModel}:${PIN_LEVEL}`;
  const routingTable = {
    v: 1,
    profiles: { claude: {}, pinned: { model: pin, family: 'other' } },
    by_family: {
      claude: { work: 'claude', completion: 'claude' },
      gpt: { work: 'claude', completion: 'claude' },
      other: { work: 'claude', completion: 'pinned' },
    },
    by_agent: {},
    by_nature: { design: 'claude', lowlevel: 'claude' },
  };
  // qa/mock-provider.mjs serves the main model and, in dry runs only, the mock oracle from one
  // steps queue. A real oracle never reads that queue, so a VERDICT step there lands on the main
  // turn and the next turn consumes 'done' instead of consulting. Real runs therefore omit it.
  const r2Only = process.env.ORACLE_QA_R3_ONLY === 'r2';
  const verdictStep = real ? [] : [{ text: VERDICT }];
  const steps = [
    ...(r2Only ? [] : [consultStep('completion'), ...verdictStep, { text: 'done' }]),
    consultStep('work'), ...verdictStep, { text: 'done' },
  ];
  const turns = [
    { kind: 'command', input: '/oracle on' },
    ...(r2Only ? [] : [{ kind: 'prompt', input: 'consult completion now' }]),
    { kind: 'prompt', input: 'consult work now' },
  ];
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const runDir = mkdtempSync(join(attemptDir, 'r3-seams-real-'));
  const receipt = {
    case: 'r3-seams-real', attempt: values.attempt, oracle_mode: values.oracle, main_mode: values.main,
    providers, pin, oracle_model: oracleModel, source_hash: sourceHash(), started_at: new Date().toISOString(),
    run_dir: runDir, exit_code: null, error: null, checks: [], dispatches: [], advisor_receipts: [],
    real_consults: 0, auth_before: null, auth_guard: null,
  };
  let child, sandbox, mock;
  try {
    const host = discoverHost();
    receipt.auth_before = admitAuth(attemptDir, undefined, { real, providers, receipt });
    mock = await startMockProvider({ steps, onRequest: () => {} });
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_MOCK_URL: mock.baseUrl,
      ORACLE_QA_ATTEMPT: values.attempt,
      ORACLE_QA_ATTEMPT_DIR: attemptDir,
      ORACLE_QA_REAL_ORACLE: real ? '1' : '0',
      OMO_ORACLE_ADVISOR: '1',
      ORACLE_QA_R3_DRIVER: '',
      SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
      OMO_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
    });
    const base = sandbox.env.SENPI_CODING_AGENT_DIR || sandbox.env.OMO_CODING_AGENT_DIR;
    if (!base) throw new Error('agent dir env not pinned (SENPI_CODING_AGENT_DIR / OMO_CODING_AGENT_DIR unset)');
    const logPath = join(base, 'logs', 'oracle-advisor.jsonl');
    mkdirSync(join(base, 'oracle-advisor'), { recursive: true });
    writeFileSync(join(base, 'oracle-advisor', 'routing.json'), jsonOf(routingTable));
    writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: join(sandbox.stateDir, 'senpi-task'), default_execution_mode: 'in-process' },
        agents: { oracle: { model: oracleModel, tools: { read: true, lsp_diagnostics: true, lsp_symbols: true } } },
      },
    });
    child = new OwnedProcess(process.execPath, [
      ...hostArgs(host, sandbox, CANDIDATE, { main: 'mock' }),
      ...(real ? ['--extension', join(ROOT, 'qa/main-provider.mjs')] : []),
      '--tools', TOOLS,
      '--system-prompt', 'Owned R3 real-seams session.',
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'host'), deadlineMs: 900000 });
    receipt.child_pid = child.metadata.pid;
    await child.rpc('get_state');
    await child.rpc('set_client_info', { capabilities: ['interactive_user', 'extension_events'] });
    await child.waitFor(isEvent('ready'), 'r3-seams-real ready', { timeoutMs: 60000 });
    for (const turn of turns) {
      const from = child.history.length;
      if (turn.kind === 'command') {
        const done = child.waitFor(e => isEvent('qa_done')(e) || isEvent('command')(e), `${turn.input}`, { from, timeoutMs: 120000 });
        await child.rpc('prompt', { message: turn.input });
        await done;
      } else {
        const done = child.waitFor(e => e.type === 'agent_end', `${turn.input} agent_end`, { from, timeoutMs: 900000 });
        await child.prompt(turn.input);
        await done;
      }
    }
    receipt.dispatches = rowsOf(child, 'native_tool_call').filter(c => ['task', 'task_send'].includes(c.name))
      .map(c => ({ name: c.name, keys: Object.keys(c.args ?? {}).sort(), model: c.args?.model ?? null, args: c.args }));
    const jsonl = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    receipt.advisor_receipts = jsonl.filter(r => r.advisor_profile !== undefined)
      .map(r => ({ advisor_profile: r.advisor_profile, advisor_source: r.advisor_source ?? null, model: r.model ?? null }));
    receipt.real_consults = real ? receipt.advisor_receipts.length : 0;
    const [r1, r2] = receipt.dispatches;
    const [a1, a2] = receipt.advisor_receipts;
    receipt.checks = r2Only ? [
      ck('exactly one consult dispatch', 1, receipt.dispatches.length, receipt.dispatches.length === 1),
      ck('R2 task args carry NO model (legacy keys only)', LEGACY_KEYS.slice().sort(), r1?.keys ?? null,
        jsonOf(r1?.keys) === jsonOf(LEGACY_KEYS.slice().sort()) && r1?.model === null),
      ck('R2 receipt advisor_profile claude', 'claude', a1?.advisor_profile ?? null, a1?.advisor_profile === 'claude'),
      ck(`R2 receipt model ${shortModel}`, shortModel, a1?.model ?? null, String(a1?.model ?? '').includes(shortModel)),
    ] : [
      ck('exactly two consult dispatches', 2, receipt.dispatches.length, receipt.dispatches.length === 2),
      ck('R1 task args carry pin', pin, r1?.model ?? null, r1?.model === pin),
      ck('R1 task args key set is legacy plus model', [...LEGACY_KEYS, 'model'].sort(), r1?.keys ?? null,
        jsonOf(r1?.keys) === jsonOf([...LEGACY_KEYS, 'model'].sort())),
      ck('R2 task args carry NO model (legacy keys only)', LEGACY_KEYS.slice().sort(), r2?.keys ?? null,
        jsonOf(r2?.keys) === jsonOf(LEGACY_KEYS.slice().sort()) && r2?.model === null),
      ck('R1 receipt advisor_profile pinned', 'pinned', a1?.advisor_profile ?? null, a1?.advisor_profile === 'pinned'),
      ck('R1 receipt advisor_source by_family', 'by_family', a1?.advisor_source ?? null, a1?.advisor_source === 'by_family'),
      ck(`R1 receipt model ${shortModel}`, shortModel, a1?.model ?? null, String(a1?.model ?? '').includes(shortModel)),
      ck('R2 receipt advisor_profile claude', 'claude', a2?.advisor_profile ?? null, a2?.advisor_profile === 'claude'),
      ck(`R2 receipt model ${shortModel}`, shortModel, a2?.model ?? null, String(a2?.model ?? '').includes(shortModel)),
    ];
    if (real) copyFileSync(logPath, join(runDir, 'oracle-advisor.jsonl'));
    receipt.exit_code = receipt.checks.every(c => c.ok) ? 0 : 1;
  } catch (err) {
    receipt.exit_code = 1;
    receipt.error = { code: err.code ?? 'assertion_failed', message: err.message };
  } finally {
    if (child) await child.stop({ force: true });
    if (mock) await mock.close?.();
    if (sandbox) receipt.disposable_state_removed = cleanupDisposableState(sandbox).removed ?? null;
    if (receipt.auth_before) finalizeAuthGuard(receipt, attemptDir, undefined, { providers });
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'run-receipt.json'), receipt);
    writeJson(join(EVIDENCE_DIR, `receipts-r3-seams-real-${values.attempt}.json`), {
      run_receipt: join(runDir, 'run-receipt.json'), run_receipt_sha256: sha256(join(runDir, 'run-receipt.json')),
      exit_code: receipt.exit_code, real_consults: receipt.real_consults, checks: receipt.checks,
      dispatches: receipt.dispatches, advisor_receipts: receipt.advisor_receipts, auth_guard: receipt.auth_guard,
      error: receipt.error,
    });
  }
  console.log(`r3-seams-real exit ${receipt.exit_code} real_consults ${receipt.real_consults}`);
  for (const c of receipt.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id}: expected ${jsonOf(c.expected)} observed ${jsonOf(c.observed)}`);
  if (receipt.error) console.log(`error ${receipt.error.code}: ${receipt.error.message}`);
  if (receipt.exit_code !== 0) process.exit(receipt.exit_code);
  return receipt;
}
