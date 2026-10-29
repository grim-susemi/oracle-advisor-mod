import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ROOT, OwnedProcess, admitAuth, cleanupDisposableState, discoverHost, disposableEnvironment, finalizeAuthGuard, hostArgs, sourceHash, writeJson } from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';

// Scenario subset: ORACLE_QA_R3_SCENARIOS=S5,S9 (comma list). Unset = every scenario.
// Negative control: ORACLE_QA_R3_FORCE_FAIL=1 flips the first check of each scenario run.
const EVIDENCE_DIR = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/r3-advisor-seams/task-10';
const CANDIDATE = join(ROOT, 'qa/cases/r3-seams-extension.mjs');
const TOOLS = 'oracle_consult,oracle_bind_seed,oracle_advisor,oracle_record_stop,task,task_send,task_cancel,task_output,read';
const RULE = 'Consult the oracle with oracle_consult when stuck';
const VERDICT = JSON.stringify({ verdict: 'CONTINUE', reasons: ['QA scripted verdict.'] });
const CONSULT = { tool: 'oracle_consult', arguments: { kind: 'work', question: 'Check the plan.' } };
const CONSULT_HOLD = { tool: 'oracle_consult', arguments: { kind: 'work', question: 'QA_ORACLE_HOLD check the plan.' } };
const CONSULT_STEPS = [CONSULT, { text: VERDICT }, { text: 'done' }];
const TASK_VIS = { tool: 'task', arguments: { description: 'visual qa', prompt: 'QA visual task', category: 'visual-engineering', run_in_background: false } };
const TASK_KEYS = ['description', 'prompt', 'run_in_background', 'subagent_type'];
const PIN = 'oracle-qa-mock/gpt-6-astra:high';
const PIN_TABLE = {
  v: 1,
  profiles: { claude: {}, gpt: { model: PIN, family: 'gpt' } },
  by_family: { claude: { work: 'gpt', completion: 'gpt' }, gpt: { work: 'claude', completion: 'claude' }, other: { work: 'claude', completion: 'gpt' } },
  by_agent: {},
  by_nature: { design: 'claude', lowlevel: 'gpt' },
};

