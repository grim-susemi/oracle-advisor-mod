import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { evaluateVerdict } from '../qa/verdict-spec.mjs';
import { startTransportProvider } from '../qa/transport-provider.mjs';

const observation = ({ legacy = false } = {}) => {
  const job = { job_id: 'J1', job_epoch: 1 };
  const o = { case: 'resident-stuck', oracle_mode: 'mock', decision: { live_residency: 'disabled' },
    events: [{ event: 'evidence', kind: 'session_start', entries: [] },
      { event: 'evidence', kind: 'ledger', record: { type: 'job_opened', ...job } }],
    consults: [], retired_records: [], mock_provider_calls: [] };
  const evidence = (kind, data) => o.events.push({ event: 'evidence', kind, ...data });
  for (let n = 1; n <= 3; n++) {
    const wrapper = `wrapper-${n}`, id = `consult-${n}`, task = `task-${n}`, native = `native-${n}`;
    const status = n === 1 ? 'answered' : 'cancelled';
    const request = { ...job, request_id: id };
    const prompt = n === 1 ? 'Review this owned QA observation.' : `QA_TRANSPORT_HOLD ${id}`;
    evidence('attempt', { call_id: wrapper, name: 'qa_transport_run', input: {} });
    evidence('attempt', { call_id: id, parent_id: wrapper, name: 'oracle_consult', input: { kind: 'work' } });
    evidence('ledger', { record: { type: 'consult_admitted', ...request } });
    evidence('attempt', { call_id: native, parent_id: id, name: 'task',
      input: { subagent_type: 'oracle', run_in_background: false, prompt } });
    evidence('ledger', { record: { type: 'oracle_assigned', ...request, oracle_task_id: task } });
    const provider = { index: n, model: 'oracle', started_at: n,
      text: JSON.stringify([{ type: 'text', text: `Task id: ${task}.\nTask:\n${prompt}` }]) };
    if (!legacy) provider.provider_request_id = `provider-${n}`;
    if (n === 1) provider.ended_at = n;
    else {
      if (!legacy) {
        provider.held_at = n;
        o.events.push({ event: 'provider_hold', source: 'qa.transport-provider',
          provider_request_id: provider.provider_request_id, ...request, call_id: native, task_id: task });
      }
      evidence('attempt', { call_id: `read-${n}`, name: 'task_output', input: { task_id: task } });
      evidence('executed', { call_id: `read-${n}`, name: 'task_output', is_error: false,
        result: { details: { snapshot: { task_id: task, status: 'running', model: 'oracle-qa-mock/oracle' } } } });
      evidence('attempt', { call_id: `cancel-${n}`, name: 'task_cancel', input: { task_id: task } });
      evidence('executed', { call_id: `cancel-${n}`, name: 'task_cancel', is_error: false, result: {} });
    }
    o.mock_provider_calls.push(provider);
    const raw = { task_id: task, status: n === 1 ? 'completed' : 'cancelled', run_epoch: 0, model_called: true };
    evidence('executed', { call_id: native, parent_id: id, name: 'task', is_error: false, result: { details: raw } });
    evidence('ledger', { record: { type: 'consult_native_result', ...request, native_attempt: '1',
      native_result: { ...raw, isError: false } } });
    evidence('ledger', { record: { type: 'oracle_retired', ...job, oracle_task_id: task, confirmed: true } });
    evidence('ledger', { record: { type: 'consult_finished', ...request, oracle_task_id: task, status } });
    evidence('executed', { call_id: id, parent_id: wrapper, name: 'oracle_consult', result: { details: { status } } });
    evidence('executed', { call_id: wrapper, name: 'qa_transport_run', result: { details: { status } } });
    o.consults.push({ ...request, toolCallId: wrapper, oracle_task_id: task, status });
    o.retired_records.push({ task_id: task, status: n === 1 ? 'completed' : 'cancelled', residency_state: 'persisted_only' });
  }
  return o;
};

const check = o => {
  for (const real of [false, true]) evaluateVerdict(o.case, structuredClone(o), { real, host: true });
};

test('central table accepts current and preserved raw native controlled-hold proofs', () => {
  check(observation());
  check(observation({ legacy: true }));
});

