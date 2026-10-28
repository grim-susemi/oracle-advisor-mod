import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import extension, { REGISTRATION_KEY, isLeadSession } from '../src/extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

function setup(t, options = {}) {
  const fake = createFakePi(options);
  const prior = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  t.after(() => {
    if (prior === undefined) delete globalThis[REGISTRATION_KEY];
    else globalThis[REGISTRATION_KEY] = prior;
  });
  const runtime = extension(fake.pi);
  return { ...fake, runtime };
}

const atlasEntries = [{ type: 'custom', id: 'driver-atlas', customType: 'primary-agent/v1', data: { schemaVersion: 1, agentId: 'atlas' } }];

test('commands persist open, pause, resume, end, and monotonically numbered jobs', async t => {
  const f = setup(t);
  await f.emit('session_start');
  await f.command('oracle', 'on');
  assert.equal(f.runtime.ledger.state.job.job_id, 'J1');
  await f.command('oracle', 'on');
  assert.equal(f.calls.appendEntry.length, 1);
  await f.command('oracle', 'off');
  assert.equal(f.runtime.ledger.state.job.status, 'paused');
  await f.command('oracle', 'on');
  assert.equal(f.runtime.ledger.state.job.job_id, 'J1');
  assert.equal(f.runtime.ledger.state.job.job_epoch, 1);
  await f.command('oracle', 'end');
  assert.equal(f.runtime.ledger.state.job.status, 'closed');
  assert.equal(f.runtime.ledger.state.job.retire_pending, false);
  await f.command('oracle', 'on');
  assert.equal(f.runtime.ledger.state.job.job_id, 'J2');
  assert.equal(f.calls.executeTool.length, 0);
});

test('status returns machine data plus all owner-facing fields and cancel is inert', async t => {
  const f = setup(t);
  await f.emit('session_start');
  await f.command('oracle', 'on');
  const status = await f.command('oracle', 'status');
  assert.equal(status.job.job_id, 'J1');
  assert.equal(status.calls_remaining, 4);
  assert.equal(status.coordination, 'absent');
  assert.equal(status.job.counters.nudges, 0);
  assert.equal(status.job.seed, null);
  assert.equal(status.job.oracle_task_id, null);
  const count = f.calls.appendEntry.length;
  const cancelled = await f.command('oracle', 'cancel');
  assert.equal(cancelled.status, 'no_consult_running');
  assert.equal(f.calls.appendEntry.length, count);

  // Test /oracle on on an already active manual job does not append another job_resumed
  await f.command('oracle', 'on');
  assert.equal(f.calls.appendEntry.length, count);

  // But on an active auto job, /oracle on appends job_resumed {by: 'owner'}
  f.runtime.ledger.append({
    type: 'job_opened', job_id: 'J2', job_epoch: 1,
    auto: { run_id: 'auto-run-xyz', trigger: 'atlas_ulw_execute' },
  });
  const beforeAutoOn = f.calls.appendEntry.length;
  await f.command('oracle', 'on');
  const resumedEvent = f.calls.appendEntry.slice(beforeAutoOn).find(([, d]) => d.type === 'job_resumed');
  assert.ok(resumedEvent);
  assert.equal(resumedEvent[1].by, 'owner');
  assert.equal(f.runtime.ledger.state.job.owner_touched, true);
});

test('malformed args and invalid override never alter ledger', async t => {
  const f = setup(t);
  await f.emit('session_start');
  await f.command('oracle', 'on');
  for (const args of ['', 'bad', 'on extra', 'status extra', 'cancel extra', 'override', 'override s1 short',
    'override missing This reason has at least twenty characters.', `override s1 ${'x'.repeat(801)}`]) {
    const count = f.calls.appendEntry.length;
    assert.equal((await f.command('oracle', args)).status, 'invalid_arguments', args);
    assert.equal(f.calls.appendEntry.length, count, args);
  }
});