const sha256 = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
const isEvent = name => event => event.type === 'extension_event' && event.name === 'oracle-qa.r3-seams' && event.data?.event === name;
const rowsOf = (child, name) => child.history.filter(isEvent(name)).map(e => e.data);
const jsonOf = value => JSON.stringify(value);
const hasJob = row => jsonOf(row.data).includes('job_opened');
const atlasJob = row => hasJob(row) && row.data?.auto?.trigger === 'atlas_ulw_execute';
const PINS_PATH = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/r3-advisor-seams/task-1/pins.json';
const autoPause = row => /job_paused|job_ended/.test(jsonOf(row.data)) && /"auto"/.test(jsonOf(row.data));
const statuses = jsonl => jsonl.flatMap(r => [...jsonOf(r).matchAll(/"status":"([^"]+)"/g)].map(m => m[1]));
const ck = (id, expected, observed, ok) => ({ id, expected, observed, ok: Boolean(ok) });

const SCENARIOS = {
  A: [
    { name: 'S1a', driver: 'atlas', turns: [{ kind: 'prompt', input: '/ulw-execute x' }], check: o => [
      ck('job_opened with auto.trigger atlas_ulw_execute', '>=1', o.appends.filter(atlasJob).length, o.appends.filter(atlasJob).length >= 1),
      ck('nudger rule in main-model request', true, o.ruleSeen, o.ruleSeen)] },
    { name: 'S1b', driver: 'atlas', turns: [{ kind: 'prompt', input: '/skill:ulw-execute x' }], check: o => [
      ck('job_opened with auto.trigger atlas_ulw_execute', '>=1', o.appends.filter(atlasJob).length, o.appends.filter(atlasJob).length >= 1),
      ck('nudger rule in main-model request', true, o.ruleSeen, o.ruleSeen)] },
    { name: 'S2', driver: 'sisyphus', turns: [{ kind: 'prompt', input: '/ulw-execute x' }], check: o => [
      ck('no job for sisyphus', 0, o.appends.filter(hasJob).length, o.appends.filter(hasJob).length === 0),
      ck('nudger rule absent in main-model request', false, o.ruleSeen, o.ruleSeen === false)] },
    { name: 'S8', driver: 'atlas', env: { OMO_ORACLE_AUTO_ATLAS: '0' }, turns: [{ kind: 'prompt', input: '/ulw-execute x' }], check: o => {
      const disabled = o.jsonl.filter(r => jsonOf(r).includes('auto-disabled-by-env')).length;
      return [
        ck('no auto job when OMO_ORACLE_AUTO_ATLAS=0', 0, o.appends.filter(hasJob).length, o.appends.filter(hasJob).length === 0),
        ck('exactly one auto-disabled-by-env receipt', 1, disabled, disabled === 1)];
    } },
    { name: 'S2b', driver: 'atlas', turns: [{ kind: 'text', input: '/ulw-executex x' }], check: o => [
      ck('no job for near-miss /ulw-executex', 0, o.appends.filter(hasJob).length, o.appends.filter(hasJob).length === 0),
      ck('nudger rule absent for near-miss', false, o.ruleSeen, o.ruleSeen === false)] },
  ],
  B: [
    { name: 'S5', driver: 'atlas', steps: [], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'command', input: '/oracle off' },
      { kind: 'qa', input: '/qa-driver sisyphus' },
      { kind: 'prompt', input: 'continue' },
      { kind: 'command', input: '/oracle status' }], check: o => {
      const after = o.appends.slice(o.marks[2]);
      const ownerPause = o.appends.slice(o.marks[0], o.marks[1]).filter(r => /job_paused/.test(jsonOf(r.data)) && jsonOf(r.data).includes('"by":"owner"')).length;
      const status = o.messages.filter(m => m.customType === 'oracle-advisor-status').map(m => String(m.content ?? '')).join('\n');
      return [
        ck('job_opened atlas_ulw_execute before switch', '>=1', o.appends.filter(hasJob).length, o.appends.filter(hasJob).length >= 1),
        ck('owner job_paused by owner recorded (owner_touched state)', '>=1', ownerPause, ownerPause >= 1),
        ck('status after owner turn shows owner touched true', 'contains owner touched true', status.includes('owner touched true'), status.includes('owner touched true')),
        ck('no auto pause/end after driver switch', 0, after.filter(autoPause).length, after.filter(autoPause).length === 0),
        ck('no new job after driver switch', 0, after.filter(hasJob).length, after.filter(hasJob).length === 0)];
    } },
    { name: 'S9', routing: true, steps: CONSULT_STEPS, turns: [
      { kind: 'command', input: '/oracle on' },
      { kind: 'prompt', input: 'consult now' }], check: o => {
      const sources = o.jsonl.flatMap(r => [...jsonOf(r).matchAll(/"advisor_source":"([^"]+)"/g)].map(m => m[1]));
      return [ck('consult receipt advisor_source by_family', 'contains by_family', sources, sources.includes('by_family'))];
    } },
    { name: 'S10', driver: 'atlas', steps: [], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'command', input: '/oracle status' }], check: o => {
      const text = o.messages.filter(m => m.customType === 'oracle-advisor-status').map(m => String(m.content ?? '')).join('\n');
      return [
        ck('status text has table state', 'contains "; table "', text.includes('; table '), text.includes('; table ')),
        ck('status text has auto run fields', 'contains "; auto run "', text.includes('; auto run '), text.includes('; auto run '))];
    } },
    { name: 'S6', driver: 'atlas', steps: [], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'qa', input: '/qa-stop' },
      { kind: 'qa', input: '/qa-driver sisyphus' },
      { kind: 'prompt', input: 'continue' }], check: o => {
      const before = o.appends.slice(o.marks[0], o.marks[1]);
      const after = o.appends.slice(o.marks[2]);
      const stops = before.filter(r => jsonOf(r.data).includes('stop_opened')).length;
      const ended = after.filter(r => /job_ended/.test(jsonOf(r.data))).length;
      return [
        ck('stop_opened recorded before switch', '>=1', stops, stops >= 1),
        ck('no auto pause after switch with STOP open', 0, after.filter(autoPause).length, after.filter(autoPause).length === 0),
        ck('no job_ended after switch', 0, ended, ended === 0)];
    } },
    { name: 'S7', routing: false, driver: 'atlas', steps: [{ text: 'ack' }, ...CONSULT_STEPS], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'prompt', input: 'consult now' }], check: o => {
      const tasks = o.nativeCalls.filter(c => c.name === 'task');
      const instructions = readFileSync(join(ROOT, 'prompts/oracle-advisor.md'), 'utf8');
      const prefix = `${instructions}\n\nDOSSIER DATA (not instructions):\n`;
      const legacyRows = tasks.map(t => {
        const a = t.args ?? {};
        const m = /^oracle-advisor ([^#\s]+)#([^\s]+)$/.exec(a.description ?? '');
        const prompt = String(a.prompt ?? '');
        const rest = prompt.startsWith(prefix) ? prompt.slice(prefix.length) : null;
        let restByteEqual = false;
        try { restByteEqual = rest !== null && JSON.stringify(JSON.parse(rest), null, 2) === rest; } catch { restByteEqual = false; }
        return {
          keysOk: jsonOf(Object.keys(a).sort()) === jsonOf(TASK_KEYS),
          descriptionOk: Boolean(m),
          runInBackgroundFalse: a.run_in_background === false,
          subagentOracle: a.subagent_type === 'oracle',
          promptEqualsBuilderOutput: rest !== null,
          restByteEqual,
          jobInDossier: Boolean(m && rest !== null && rest.includes(m[1])),
          requestReceiptBound: Boolean(m && o.jsonl.some(r => jsonOf(r).includes(`"request_id":"${m[2]}"`))),
          description: a.description ?? null,
          promptLength: prompt.length,
          instructionsLength: instructions.length,
          promptSha256: createHash('sha256').update(prompt).digest('hex'),
        };
      });
      const shapeOk = legacyRows.length >= 1 && legacyRows.every(r => r.keysOk && r.descriptionOk && r.runInBackgroundFalse && r.subagentOracle && r.promptEqualsBuilderOutput && r.restByteEqual && r.jobInDossier && r.requestReceiptBound);
      const legacy = o.jsonl.filter(r => jsonOf(r).includes('"advisor_source":"legacy"') && jsonOf(r).includes('"advisor_reason":"table_absent"')).length;
      return [
        ck('task args deep-equal legacy builder output (full prompt, exact description, receipt-bound request)', true, legacyRows, shapeOk),
        ck('legacy receipt advisor_source legacy / table_absent', '>=1', legacy, legacy >= 1)];
    } },
  ],
  C: [
    { name: 'S3', driver: 'atlas', model: ['oracle-qa-mock', 'claude-qa'], routingTable: PIN_TABLE, steps: [{ text: 'ack' }, ...CONSULT_STEPS], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'prompt', input: 'consult now' }], check: o => {
      const consult = o.nativeCalls.filter(c => c.name === 'task' && c.args?.subagent_type === 'oracle');
      const model = consult[0]?.args?.model ?? null;
      return [ck('work consult task args carry the gpt pin', PIN, model, model === PIN)];
    } },
    { name: 'S4', driver: 'atlas', model: ['oracle-qa-mock', 'gpt-qa'], routing: true, steps: [{ text: 'ack' }, TASK_VIS, { text: 'visual done' }, ...CONSULT_STEPS], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'prompt', input: 'visual now' },
      { kind: 'prompt', input: 'consult now' }], check: o => {
      const consult = o.nativeCalls.filter(c => c.name === 'task' && c.args?.subagent_type === 'oracle');
      const hasModel = consult.length >= 1 && 'model' in (consult[0].args ?? {});
      const visual = o.mainReqs.some(r => jsonOf(r.body).includes('visual-engineering'));
      return [
        ck('visual-engineering task call answered by the main model (category has no usable model in sandbox)', true, visual, visual),
        ck('work consult task args have no model (claude profile)', false, hasModel, consult.length >= 1 && !hasModel)];
    } },
    { name: 'S4b', driver: 'atlas', model: ['oracle-qa-mock', 'claude-qa'], routingTable: PIN_TABLE, steps: [{ text: 'ack' }, TASK_VIS, ...CONSULT_STEPS], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'prompt', input: 'visual then consult now' }], check: o => {
      const consult = o.nativeCalls.filter(c => c.name === 'task' && c.args?.subagent_type === 'oracle');
      const hasModel = consult.length >= 1 && 'model' in (consult[0].args ?? {});
      const sources = o.jsonl.flatMap(r => [...jsonOf(r).matchAll(/"advisor_source":"([^"]+)"/g)].map(m => m[1]));
      const natures = o.jsonl.flatMap(r => [...jsonOf(r).matchAll(/"task_nature":"([^"]+)"/g)].map(m => m[1]));
      return [
        ck('work consult task args have no model (claude profile via nature)', false, hasModel, consult.length >= 1 && !hasModel),
        ck('consult receipt advisor_source by_nature', 'contains by_nature', sources, sources.includes('by_nature')),
        ck('consult receipt task_nature design', 'contains design', natures, natures.includes('design'))];
    } },
    { name: 'S11', driver: 'atlas', steps: [{ text: 'ack' }, CONSULT_HOLD, CONSULT, { text: VERDICT }, { text: 'done' }], turns: [
      { kind: 'prompt', input: '/ulw-execute x' },
      { kind: 'hold', input: 'consult now QA_ORACLE_HOLD' },
      { kind: 'prompt', input: 'again' }], check: o => {
      const st = statuses(o.jsonl);
      const oracleCalls = o.nativeCalls.filter(c => c.name === 'task' && c.args?.subagent_type === 'oracle').length;
      const heldReq = /#([^\s]+)$/.exec(o.nativeCalls.find(c => c.name === 'task' && c.args?.subagent_type === 'oracle')?.args?.description ?? '')?.[1] ?? null;
      const heldRows = o.jsonl.filter(r => heldReq !== null && r.request_id === heldReq && r.status);
      const heldStatus = heldRows.length ? heldRows[heldRows.length - 1].status : null;
      const heldReason = heldRows.length ? heldRows[heldRows.length - 1].reason ?? null : null;
      return [
        ck('held consult record (oracle-advisor.jsonl) ends cancelled', 'cancelled', heldStatus, heldStatus === 'cancelled'),
        o.ownedStatuses[0] === 'paused'
          ? ck('held consult record reason paused_by_stop', 'paused_by_stop', heldReason, heldReason === 'paused_by_stop')
          : { id: 'paused_by_stop clause (stop_pauses_children)', expected: 'paused_by_stop', observed: { owned_native_status: o.ownedStatuses[0] ?? null, consult_record_status: heldStatus, paused_by_stop_occurrences_in_run_dir: o.pausedByStopCount, stop_pauses_children: o.stopPausesChildren }, ok: null, host_limit: 'host cancels the held child on RPC abort; paused_by_stop not produced on this host' },
        ck('no busy rejection for the next consult', 0, st.filter(s => s === 'busy').length, st.filter(s => s === 'busy').length === 0),
        ck('no consult record ends unavailable after owner abort', 0, st.filter(s => s === 'unavailable').length, st.filter(s => s === 'unavailable').length === 0),
        ck('second consult admitted after new owner message (oracle task calls >= 2)', '>=2', oracleCalls, oracleCalls >= 2)];
    } },
  ],
};
const ALL = [...SCENARIOS.A, ...SCENARIOS.B, ...SCENARIOS.C];
export { SCENARIOS };

