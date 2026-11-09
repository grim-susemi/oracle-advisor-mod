import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLedger } from '../src/ledger.mjs';
import { createTransport, TRANSPORT_DECISION } from '../src/transport.mjs';
import { registerConsultTool } from '../src/consult.mjs';
import { registerCommands } from '../src/commands.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';
import { RECEIPT_FIELDS } from '../src/contracts.mjs';

const defaultRouting = {
  v: 1,
  profiles: {
    claude: {},
    gpt: {
      model: 'chatgpt-subscription/gpt-6-astra:high',
      family: 'gpt',
    },
  },
  by_family: {
    claude: { work: 'gpt', completion: 'gpt' },
    gpt: { work: 'claude', completion: 'claude' },
    other: { work: 'claude', completion: 'gpt' },
  },
  by_agent: {},
  by_nature: {
    design: 'claude',
    lowlevel: 'gpt',
  },
};

const verdict = '{"verdict":"CONTINUE","reasons":[]}';
const outcome = (details, text = '', isError = false) => ({
  toolCall: {}, result: { details, content: [{ type: 'text', text }] }, isError,
});

// Measured entry shapes (host.stdout.log 1720, 1724, 2063; owned.jsonl 123, 125, 146)
const holdAdd = { op: 'add', kind: 'session_hold', key: 'session_hold:1', data: { localSeq: 1 }, pauseSeq: 1, at: '2026-10-28T10:27:14.272Z' };
const fenceAdd = id => ({ op: 'add', kind: 'run_fence', key: `run_fence:task:${id}`, data: { runRef: { kind: 'task', id } }, pauseSeq: 2, at: '2026-10-28T10:27:14.277Z' });
const holdRelease = id => ({ op: 'release', keys: ['session_hold:1', `run_fence:task:${id}`], observedSeq: 2, cause: 'input', at: '2026-10-28T10:27:14.351Z' });

function setup(t, { routing = defaultRouting, modelId = 'claude-opus-5-5', driver = null, nature = null, execute, onCheckpoint, entries = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'oracle-routing-test-'));
  const cwd = join(home, 'work');
  const agentDir = join(home, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, '.omo'), { recursive: true });
  writeFileSync(join(cwd, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));

  const rDir = join(agentDir, 'oracle-advisor');
  mkdirSync(rDir, { recursive: true });
  const routingPath = join(rDir, 'routing.json');
  if (routing !== null) {
    writeFileSync(routingPath, typeof routing === 'string' ? routing : JSON.stringify(routing));
  }

  const events = new EventEmitter();
  const records = new Map();
  let taskCount = 0;
  const taskCalls = [];
  const calls = [];

  const fake = createFakePi({
    cwd, entries,
    executeTool: async (name, args, options) => {
      calls.push({ name, args: structuredClone(args) });
      if (execute) {
        const custom = await execute(name, args, options, fake);
        if (custom !== undefined) return custom;
      }
      if (name === 'task') {
        taskCalls.push(structuredClone(args));
        const id = `t${++taskCount}`;
        const task = {
          task_id: id,
          status: 'completed',
          residency_state: 'resident',
          final_response: verdict,
          notification: { run_epoch: 0 },
          description: args.description,
          model: args.model ?? 'oracle-qa-mock/oracle',
        };
        records.set(id, task);
        fake.snapshot(task);
        return outcome({ ...task, run_epoch: 0 }, `${verdict}\n\n[task_id: ${id} - continue]`);
      }
      if (name === 'task_output') {
        const rec = records.get(args.task_id);
        return rec ? outcome({ kind: 'status', snapshot: structuredClone(rec) }) : outcome({ kind: 'not_found' });
      }
      if (name === 'task_cancel') {
        const task = records.get(args.task_id);
        if (!task) return outcome({ kind: 'not_found' });
        const kind = task.status === 'running' ? 'cancelled' : 'released';
        Object.assign(task, { status: kind === 'cancelled' ? 'cancelled' : task.status, residency_state: 'persisted_only' });
        fake.snapshot(task);
        return outcome({ kind, task_id: task.task_id, status: task.status });
      }
      if (name === 'task_send') {
        const task = records.get(args.to);
        task.notification.run_epoch++;
        fake.snapshot(task);
        return outcome({ kind: 'revived', task_id: args.to, run_epoch: task.notification.run_epoch });
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  });

  fake.pi.events = events;
  fake.records = records;
  fake.snapshot = task => events.emit('senpi:extension-rpc-event', {
    name: 'omo.task.updated', data: { parent_session_id: 'fake-session', tasks: [structuredClone(task)] },
  });
  fake.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });

  if (modelId) {
    fake.ctx.model = { id: modelId };
  } else {
    fake.ctx.model = undefined;
  }

  const notices = [];
  fake.ctx.ui.notify = (msg, level) => notices.push({ msg, level });

  const ledger = createLedger(fake.pi);
  ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 1 });

  const transport = createTransport(fake.pi, {
    ledger,
    decision: { ...TRANSPORT_DECISION, live_residency: 'disabled' },
  });
  t.after(() => transport.dispose());

  const runtime = {
    ledger,
    transport,
    getSessionStatus: () => 'lead',
    registerTool: tool => fake.pi.registerTool(tool),
  };

  registerConsultTool(fake.pi, runtime, {
    agentDir: () => agentDir,
    getDriver: () => driver,
    getNature: () => nature,
    onCheckpoint: stage => onCheckpoint?.(stage, routingPath),
  });

  const invoke = (id, kind = 'work', extra = {}, signal = undefined) => fake.tools.get('oracle_consult')
    .execute(id, { kind, question: 'Review this change.', ...extra }, signal, undefined, fake.ctx);

  const receipts = () => {
    try {
      return readFileSync(join(agentDir, 'logs/oracle-advisor.jsonl'), 'utf8')
        .trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  };

  const lateEvents = () => fake.entries.filter(e => e.data?.type === 'late_result_ignored');

  t.after(() => rmSync(home, { recursive: true, force: true }));

  return { fake, ledger, transport, runtime, invoke, receipts, taskCalls, calls, notices, lateEvents, agentDir, cwd, routingPath };
}