test('owner override is durable before releasing the exact open STOP even while paused', async t => {
  const f = setup(t);
  await f.emit('session_start');
  await f.command('oracle', 'on');
  f.runtime.ledger.append({ type: 'stop_opened', stop_id: 's1' });
  await f.command('oracle', 'off');
  await f.command('oracle', 'override s1 Owner accepts this scoped exception.');
  assert.equal(f.calls.appendEntry.at(-1)[1].actor, 'owner');
  assert.equal(f.runtime.ledger.state.job.stops.s1.status, 'overridden');
  assert.equal(f.runtime.ledger.state.job.gate_state, 'ACTIVE');
});

test('session start and tree rebuild state and interrupt in-flight work without replay', async t => {
  const f = setup(t);
  await f.emit('session_start');
  await f.command('oracle', 'on');
  const before = structuredClone(f.runtime.ledger.state);
  await f.emit('session_tree');
  assert.deepEqual(f.runtime.ledger.state, before);
  f.runtime.ledger.append({ type: 'consult_reserved', request_id: 'r1', kind: 'work' });
  f.runtime.ledger.append({ type: 'consult_started', request_id: 'r1' });
  await f.emit('session_start');
  assert.equal(f.runtime.ledger.state.job.consults.r1.status, 'interrupted');
  assert.equal(f.calls.executeTool.length, 0);
});

test('registration is idempotent and shutdown releases the generation', async t => {
  const f = setup(t);
  await f.emit('session_start');
  const generation = f.runtime.generation;
  const count = f.calls.on.length;
  assert.equal(extension(f.pi), f.runtime);
  assert.equal(f.calls.on.length, count);
  assert.equal(globalThis[REGISTRATION_KEY].liveGenerations, 1);
  await f.emit('session_shutdown');
  assert.equal(globalThis[REGISTRATION_KEY].liveGenerations, 0);
  const next = createFakePi();
  const runtime = extension(next.pi);
  assert.equal(runtime.generation, generation + 1);
  assert.equal(next.calls.registerCommand.length, 1);
});

test('non-interactive sessions register no hooks, tools or commands', t => {
  const f = setup(t, { sessionKind: 'background' });
  assert.equal(f.runtime, undefined);
  assert.equal(f.calls.on.length, 0);
  assert.equal(f.calls.registerTool.length, 0);
  assert.equal(f.calls.registerCommand.length, 0);
});