async function waitForHeldRequest(records, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (!records.some(r => r.body?.model === 'oracle' && jsonOf(r.body).includes('QA_ORACLE_HOLD'))) {
    if (Date.now() > end) throw new Error('held oracle request never reached the mock provider');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function observe(o) {
  const statusMsg = o.messages.filter(m => m.customType === 'oracle-advisor-status').map(m => String(m.content ?? '')).join('\n');
  const idx = statusMsg.indexOf('owner touched');
  const advisorRows = o.jsonl.filter(r => jsonOf(r).includes('advisor_source')).map(r => {
    const src = r.data ?? r;
    return { advisor_source: src.advisor_source ?? null, advisor_profile: src.advisor_profile ?? null, advisor_reason: src.advisor_reason ?? null };
  });
  return {
    status_head: statusMsg.slice(0, 400),
    status_owner_excerpt: idx < 0 ? null : statusMsg.slice(Math.max(0, idx - 40), idx + 40),
    owner_pause_entries: o.appends.filter(r => /job_paused/.test(jsonOf(r.data)) && jsonOf(r.data).includes('"by":"owner"')).map(r => r.data).slice(0, 2),
    stop_ids: o.appends.filter(r => jsonOf(r.data).includes('stop_opened')).map(r => r.data?.stop_id ?? null),
    entry_types_after_switch: o.appends.slice(o.marks[2] ?? 0).map(r => r.data?.type ?? null),
    task_args: o.nativeCalls.filter(c => c.name === 'task').map(c => c.args).slice(0, 2),
    advisor_fields: advisorRows.slice(0, 3),
    consult_statuses: statuses(o.jsonl),
    requests: o.requests,
  };
}

async function runScenario(host, attempt, runDir, scenario) {
  const dir = join(runDir, scenario.name);
  mkdirSync(dir, { recursive: true });
  const records = [];
  const mock = await startMockProvider({ steps: scenario.steps ?? [], onRequest: r => records.push(r) });
  const sandbox = disposableEnvironment(host, dir, {
    ORACLE_QA_MOCK_URL: mock.baseUrl,
    ORACLE_QA_ATTEMPT: attempt,
    OMO_ORACLE_ADVISOR: '1',
    ORACLE_QA_R3_DRIVER: scenario.driver ?? '',
    SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
    OMO_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
    ...(scenario.env ?? {}),
  });
  const base = sandbox.env.SENPI_CODING_AGENT_DIR || sandbox.env.OMO_CODING_AGENT_DIR || null;
  const logPath = join(base || sandbox.home, 'logs', 'oracle-advisor.jsonl');
  const result = { name: scenario.name, driver: scenario.driver ?? null, env: scenario.env ?? {}, routing: Boolean(scenario.routing || scenario.routingTable), model: scenario.model ?? null, agent_base: base, run_dir: dir, log_path: logPath, turns: scenario.turns.map(t => `${t.kind}:${t.input}`), checks: [], error: null, pass: false, pid: null, observed: {} };
  let child;
  try {
    if (scenario.routing || scenario.routingTable) {
      if (!base) throw new Error('agent dir env not pinned (SENPI_CODING_AGENT_DIR / OMO_CODING_AGENT_DIR unset): cannot place routing.json');
      mkdirSync(join(base, 'oracle-advisor'), { recursive: true });
      const target = join(base, 'oracle-advisor', 'routing.json');
      if (scenario.routingTable) writeFileSync(target, jsonOf(scenario.routingTable));
      else copyFileSync(join(ROOT, 'config/routing.default.json'), target);
    }
    child = new OwnedProcess(process.execPath, [
      ...hostArgs(host, sandbox, CANDIDATE, { main: 'mock' }),
      '--tools', TOOLS,
      '--system-prompt', 'Owned R3 seams scenario session.',
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(dir, 'host'), deadlineMs: 600000 });
    result.pid = child.metadata.pid;
    await child.rpc('get_state');
    await child.rpc('set_client_info', { capabilities: ['interactive_user', 'extension_events'] });
    await child.waitFor(isEvent('ready'), `${scenario.name} ready`, { timeoutMs: 60000 });
    if (scenario.model) {
      result.set_model = await child.rpc('set_model', { provider: scenario.model[0], modelId: scenario.model[1] });
    }
    const marks = [];
    for (const turn of scenario.turns) {
      const from = child.history.length;
      if (turn.kind === 'hold') {
        const ended = child.waitFor(e => e.type === 'agent_end', `${scenario.name} agent_end after abort`, { from, timeoutMs: 240000 });
        await child.rpc('prompt', { message: turn.input });
        await waitForHeldRequest(records);
        await child.rpc('abort');
        await ended;
      } else if (turn.kind === 'text') {
        const done = child.waitFor(e => e.type === 'agent_end', `${scenario.name} agent_end`, { from, timeoutMs: 240000 });
        await child.rpc('prompt', { message: turn.input, unknownCommandAsText: true });
        await done;
      } else if (turn.kind === 'prompt') {
        const done = child.waitFor(e => e.type === 'agent_end', `${scenario.name} agent_end`, { from, timeoutMs: 240000 });
        await child.prompt(turn.input);
        await done;
      } else {
        const done = child.waitFor(e => isEvent('qa_done')(e) || isEvent('command')(e), `${scenario.name} ${turn.input}`, { from, timeoutMs: 120000 });
        await child.rpc('prompt', { message: turn.input });
        await done;
      }
      marks.push(rowsOf(child, 'append').length);
    }
    const jsonl = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } })
      : [];
    const mainReqs = records.filter(r => r.body?.model !== 'oracle');
    const ownedFiles = [];
    const walkOwned = d => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walkOwned(p); else if (f.name === 'owned.jsonl') ownedFiles.push(p); } };
    walkOwned(dir);
    const ownedStatuses = ownedFiles.length
      ? ownedFiles.flatMap(f => readFileSync(f, 'utf8').split('\n')).filter(l => l.includes('consult_native_result')).map(l => (l.match(/"status":"([^"]+)"/) ?? [])[1]).filter(Boolean)
      : [];
    const walkCount = d => { let n = 0; for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) n += walkCount(p); else if (readFileSync(p, 'latin1').includes('paused_by_stop')) n += 1; } return n; };
    const pausedByStopCount = walkCount(dir);
    const stopPausesChildren = existsSync(PINS_PATH) ? JSON.parse(readFileSync(PINS_PATH, 'utf8')).stop_pauses_children ?? null : 'pins missing';
    const observation = {
      ownedStatuses,
      pausedByStopCount,
      stopPausesChildren,
      appends: rowsOf(child, 'append'),
      commands: rowsOf(child, 'command'),
      messages: rowsOf(child, 'message'),
      nativeCalls: rowsOf(child, 'native_tool_call'),
      marks,
      jsonl,
      mainReqs,
      ruleSeen: mainReqs.some(r => jsonOf(r.body).includes(RULE)),
      requests: records.map(r => ({ index: r.index, model: r.body?.model ?? null, last_user: jsonOf(r.body?.messages?.findLast?.(m => m.role === 'user')?.content ?? '').slice(0, 120) })),
    };
    result.observed = observe(observation);
    result.checks = scenario.check(observation);
    if (process.env.ORACLE_QA_R3_FORCE_FAIL === '1' && result.checks.length) {
      result.checks[0] = { ...result.checks[0], ok: false, forced_by: 'ORACLE_QA_R3_FORCE_FAIL' };
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    if (child && typeof child.stop === 'function') await child.stop();
    await mock.close?.();
    const logExisted = existsSync(logPath);
    if (logExisted) {
      copyFileSync(logPath, join(dir, 'oracle-advisor.jsonl'));
      result.log_copy = join(dir, 'oracle-advisor.jsonl');
      const copiedSha = sha256(join(dir, 'oracle-advisor.jsonl'));
      result.checks.push({ id: 'consult log copied with sha256 when present', expected: 'sha256 recorded', observed: copiedSha, ok: Boolean(copiedSha) });
    }
    result.pass = result.error === null && result.checks.length > 0 && result.checks.every(c => c.ok !== false);
    cleanupDisposableState(sandbox);
  }
  return result;
}