test('live_residency disabled is pinned', () => {
  assert.equal(TRANSPORT_DECISION.live_residency, 'disabled');
});

test('R5 purpose audit preserves routing and prompts across purposes and legacy tables', async t => {
  for (const nature of ['neutral', 'design', 'lowlevel', 'mixed']) {
    for (const [tableState, routing] of [['valid', defaultRouting], ['absent', null], ['invalid', '{invalid']]) {
      let baseline;
      for (const purpose of [undefined, 'scope', 'correctness', 'mixed']) {
        const s = setup(t, { nature, routing });
        const extra = purpose === undefined ? {} : { purpose };
        await s.invoke('audit-first', 'work', extra);
        await s.invoke('audit-next', 'work', extra);
        const receipts = s.receipts().filter(row => row.event === 'consult');
        assert.equal(receipts.length, 2);
        for (const row of receipts) {
          assert.equal(row.status, 'answered');
          assert.equal(row.consult_purpose, purpose ?? null);
          assert.equal(row.task_nature, nature);
          t.diagnostic('R5_PURPOSE_AUDIT ' + JSON.stringify({
            table: tableState, purpose: row.consult_purpose, task_nature: row.task_nature,
            advisor_profile: row.advisor_profile, advisor_source: row.advisor_source,
            model: row.model, request_id: row.request_id,
          }));
        }
        const observed = {
          native: s.taskCalls,
          counters: s.ledger.state.job.counters,
          advisors: receipts.map(row => ({
            profile: row.advisor_profile, source: row.advisor_source, model: row.model,
          })),
        };
        if (purpose === undefined) baseline = observed;
        else assert.deepEqual(observed, baseline);
      }
    }
  }
});