test('central table rejects H1/H2 route relabels and borrowed or missing raw hold identities', () => {
  const mutations = [
    o => { o.oracle_mode = 'real'; },
    o => { o.oracle_mode = 'real'; o.events = o.events.filter(event => event.event !== 'provider_hold'); },
    o => { o.events = o.events.filter(event => event.event !== 'provider_hold'); },
    o => { o.mock_provider_calls = []; },
    o => { o.mock_provider_calls[1].model = 'main'; },
    o => { o.mock_provider_calls[1].text = o.mock_provider_calls[2].text; },
    o => { o.mock_provider_calls[1].provider_request_id = o.mock_provider_calls[2].provider_request_id; },
    o => { o.mock_provider_calls[1].ended_at = 9; },
    o => { delete o.mock_provider_calls[1].held_at; },
    o => { o.events.find(event => event.event === 'provider_hold').source = 'fixture-label'; },
    ...['request_id', 'call_id', 'task_id', 'job_id', 'job_epoch', 'provider_request_id'].map(key =>
      o => { o.events.find(event => event.event === 'provider_hold')[key] = 'unrelated'; }),
    o => { const index = o.events.findIndex(event => event.event === 'provider_hold');
      o.events.push(...o.events.splice(index, 1)); },
    o => { o.events.push(structuredClone(o.events.find(event => event.event === 'provider_hold'))); },
    o => { o.events.find(event => event.name === 'task' && event.call_id === 'native-2').input.prompt = 'other prompt'; },
  ];
  for (const mutate of mutations) {
    const changed = observation();
    mutate(changed);
    assert.throws(() => check(changed), error =>
      error.verdict_phase === 'admission' && Boolean(error.verdict_row));
  }
  const legacy = observation({ legacy: true });
  legacy.events.find(event => event.call_id === 'read-2' && event.kind === 'executed')
    .result.details.snapshot.task_id = 'task-3';
  assert.throws(() => check(legacy));
});

test('local provider emits a unique raw held request before release without a model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-hold-provider-'));
  const provider = await startTransportProvider(join(dir, 'provider.jsonl'));
  try {
    const held = once(provider.events, 'held', { signal: AbortSignal.timeout(5000) });
    const response = fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'oracle', messages: [{ role: 'user',
        content: 'Task id: task-1.\nTask:\nQA_TRANSPORT_HOLD consult-1' }] }) });
    const [raw] = await held;
    assert.equal(raw.model, 'oracle');
    assert.equal(typeof raw.provider_request_id, 'string');
    assert.ok(Number.isFinite(raw.held_at));
    assert.equal(raw.ended_at, undefined);
    const finished = once(provider.events, 'finished', { signal: AbortSignal.timeout(5000) });
    provider.release(raw.index);
    await finished;
    assert.ok((await (await response).text()).includes('[DONE]'));
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('QA observer binds a raw provider hold to the actual in-flight dispatch before cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-hold-observer-'));
  const previousLog = process.env.ORACLE_QA_PROBE_LOG;
  process.env.ORACLE_QA_PROBE_LOG = join(dir, 'probe.jsonl');
  const key = `hold-observer-${dir}`;
  const request = { request_id: 'consult-1', job_id: 'J1', job_epoch: 1 };
  const runtime = { ledger: { state: { requests: { 'consult-1': request } } },
    transport: { running: { request_id: 'consult-1', oracle_task_id: 'task-1' },
      consult: async () => ({}), isRetirementCall: () => false }, registerTool() {} };
  globalThis[key] = runtime;
  const url = new URL('../qa/transport-extension.mjs', import.meta.url);
  url.searchParams.set('hold-test', dir);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === url.href && specifier === '../src/extension.mjs') return {
      shortCircuit: true, url: 'data:text/javascript,' +
        encodeURIComponent(`export default () => globalThis[${JSON.stringify(key)}];`) };
    return next(specifier, context);
  } });
  try {
    const handlers = new Map(), listeners = [], emitted = [];
    const pi = { on(name, handler) { if (name === 'tool_call') listeners.push(handler); },
      rpc: { handle(name, handler) { handlers.set(name, handler); },
        emit(_name, event) { emitted.push(event); } } };
    (await import(url.href)).default(pi);
    for (const listener of listeners) listener({ toolName: 'task', toolCallId: 'native-1',
      parentToolCallId: 'consult-1', input: { subagent_type: 'oracle', prompt: 'QA_TRANSPORT_HOLD consult-1' } }, {});
    const hold = handlers.get('oracle.transport.provider_hold');
    const raw = { provider_request_id: 'provider-1', held_at: 1, model: 'oracle',
      text: 'Task id: task-1.\nTask:\nQA_TRANSPORT_HOLD consult-1' };
    assert.deepEqual(hold(raw), { source: 'qa.transport-provider', provider_request_id: 'provider-1',
      ...request, call_id: 'native-1', task_id: 'task-1' });
    assert.equal(emitted.at(-1).event, 'provider_hold');
    assert.throws(() => hold({ ...raw, text: raw.text.replace('task-1', 'task-2') }));
    assert.throws(() => hold({ ...raw, model: 'main' }));
    assert.throws(() => hold({ ...raw, text: raw.text.replace('consult-1', 'consult-2') }));
    runtime.transport.running = null;
    assert.throws(() => hold(raw));
  } finally {
    hooks.deregister();
    delete globalThis[key];
    if (previousLog === undefined) delete process.env.ORACLE_QA_PROBE_LOG;
    else process.env.ORACLE_QA_PROBE_LOG = previousLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