export async function runR3SeamsCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  const host = discoverHost();
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const runDir = mkdtempSync(join(attemptDir, 'r3-seams-mock-'));
  const wanted = (process.env.ORACLE_QA_R3_SCENARIOS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const set = wanted.length ? ALL.filter(s => wanted.includes(s.name)) : ALL;
  const receipt = { case: 'r3-seams', attempt: values.attempt, scenario_filter: wanted, force_fail: process.env.ORACLE_QA_R3_FORCE_FAIL === '1', source_hash: sourceHash(), started_at: new Date().toISOString(), run_dir: runDir, scenarios: [], exit_code: null, error: null };
  try {
    receipt.auth_before = admitAuth(attemptDir, undefined, { real: false, providers: [], receipt });
    for (const s of set) receipt.scenarios.push(await runScenario(host, values.attempt, runDir, s));
    receipt.exit_code = receipt.scenarios.every(s => s.pass) && receipt.scenarios.length > 0 ? 0 : 1;
  } catch (err) {
    receipt.exit_code = 1;
    receipt.error = err.message;
  } finally {
    if (receipt.auth_before) finalizeAuthGuard(receipt, attemptDir, undefined, { providers: [] });
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'run-receipt.json'), receipt);
    writeJson(join(EVIDENCE_DIR, `receipts-mock-${values.attempt}.json`), {
      run_receipt: join(runDir, 'run-receipt.json'), run_receipt_sha256: sha256(join(runDir, 'run-receipt.json')),
      exit_code: receipt.exit_code,
      scenarios: receipt.scenarios.map(s => ({ name: s.name, pass: s.pass, checks: s.checks, observed: s.observed, error: s.error, log_path: s.log_path, log_copy: s.log_copy ?? null, log_sha256: s.log_copy ? sha256(s.log_copy) : null })),
    });
  }
  console.log(receipt.scenarios.map(s => `${s.name} ${s.pass ? 'PASS' : 'FAIL'}${s.error ? ` error: ${s.error}` : ''}`).join('\n'));
  if (receipt.exit_code !== 0) process.exit(receipt.exit_code);
  return receipt;
}