test('matrix: family x kind routes to expected model', async t => {
  // 1. Claude model -> gpt advisor for work and completion -> model pinned
  {
    const s = setup(t, { modelId: 'claude-3-5-sonnet-20241022' });
    const res = await s.invoke('r1', 'work');
    assert.equal(res.details.status, 'answered');
    assert.equal(s.taskCalls.length, 1);
    assert.equal(s.taskCalls[0].model, 'chatgpt-subscription/gpt-6-astra:high');

    const rec = s.receipts()[0];
    for (const field of RECEIPT_FIELDS) assert.ok(Object.hasOwn(rec, field), field);
    assert.equal(rec.session_id, 'fake-session');
    assert.equal(rec.advisor_profile, 'gpt');
    assert.equal(rec.advisor_source, 'by_family');
    assert.equal(rec.advisor_reason, 'claude:work');
    assert.equal(rec.main_family, 'claude');
    assert.equal(rec.auto_run_id, null);
  }

  // 2. GPT model -> claude advisor (no model override) -> task args model omitted
  {
    const s = setup(t, { modelId: 'gpt-4o' });
    const res = await s.invoke('r1', 'work');
    assert.equal(res.details.status, 'answered');
    assert.equal(s.taskCalls.length, 1);
    assert.equal(Object.hasOwn(s.taskCalls[0], 'model'), false);

    const rec = s.receipts()[0];
    assert.equal(rec.session_id, 'fake-session');
    assert.equal(rec.advisor_profile, 'claude');
    assert.equal(rec.advisor_source, 'by_family');
    assert.equal(rec.advisor_reason, 'gpt:work');
    assert.equal(rec.main_family, 'gpt');
  }

  // 3. Other model -> claude for work (no model), gpt for completion (model pinned)
  {
    const s = setup(t, { modelId: 'deepseek-v3' });
    await s.invoke('r1', 'work');
    assert.equal(s.taskCalls.length, 1);
    assert.equal(Object.hasOwn(s.taskCalls[0], 'model'), false);

    await s.invoke('r2', 'completion');
    assert.equal(s.taskCalls.length, 2);
    assert.equal(s.taskCalls[1].model, 'chatgpt-subscription/gpt-6-astra:high');
  }

  // 4. Per-agent driver override: atlas driver overrides to gpt profile
  {
    const s = setup(t, {
      routing: { ...defaultRouting, by_agent: { atlas: { work: 'gpt', completion: 'gpt' } } },
      driver: { agentId: 'atlas' },
      modelId: 'gpt-4o',
    });
    const res = await s.invoke('r_atlas', 'work');
    assert.equal(res.details.status, 'answered');
    const rec = s.receipts()[0];
    assert.equal(rec.session_id, 'fake-session');
    assert.equal(rec.driver_agent, 'atlas');
    assert.equal(rec.advisor_source, 'by_agent');
    assert.equal(rec.auto_run_id, null);
  }

  // 5. Open auto job carries auto_run_id into consult receipts
  {
    const s = setup(t, {
      modelId: 'claude-opus-5-5',
    });
    // Replace manual J1 with an auto job
    s.ledger.append({
      type: 'job_opened', job_id: 'J2', job_epoch: 1,
      auto: { run_id: 'run-auto-xyz', trigger: 'atlas_ulw_execute' },
    });
    const res = await s.invoke('r_auto', 'work');
    assert.equal(res.details.status, 'answered');
    const rec = s.receipts()[0];
    assert.equal(rec.auto_run_id, 'run-auto-xyz');
  }
});

test('nature precedence: design -> claude (no model), lowlevel -> gpt (model pinned)', async t => {
  // Even if family is GPT, design nature forces claude
  {
    const s = setup(t, { modelId: 'gpt-4o', nature: 'design' });
    await s.invoke('r1', 'work');
    assert.equal(s.taskCalls.length, 1);
    assert.equal(Object.hasOwn(s.taskCalls[0], 'model'), false);
    const rec = s.receipts()[0];
    assert.equal(rec.advisor_profile, 'claude');
    assert.equal(rec.advisor_source, 'by_nature');
    assert.equal(rec.advisor_reason, 'design');
    assert.equal(rec.task_nature, 'design');
  }

  // Even if family is Claude, lowlevel nature forces gpt
  {
    const s = setup(t, { modelId: 'claude-opus-5-5', nature: 'lowlevel' });
    await s.invoke('r1', 'work');
    assert.equal(s.taskCalls.length, 1);
    assert.equal(s.taskCalls[0].model, 'chatgpt-subscription/gpt-6-astra:high');
    const rec = s.receipts()[0];
    assert.equal(rec.advisor_profile, 'gpt');
    assert.equal(rec.advisor_source, 'by_nature');
    assert.equal(rec.advisor_reason, 'lowlevel');
    assert.equal(rec.task_nature, 'lowlevel');
  }
});

test('invalid routing table (extra unknown key) falls back to legacy dispatch and emits exactly one notice per session', async t => {
  const s = setup(t, {
    // Valid table structure plus one unknown top-level key: tests strict degradation (M8)
    routing: { ...defaultRouting, unknown_top_level_key: 'invalid' },
  });

  // First invoke: dispatches legacy, no model override in task args, emits notice
  const res1 = await s.invoke('r1', 'work');
  assert.equal(res1.details.status, 'answered');
  assert.equal(s.taskCalls.length, 1);
  assert.equal(Object.hasOwn(s.taskCalls[0], 'model'), false);
  assert.equal(s.notices.length, 1);
  assert.ok(s.notices[0].msg.includes('routing.json'));

  const rec1 = s.receipts()[0];
  assert.equal(rec1.advisor_profile, null);
  assert.equal(rec1.advisor_source, 'legacy');
  assert.equal(rec1.advisor_reason, 'table_invalid');

  // Second invoke in same session: no second notice (M7)
  await s.invoke('r2', 'work');
  assert.equal(s.notices.length, 1);
});