test('child identity uses canonical paths in system temporary storage and platform-specific casing', t => {
  const directory = mkdtempSync(join(tmpdir(), '.oracle-path-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(dirname(directory), tmpdir());
  assert.notEqual(dirname(directory), process.cwd());
  const childDirectory = join(directory, 'senpi-task/children');
  mkdirSync(childDirectory, { recursive: true });
  writeFileSync(join(childDirectory, 'owned.jsonl'), '');
  const cases = [
    ['uppercase alias', `${directory}/SENPI-TASK/CHILDREN/owned.jsonl`, process.platform !== 'win32'],
    ['mixed case alias', `${directory}/SeNpI-TaSk/ChIlDrEn/owned.jsonl`, process.platform !== 'win32'],
    ['backslash path', `${directory}\\senpi-task\\children\\owned.jsonl`, false],
    ['dot segments into child', `${directory}/senpi-task/worker/../children/owned.jsonl`, false],
    ['dot segments out of child', `${directory}/senpi-task/children/../../lead.jsonl`, true],
    ['trailing separator', `${directory}/senpi-task/children/`, false],
    ['non-child filename', `${directory}/senpi-task/children-owned.jsonl`, true],
    ['unwritten child file', `${directory}/senpi-task/children/not-created.jsonl`, false],
  ];
  for (const [label, sessionFile, expectedLead] of cases) {
    const fake = createFakePi({ sessionFile });
    assert.equal(isLeadSession(fake.pi, fake.ctx), expectedLead, label);
  }
});

test('a session-file getter failure cannot throw or enable lead activity', () => {
  const fake = createFakePi();
  fake.ctx.sessionManager.getSessionFile = () => { throw new Error('session unavailable'); };
  assert.equal(isLeadSession(fake.pi, fake.ctx), false);
});

test('hooks, commands and tools are inert before the first session_start', async t => {
  const f = setup(t);
  const state = structuredClone(f.runtime.ledger.state);
  const registration = globalThis[REGISTRATION_KEY].runtime;
  let executed = 0;
  f.runtime.registerTool({
    name: 'oracle_consult', parameters: { type: 'object', properties: {} },
    async execute() { executed++; },
  });
  await f.emit('session_tree');
  await f.emit('session_shutdown');
  for (const action of ['on', 'off', 'end', 'status', 'cancel', 'override s1 owner reason']) {
    assert.equal(await f.command('oracle', action), undefined);
  }
  const result = await f.ctx.executeTool('oracle_consult', {});
  assert.equal(result.details.status, 'session_not_ready');
  assert.equal(executed, 0);
  assert.deepEqual(f.runtime.ledger.state, state);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, registration);
  assert.equal(f.calls.appendEntry.length, 0);
  assert.equal(f.calls.sendMessage.length, 0);
  await f.emit('session_start');
  await f.ctx.executeTool('oracle_consult', {});
  assert.equal(executed, 1);
});

for (const sessionFile of ['x/senpi-task/children/a/session.jsonl', 'C:\\x\\senpi-task\\children\\a.jsonl']) {
  test(`interactive child remains inert after identity is latched: ${sessionFile}`, async t => {
    const priorAgent = process.env.SENPI_CODING_AGENT_DIR;
    const directory = mkdtempSync(join(tmpdir(), '.oracle-child-test-'));
    t.after(() => {
      if (priorAgent === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
      else process.env.SENPI_CODING_AGENT_DIR = priorAgent;
      rmSync(directory, { recursive: true, force: true });
    });
    process.env.SENPI_CODING_AGENT_DIR = directory;
    const child = setup(t, { sessionKind: 'interactive', sessionFile, entries: [
      { type: 'custom', customType: 'oracle-advisor', data: { type: 'job_opened', job_id: 'J1' } },
      { type: 'custom', customType: 'oracle-advisor', data: { type: 'consult_reserved', request_id: 'r1', kind: 'work' } },
      { type: 'custom', customType: 'oracle-advisor', data: { type: 'consult_started', request_id: 'r1' } },
    ] });
    const entries = structuredClone(child.entries);
    assert.equal(isLeadSession(child.pi, child.ctx), false);
    const notifications = [];
    child.ctx.ui.notify = (...args) => notifications.push(args);
    let executed = 0;
    for (const name of ['oracle_consult', 'oracle_advisor', 'oracle_record_stop', 'oracle_bind_seed']) {
      child.runtime.registerTool({
        name, parameters: { type: 'object', properties: {} },
        async execute() { executed++; },
      });
    }
    await child.emit('session_start');
    const state = structuredClone(child.runtime.ledger.state);
    const registration = globalThis[REGISTRATION_KEY].runtime;
    // A later context cannot accidentally turn a latched child into a lead.
    child.ctx.sessionManager.getSessionFile = () => 'owned/lead.jsonl';
    for (const hook of child.handlers.keys()) await child.emit(hook);
    assert.equal(globalThis[REGISTRATION_KEY].runtime, registration);
    for (const action of ['on', 'off', 'end', 'status', 'cancel', 'override s1 owner reason', 'bad']) {
      const reply = await child.command('oracle', action);
      assert.equal(reply.status, 'child_session_refused');
      assert.equal(reply.message, 'not available in task child sessions');
    }
    assert.equal(notifications.length, 7);
    assert.ok(notifications.every(([message]) => message === 'not available in task child sessions'));
    for (const name of child.tools.keys()) {
      const result = await child.ctx.executeTool(name, {});
      assert.equal(result.details.status, 'child_session_refused');
    }
    assert.equal(executed, 0);
    assert.deepEqual(child.runtime.ledger.state, state);
    assert.equal(child.calls.appendEntry.length, 0);
    assert.equal(child.calls.sendMessage.length, 0);
    assert.deepEqual(child.entries, entries);
    assert.equal(existsSync(join(directory, 'logs/oracle-advisor.jsonl')), false);
  });
}

test('kill switch registers nothing and writes one receipt even after duplicate loads', t => {
  const priorEnv = { switch: process.env.OMO_ORACLE_ADVISOR, agent: process.env.SENPI_CODING_AGENT_DIR };
  const directory = mkdtempSync(join(tmpdir(), '.oracle-killswitch-test-'));
  t.after(() => {
    if (priorEnv.switch === undefined) delete process.env.OMO_ORACLE_ADVISOR;
    else process.env.OMO_ORACLE_ADVISOR = priorEnv.switch;
    if (priorEnv.agent === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
    else process.env.SENPI_CODING_AGENT_DIR = priorEnv.agent;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.OMO_ORACLE_ADVISOR = '0';
  process.env.SENPI_CODING_AGENT_DIR = directory;
  const f = setup(t);
  extension(f.pi);
  assert.equal(f.calls.on.length, 0);
  assert.equal(f.calls.registerTool.length, 0);
  assert.equal(f.calls.registerCommand.length, 0);
  const lines = readFileSync(join(directory, 'logs/oracle-advisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 'disabled-by-env');
});

test('optional coordination is accepted only for v1 with a usable client', async t => {
  const key = Symbol.for('omo.agent-coordination.api.v1');
  const prior = globalThis[key];
  t.after(() => {
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
  });
  const f = setup(t);
  await f.emit('session_start');
  globalThis[key] = { version: 1, getClient: () => ({ peers: () => [] }) };
  assert.equal((await f.command('oracle', 'status')).coordination, 'present');
  globalThis[key] = { version: 2, getClient: () => ({ peers: () => [] }) };
  assert.equal((await f.command('oracle', 'status')).coordination, 'absent');
  globalThis[key] = { version: 1, getClient() { throw new Error('broker gone'); } };
  assert.equal((await f.command('oracle', 'status')).coordination, 'absent');
});

test('status displays the current broker roster without ask or notify', async t => {
  const key = Symbol.for('omo.agent-coordination.api.v1');
  const prior = globalThis[key];
  t.after(() => {
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
  });
  const f = setup(t);
  await f.emit('session_start');
  let roster = [{ id: 'owned-peer', name: 'Owned peer', status: 'live' }];
  const calls = [];
  globalThis[key] = { version: 1, getClient: ctx => {
    assert.equal(ctx, f.ctx);
    return {
      peers() { calls.push('peers'); return roster; },
      ask() { calls.push('ask'); throw new Error('forbidden'); },
      notify() { calls.push('notify'); throw new Error('forbidden'); },
    };
  } };
  for (const active of [false, true]) {
    if (active) await f.command('oracle', 'on');
    const result = await f.command('oracle', 'status');
    assert.deepEqual(result.coordination_roster, roster);
    assert.ok(f.calls.sendMessage.at(-1)[0].content.includes(JSON.stringify(roster)));
  }
  roster = [];
  assert.deepEqual((await f.command('oracle', 'status')).coordination_roster, []);
  globalThis[key] = { version: 1, getClient: () => ({
    peers() { throw new Error('broker gone'); },
  }) };
  const absent = await f.command('oracle', 'status');
  assert.equal(absent.coordination, 'absent');
  assert.deepEqual(absent.coordination_roster, []);
  assert.ok(calls.every(method => method === 'peers'));
});

test('status displays auto state and Stop admission hold note', async t => {
  const f = setup(t);
  await f.emit('session_start');
  f.runtime.ledger.append({
    type: 'job_opened', job_id: 'J1', job_epoch: 1,
    auto: { run_id: 'run-auto-123', trigger: 'atlas_ulw_execute' },
  });
  await f.command('oracle', 'status');
  const before = f.calls.sendMessage.at(-1)[0].content;
  assert.ok(before.includes('auto run run-auto-123, paused by none, owner touched false'));
  assert.equal(before.includes('after a Stop the host admission hold'), false, 'no Stop yet, no hold note');

  f.runtime.ledger.append({ type: 'stop_opened', stop_id: 's1' });
  await f.command('oracle', 'status');
  const msg = f.calls.sendMessage.at(-1)[0].content;
  assert.ok(msg.includes('auto run run-auto-123, paused by none, owner touched false'));
  assert.ok(msg.includes('after a Stop the host admission hold makes later consults end cancelled'));

  // Pause by owner
  await f.command('oracle', 'off');
  await f.command('oracle', 'status');
  const msgPaused = f.calls.sendMessage.at(-1)[0].content;
  assert.ok(msgPaused.includes('auto run run-auto-123, paused by owner, owner touched true'));
});

test('real extension: the opening atlas turn carries the oracle rule and the auto job', async t => {
  const f = setup(t, { entries: atlasEntries });
  await f.emit('session_start');
  await f.emit('input', { text: '/ulw-execute', source: 'interactive' });
  const results = await f.emit('before_agent_start', { systemPrompt: 'base' });
  assert.equal(f.runtime.ledger.state.job.job_id, 'J1');
  assert.ok(f.runtime.ledger.state.job.auto);
  const prompt = results.map(r => r?.systemPrompt ?? '').join('\n');
  assert.ok(prompt.includes('Consult the oracle with oracle_consult'));
});

for (const reason of ['fork', 'resume']) {
  test(`real extension: a ${reason} session_start ends the auto job on the next atlas turn`, async t => {
    const f = setup(t, { entries: atlasEntries });
    await f.emit('session_start');
    await f.emit('input', { text: '/ulw-execute', source: 'interactive' });
    await f.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(f.runtime.ledger.state.job.status, 'active');
    await f.emit('session_start', { reason });
    await f.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(f.runtime.ledger.state.job.status, 'closed');
    const ended = f.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0][1].reason, 'session_restarted');
  });
}

test('manual /oracle on opens the nature job-open horizon', async t => {
  const sessionId = 'nature-job-open-horizon';
  const f = setup(t, { sessionId });
  await f.emit('session_start');
  const before = f.runtime.nature.getState(sessionId).jobOpen ?? null;
  await f.command('oracle', 'on');
  const after = f.runtime.nature.getState(sessionId).jobOpen;
  assert.equal(before, null);
  assert.equal(typeof after, 'number');
});

test('a real session_start event sets the nature sessionStart horizon', async t => {
  const sessionId = 'nature-session-start-horizon';
  const f = setup(t, { sessionId });
  // one recorded task nature bumps the counter so the horizon is distinguishable from its initial 0
  await f.emit('tool_call', { toolName: 'task', toolCallId: 't1', input: { category: 'visual-engineering', prompt: 'x' } });
  await f.emit('session_start');
  const state = f.runtime.nature.getState(sessionId);
  assert.ok(state.counter > 0);
  assert.equal(state.sessionStart, state.counter);
});

const consultTaskStub = async name => {
  if (name !== 'task') throw new Error(`Unexpected tool: ${name}`);
  const verdict = '{"verdict":"CONTINUE","reasons":[]}';
  const details = { task_id: 't1', status: 'completed', residency_state: 'resident', final_response: verdict, notification: { run_epoch: 0 }, run_epoch: 0 };
  return { toolCall: {}, result: { details, content: [{ type: 'text', text: verdict }] }, isError: false };
};

test('driver reaches the consult resolver through the real extension', async t => {
  // consult reads routing.json from SENPI_CODING_AGENT_DIR; use the real shipped table
  const b6AgentDir = mkdtempSync(join(tmpdir(), 'b6-agent-'));
  mkdirSync(join(b6AgentDir, 'oracle-advisor'), { recursive: true });
  writeFileSync(join(b6AgentDir, 'oracle-advisor', 'routing.json'), readFileSync(join(import.meta.dirname, '..', 'config', 'routing.default.json'), 'utf8'));
  const prevAgentDir = process.env.SENPI_CODING_AGENT_DIR;
  process.env.SENPI_CODING_AGENT_DIR = b6AgentDir;
  t.after(() => {
    if (prevAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
    else process.env.SENPI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(b6AgentDir, { recursive: true, force: true });
  });
  const withDriver = setup(t, { entries: atlasEntries, executeTool: consultTaskStub });
  const withoutDriver = setup(t, { executeTool: consultTaskStub });
  for (const f of [withDriver, withoutDriver]) {
    f.ctx.model = { id: 'claude-opus-5-5' };
    await f.emit('session_start');
    await f.emit('before_agent_start', {});
    await f.emit('input', { text: 'design the new layout', source: 'interactive' });
    await f.command('oracle', 'on');
    await f.emit('tool_call', { toolName: 'task', toolCallId: 'n1', input: { category: 'visual-engineering', prompt: 'x' } });
    await f.tools.get('oracle_consult').execute('c1', { kind: 'work', question: 'Review this design.' }, undefined, undefined, f.ctx);
  }
  const receipt = f => f.entries.find(e => e.data?.type === 'consult_finished')?.data;
  const a = receipt(withDriver);
  const b = receipt(withoutDriver);
  assert.ok(a, 'driver run stores a consult receipt');
  assert.ok(b, 'no-driver run stores a consult receipt');
  assert.equal(a.driver_agent, 'atlas');
  assert.equal(a.advisor_source, 'by_nature');
  assert.equal(b.driver_agent, null);
});

test('extension registration order and status hub wiring at session_start and session_tree', async t => {
  // Earlier tests share the process-global hub (--test-isolation=none); clear it before setup registers a fresh one.
  delete globalThis[Symbol.for('omo.oracle-advisor.status.v1')];
  const f = setup(t);
  // Verify hooks were registered: commands, seed, driver, nature, consult, auto-atlas, STOP gate, nudger, hub
  const onNames = f.calls.on.map(([name]) => name);
  assert.ok(onNames.includes('before_agent_start'));
  assert.ok(onNames.includes('tool_call'));
  assert.ok(onNames.includes('input'));
  assert.ok(onNames.includes('session_start'));
  assert.ok(onNames.includes('session_tree'));
  assert.ok(onNames.includes('session_shutdown'));
  // Order, not presence: auto-atlas input precedes the stop gate, which precedes the nudger.
  const autoInput = onNames.lastIndexOf('input');
  const stopGate = onNames.indexOf('agent_start');
  const nudger = onNames.indexOf('turn_end');
  assert.ok(autoInput >= 0 && autoInput < stopGate, 'auto-atlas registers before the stop gate');
  assert.ok(stopGate < nudger, 'stop gate registers before the nudger');

  // Status hub snapshot exists after session_start
  const statusKey = Symbol.for('omo.oracle-advisor.status.v1');
  assert.equal(globalThis[statusKey]?.sessions?.['fake-session'], undefined);
  await f.emit('session_start');
  assert.ok(globalThis[statusKey]?.sessions);
  const snap1 = globalThis[statusKey].sessions['fake-session'];
  assert.equal(snap1.job_id, null);

  // Open a job
  await f.command('oracle', 'on');
  const snap2 = globalThis[statusKey].sessions['fake-session'];
  assert.equal(snap2.job_id, 'J1');
  assert.equal(snap2.status, 'active');

  // session_tree to empty branch publishes no-job snapshot
  f.entries.length = 0;
  await f.emit('session_tree');
  const snap3 = globalThis[statusKey].sessions['fake-session'];
  assert.equal(snap3.job_id, null);
  assert.equal(snap3.status, null);
});