test('absent table: task arguments deep-equal legacy baseline', async t => {
  const s = setup(t, { routing: null });
  await s.invoke('r1', 'work');
  assert.equal(s.taskCalls.length, 1);
  assert.deepEqual(s.taskCalls[0], {
    subagent_type: 'oracle',
    description: 'oracle-advisor J1#r1',
    prompt: s.taskCalls[0].prompt,
    run_in_background: false,
  });
  assert.equal(Object.hasOwn(s.taskCalls[0], 'model'), false);

  const rec = s.receipts()[0];
  assert.equal(rec.advisor_profile, null);
  assert.equal(rec.advisor_source, 'legacy');
  assert.equal(rec.advisor_reason, 'table_absent');
});

test('stale_state: routing captured at admission does not change if table is rewritten at dossier checkpoint', async t => {
  const s = setup(t, {
    onCheckpoint: (stage, path) => {
      // At dossier stage (before dispatch), rewrite table so claude maps to claude (no model)
      if (stage === 'dossier') {
        writeFileSync(path, JSON.stringify({
          ...defaultRouting,
          by_family: { ...defaultRouting.by_family, claude: { work: 'claude', completion: 'claude' } },
        }));
      }
    },
  });

  await s.invoke('r1', 'work');
  assert.equal(s.taskCalls[0].model, 'chatgpt-subscription/gpt-6-astra:high');
  const admitted = s.ledger.request('r1');
  assert.equal(admitted.advisor.profile, 'gpt');
  assert.equal(admitted.advisor.source, 'by_family');
});

test('refused admission stores advisor: null and no task call occurs', async t => {
  const s = setup(t);
  // Invalid arguments triggers refusal at admission
  const res = await s.invoke('r1', 'work', { question: 123 }); // invalid question type
  assert.equal(res.details.status, 'invalid_arguments');
  assert.equal(s.taskCalls.length, 0);

  const admitted = s.ledger.request('r1');
  assert.equal(admitted.advisor, null);
  assert.equal(admitted.slot, null);
});

test('host refusal of pin: measured plan_error shape makes exactly one task call and charges slot', async t => {
  // Measured shape from log ~1448
  const s = setup(t, {
    execute: async name => {
      if (name === 'task') {
        return outcome({
          task_id: '',
          status: 'plan_error',
          mode: 'spawn',
          reason: 'The task model pin "no-such/model" did not resolve',
        }, 'The task model pin "no-such/model" did not resolve', false);
      }
    },
  });

  const res = await s.invoke('r1', 'work');
  assert.equal(res.details.status, 'unavailable');
  assert.equal(s.calls.filter(c => c.name === 'task').length, 1);

  const rec = s.ledger.request('r1');
  assert.equal(rec.model_called, true);
  assert.equal(res.details.calls_remaining, 3);
});

test('real P7 order: Stop aborts while child snapshot is running -> no task_cancel on the paused child', async t => {
  let release;
  let taskCallsCount = 0;
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task') {
        taskCallsCount++;
        if (taskCallsCount > 1) {
          const task2 = { task_id: 'st_child_2', status: 'completed', residency_state: 'resident', final_response: verdict };
          fake.records.set('st_child_2', task2);
          fake.snapshot(task2);
          return outcome({ ...task2, run_epoch: 0 }, `${verdict}\n\n[task_id: st_child_2 - continue]`);
        }
        const task = {
          task_id: 'st_child',
          status: 'running',
          residency_state: 'resident',
          description: args.description,
          notification: { run_epoch: 0 },
          agent_type: 'oracle',
        };
        fake.records.set('st_child', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          release = () => resolve(outcome({ task_id: 'st_child', status: 'running', run_epoch: 0 }, ''));
          options?.signal?.addEventListener('abort', release, { once: true });
        });
      }
      if (name === 'task_cancel') {
        assert.fail('Must have 14: Advisor must not call task_cancel on the paused child');
      }
    },
  });

  const stop = new AbortController();
  const p = s.invoke('r1', 'work', {}, stop.signal);
  await new Promise(resolve => {
    const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick));
    tick();
  });

  // Replay measured host order:
  // 1. Session-hold entry added to session branch (run_fence for the child task)
  s.fake.pi.appendEntry('session-hold', holdAdd);
  s.fake.pi.appendEntry('session-hold', fenceAdd('st_child'));
  // 2. The host's Stop aborts the tool call signal
  stop.abort();

  const res = await p;
  const cancels = s.calls.filter(c => c.name === 'task_cancel');
  assert.equal(cancels.length, 0, 'Zero task_cancel calls on paused child');
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
  assert.equal(s.transport.running, null, 'In-flight transport marker cleared');

  // Next consult is not busy!
  const s2 = await s.invoke('r2', 'work');
  assert.notEqual(s2.details.status, 'busy');
});

test('DV3-B1 production signal: getPauseState returns live session_hold and run_fence at abort -> no task_cancel', async t => {
  let release;
  let taskCallsCount = 0;
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task') {
        taskCallsCount++;
        if (taskCallsCount > 1) {
          const task2 = { task_id: 'st_c2', status: 'completed', residency_state: 'resident', final_response: verdict };
          fake.records.set('st_c2', task2);
          fake.snapshot(task2);
          return outcome({ ...task2, run_epoch: 0 }, `${verdict}\n\n[task_id: st_c2 - continue]`);
        }
        const task = {
          task_id: 'st_prod_child',
          status: 'running',
          residency_state: 'resident',
          description: args.description,
          notification: { run_epoch: 0 },
          agent_type: 'oracle',
        };
        fake.records.set('st_prod_child', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          release = () => resolve(outcome({ task_id: 'st_prod_child', status: 'running', run_epoch: 0 }, ''));
          options?.signal?.addEventListener('abort', release, { once: true });
        });
      }
      if (name === 'task_cancel') {
        assert.fail('DV3-B1: Must not call task_cancel when getPauseState holds indicate pause');
      }
    },
  });

  const stop = new AbortController();
  const p = s.invoke('r1', 'work', {}, stop.signal);
  await new Promise(resolve => {
    const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick));
    tick();
  });

  // Production signal: getPauseState returns live holds at abort, NO branch entries
  s.fake.ctx.getPauseState = () => ({
    pauseSeq: 2,
    holds: [
      { kind: 'session_hold', key: 'session_hold:1', data: { localSeq: 1 } },
      { kind: 'run_fence', key: 'run_fence:task:st_prod_child', data: { runRef: { kind: 'task', id: 'st_prod_child' } } },
    ],
  });
  stop.abort();

  const res = await p;
  const cancels = s.calls.filter(c => c.name === 'task_cancel');
  assert.equal(cancels.length, 0, 'Zero task_cancel calls on paused child');
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
  assert.equal(s.transport.running, null, 'In-flight transport marker cleared');

  // Next consult is not busy!
  s.fake.ctx.getPauseState = () => ({ pauseSeq: 2, holds: [] });
  const s2 = await s.invoke('r2', 'work');
  assert.notEqual(s2.details.status, 'busy');
});

test('DV3-B1 production signal: getPauseState with session_hold only (no fence) -> no task_cancel', async t => {
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task') {
        const task = { task_id: 'st_prod_hold_only', status: 'running', residency_state: 'resident', description: args.description };
        fake.records.set('st_prod_hold_only', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_prod_hold_only', status: 'running' }, '')), { once: true });
        });
      }
      if (name === 'task_cancel') assert.fail('task_cancel must not be called when session_hold in holds');
    },
  });

  const stop = new AbortController();
  const p = s.invoke('r1', 'work', {}, stop.signal);
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });

  s.fake.ctx.getPauseState = () => ({
    pauseSeq: 1,
    holds: [
      { kind: 'session_hold', key: 'session_hold:1', data: { localSeq: 1 } },
    ],
  });
  stop.abort();

  const res = await p;
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
  assert.equal(s.calls.filter(c => c.name === 'task_cancel').length, 0);
});

test('DV3-B2 unrelated run_fence in getPauseState: owner cancel and Esc retire own child with task_cancel', async t => {
  let cancelCalls = 0;
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task' && !fake.records.has('st_mine')) {
        const task = { task_id: 'st_mine', status: 'running', residency_state: 'resident', description: args.description,
          notification: { run_epoch: 0 }, agent_type: 'oracle' };
        fake.records.set('st_mine', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_mine', status: 'running', run_epoch: 0 }, '')), { once: true });
        });
      }
      if (name === 'task_cancel') {
        cancelCalls++;
        const task = fake.records.get(args.task_id);
        if (task) {
          Object.assign(task, { status: 'cancelled', residency_state: 'persisted_only' });
          fake.snapshot(task);
        }
        return outcome({ kind: 'cancelled', task_id: args.task_id, status: 'cancelled' });
      }
    },
  });

  // getPauseState holds contain ONLY an unrelated run_fence (no session_hold)
  s.fake.ctx.getPauseState = () => ({
    pauseSeq: 2,
    holds: [
      { kind: 'run_fence', key: 'run_fence:task:st_other', data: { runRef: { kind: 'task', id: 'st_other' } } },
    ],
  });

  // Test 1: owner cancel
  const p1 = s.invoke('r1', 'work');
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  await s.runtime.consult.cancel(s.fake.ctx);
  const res1 = await p1;

  assert.equal(cancelCalls, 1, 'Owner cancel must retire own child even with unrelated fence');
  assert.equal(res1.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');

  // Test 2: Esc abort on fresh consult
  s.fake.records.delete('st_mine');
  const esc = new AbortController();
  const p2 = s.invoke('r2', 'work', {}, esc.signal);
  await new Promise(resolve => { const tick = () => (s.calls.filter(c => c.name === 'task').length >= 2 ? resolve() : setImmediate(tick)); tick(); });
  esc.abort();
  const res2 = await p2;

  assert.equal(cancelCalls, 2, 'Esc must retire own child even with unrelated fence');
  assert.equal(res2.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r2')?.reason, 'paused_by_stop');
});

test('DV3-B2 unrelated run_fence on branch (no getPauseState): owner cancel and Esc retire own child with task_cancel', async t => {
  const entries = [
    { type: 'custom', id: 'f1', customType: 'session-hold', data: fenceAdd('st_other') },
  ];
  let cancelCalls = 0;
  const s = setup(t, {
    entries,
    execute: async (name, args, options, fake) => {
      if (name === 'task' && !fake.records.has('st_mine_branch')) {
        const task = { task_id: 'st_mine_branch', status: 'running', residency_state: 'resident', description: args.description,
          notification: { run_epoch: 0 }, agent_type: 'oracle' };
        fake.records.set('st_mine_branch', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_mine_branch', status: 'running', run_epoch: 0 }, '')), { once: true });
        });
      }
      if (name === 'task_cancel') {
        cancelCalls++;
        const task = fake.records.get(args.task_id);
        if (task) {
          Object.assign(task, { status: 'cancelled', residency_state: 'persisted_only' });
          fake.snapshot(task);
        }
        return outcome({ kind: 'cancelled', task_id: args.task_id, status: 'cancelled' });
      }
    },
  });

  // Test 1: owner cancel
  const p1 = s.invoke('r1', 'work');
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  await s.runtime.consult.cancel(s.fake.ctx);
  const res1 = await p1;

  assert.equal(cancelCalls, 1, 'Owner cancel must retire own child when branch has only unrelated fence');
  assert.equal(res1.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');

  // Test 2: Esc abort
  s.fake.records.delete('st_mine_branch');
  const esc = new AbortController();
  const p2 = s.invoke('r2', 'work', {}, esc.signal);
  await new Promise(resolve => { const tick = () => (s.calls.filter(c => c.name === 'task').length >= 2 ? resolve() : setImmediate(tick)); tick(); });
  esc.abort();
  const res2 = await p2;

  assert.equal(cancelCalls, 2, 'Esc must retire own child when branch has only unrelated fence');
  assert.equal(res2.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r2')?.reason, 'paused_by_stop');
});

test('safety net: getPauseState throws -> does not hang, falls back to branch walk', async t => {
  const entries = [
    { type: 'custom', id: 'h1', customType: 'session-hold', data: holdAdd },
  ];
  const s = setup(t, {
    entries,
    execute: async (name, args, options, fake) => {
      if (name === 'task') {
        const task = { task_id: 'st_throw_test', status: 'running', residency_state: 'resident', description: args.description };
        fake.records.set('st_throw_test', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_throw_test', status: 'running' })), { once: true });
        });
      }
      if (name === 'task_cancel') assert.fail('task_cancel should not be called as branch has hold');
    },
  });
  s.fake.ctx.getPauseState = () => {
    const err = new Error('This extension ctx is stale');
    err.name = 'StaleExtensionContextError';
    throw err;
  };

  const stop = new AbortController();
  const p = s.invoke('r1', 'work', {}, stop.signal);
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  stop.abort();

  const res = await p;
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('safety net: getPauseState holds contains null or non-object -> skipped safely', async t => {
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task') {
        const task = { task_id: 'st_null_test', status: 'running', residency_state: 'resident', description: args.description };
        fake.records.set('st_null_test', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_null_test', status: 'running' })), { once: true });
        });
      }
      if (name === 'task_cancel') assert.fail('task_cancel should not be called as valid hold is present');
    },
  });
  s.fake.ctx.getPauseState = () => ({
    pauseSeq: 1,
    holds: [
      null,
      undefined,
      'not an object',
      { kind: 'session_hold', key: 'session_hold:1', data: { localSeq: 1 } },
    ],
  });

  const stop = new AbortController();
  const p = s.invoke('r1', 'work', {}, stop.signal);
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  stop.abort();

  const res = await p;
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('stale unreleased hold: ctx.getPauseState returning holds [] is authoritative and retires child on cancel', async t => {
  // Branch has unreleased holdAdd, but getPauseState says holds are empty (authoritative)
  const entries = [
    { type: 'custom', id: 'h1', customType: 'session-hold', data: holdAdd },
  ];
  const s = setup(t, {
    entries,
    execute: async (name, args, options, fake) => {
      if (name === 'task' && !fake.records.has('st_auth')) {
        const task = { task_id: 'st_auth', status: 'running', residency_state: 'resident', description: args.description,
          notification: { run_epoch: 0 }, agent_type: 'oracle' };
        fake.records.set('st_auth', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_auth', status: 'running', run_epoch: 0 }, '')), { once: true });
        });
      }
    },
  });
  // Authoritative getPauseState says holds are empty
  s.fake.ctx.getPauseState = () => ({ pauseSeq: 2, holds: [] });

  const p = s.invoke('r1', 'work');
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  await s.runtime.consult.cancel(s.fake.ctx);
  const res = await p;

  const cancels = s.calls.filter(c => c.name === 'task_cancel').length;
  assert.equal(cancels, 1, 'Authoritative getPauseState must allow task_cancel retirement');
  assert.equal(res.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('consult cancelled with no pause signal does not record paused_by_stop', async t => {
  const s = setup(t, {
    execute: async name => {
      if (name === 'task') return outcome({ status: 'cancelled' }, 'cancelled', false);
    },
  });
  const res = await s.invoke('r1', 'work');
  assert.equal(res.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('stale released hold: Esc-style abort of a later consult retires child with task_cancel and does not label paused_by_stop', async t => {
  const entries = [
    { type: 'custom', id: 'h1', customType: 'session-hold', data: holdAdd },
    { type: 'custom', id: 'h3', customType: 'session-hold', data: holdRelease('st_old') },
  ];
  const s = setup(t, {
    entries,
    execute: async (name, args, options, fake) => {
      if (name === 'task' && !fake.records.has('st_new')) {
        const task = { task_id: 'st_new', status: 'running', residency_state: 'resident', description: args.description,
          notification: { run_epoch: 0 }, agent_type: 'oracle' };
        fake.records.set('st_new', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_new', status: 'running', run_epoch: 0 }, '')), { once: true });
        });
      }
    },
  });

  const esc = new AbortController();
  const p = s.invoke('r1', 'work', {}, esc.signal);
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  esc.abort();
  const res = await p;

  const cancels = s.calls.filter(c => c.name === 'task_cancel').length;
  assert.equal(cancels, 1);
  assert.equal(res.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('plain owner Esc abort with NO hold records ordinary cancelled reason and calls task_cancel', async t => {
  const s = setup(t, {
    execute: async (name, args, options, fake) => {
      if (name === 'task' && !fake.records.has('st_plain')) {
        const task = { task_id: 'st_plain', status: 'running', residency_state: 'resident', description: args.description,
          notification: { run_epoch: 0 }, agent_type: 'oracle' };
        fake.records.set('st_plain', task);
        fake.snapshot(task);
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(outcome({ task_id: 'st_plain', status: 'running', run_epoch: 0 }, '')), { once: true });
        });
      }
    },
  });

  const esc = new AbortController();
  const p = s.invoke('r1', 'work', {}, esc.signal);
  await new Promise(resolve => { const tick = () => (s.calls.some(c => c.name === 'task') ? resolve() : setImmediate(tick)); tick(); });
  esc.abort();
  const res = await p;

  const cancels = s.calls.filter(c => c.name === 'task_cancel').length;
  assert.equal(cancels, 1);
  assert.equal(res.details.status, 'cancelled');
  assert.notEqual(s.ledger.request('r1')?.reason, 'paused_by_stop');
});

test('measured follow-up admission shape after Stop: spawn returning paused ends promptly as cancelled with reason paused_by_stop', async t => {
  // Measured shape from log ~2219
  const s = setup(t, {
    execute: async name => {
      if (name === 'task') {
        return outcome({
          task_id: 'st_01a18213',
          status: 'paused',
          mode: 'spawn',
          pause_seq: 1,
        }, 'Task admission is held by your Stop. Resume the run to continue.', false);
      }
      if (name === 'task_output') {
        return outcome({ kind: 'not_found', reason: "No task 'st_01a18213' in this session." });
      }
      if (name === 'task_cancel') {
        assert.fail('Must not call task_cancel on paused spawn');
      }
    },
  });

  const res = await s.invoke('r1', 'work');
  assert.equal(res.details.status, 'cancelled');
  assert.equal(s.ledger.request('r1')?.reason, 'paused_by_stop');
  assert.equal(s.calls.filter(c => c.name === 'task_cancel' || c.name === 'task_send').length, 0);

  const rec = s.ledger.request('r1');
  assert.equal(rec.model_called, true);
  assert.equal(res.details.calls_remaining, 3);

  const next = await s.invoke('r2', 'work');
  assert.notEqual(next.details.status, 'busy');
});

test('spawn returning paused with no task_id does not charge slot', async t => {
  const s = setup(t, {
    execute: async name => {
      if (name === 'task') {
        return outcome({
          status: 'paused',
          mode: 'spawn',
          pause_seq: 1,
        }, 'Admission held by Stop', true);
      }
    },
  });

  const res = await s.invoke('r1', 'work');
  assert.equal(res.details.status, 'cancelled');
  const rec = s.ledger.request('r1');
  assert.equal(rec.model_called, false);
  assert.equal(res.details.calls_remaining, 4);
});

test('late answer handling: delivered answer re-emitted does not log, multiple ended-unanswered consults log once each, late answer produces no delivery to main', async t => {
  let k = 0;
  const s = setup(t, {
    execute: async name => {
      if (name === 'task') {
        k++;
        if (k === 1) {
          // Normal answered consult
          return outcome({ task_id: 't_normal', status: 'completed', run_epoch: 0, final_response: verdict });
        }
        // Consults 2 and 3 return paused
        return outcome({ task_id: `st_p${k}`, status: 'paused', pause_seq: 1 }, 'paused', true);
      }
    },
  });

  // 1. Consult 1 is answered and delivered
  const r1 = await s.invoke('r1', 'work');
  assert.equal(r1.details.status, 'answered');
  // Re-emit snapshot for already-delivered consult 1 -> MUST NOT log late_result_ignored (AV-A3)
  s.fake.snapshot({ task_id: 't_normal', status: 'completed', residency_state: 'disposed', final_response: verdict });
  assert.equal(s.lateEvents().length, 0);

  // 2. Consult 2 ends cancelled/paused (unanswered)
  await s.invoke('r2', 'work');
  s.fake.snapshot({ task_id: 'st_p2', status: 'completed', final_response: verdict });
  // Duplicate snapshot for st_p2 -> recorded only ONCE for st_p2 (M11)
  s.fake.snapshot({ task_id: 'st_p2', status: 'completed', final_response: verdict });
  assert.equal(s.lateEvents().length, 1);
  assert.equal(s.lateEvents()[0].data.oracle_task_id, 'st_p2');

  // 3. Consult 3 ends cancelled/paused (unanswered)
  await s.invoke('r3', 'work');
  s.fake.snapshot({ task_id: 'st_p3', status: 'completed', final_response: verdict });
  // Recorded for st_p3 as well -> once per ended-unanswered consult (AV-A4)
  assert.equal(s.lateEvents().length, 2);
  assert.deepEqual(s.lateEvents().map(e => e.data.oracle_task_id), ['st_p2', 'st_p3']);

  // 4. Late answer produces NO message delivery to main (M10)
  const lateMessages = s.fake.calls.sendMessage.filter(([m]) => JSON.stringify(m).includes('CONTINUE') || m.customType === 'oracle-advisor-late');
  assert.equal(lateMessages.length, 0);
});

test('/oracle status text contains table state and last advisor', async t => {
  const s = setup(t);
  const prev = process.env.SENPI_CODING_AGENT_DIR;
  process.env.SENPI_CODING_AGENT_DIR = s.agentDir;
  t.after(() => {
    if (prev === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
    else process.env.SENPI_CODING_AGENT_DIR = prev;
  });

  registerCommands(s.fake.pi, s.runtime);
  await s.invoke('r1', 'work');
  const snap = await s.fake.command('oracle', 'status');
  const text = s.fake.calls.sendMessage
    .filter(([m]) => m.customType === 'oracle-advisor-status')
    .map(([m]) => m.content)
    .join(' | ');

  assert.equal(snap.table_state, 'valid');
  assert.match(text, /table valid/);
  assert.match(text, /last advisor/);
});

test('absent or empty ctx.model.id with valid table gives legacy dispatch without model pin', async t => {
  const s = setup(t, { modelId: null });
  // Under Mutant 15, unknown family would be treated as 'other' and pin GPT for completion.
  // With correct behavior, unknown family gives legacy dispatch without model pin.
  const res = await s.invoke('r1', 'completion');
  assert.equal(res.details.status, 'answered');
  const task = s.taskCalls[0];
  assert.equal(Object.hasOwn(task, 'model'), false);

  const rec = s.receipts()[0];
  assert.equal(rec.advisor_source, 'legacy');
  assert.equal(rec.advisor_reason, 'family_unknown');
});
