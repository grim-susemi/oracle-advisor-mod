import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePi } from './helpers/fake-pi.mjs';
import { createLedger } from '../src/ledger.mjs';
import { registerAutoAtlas, AUTO_TRIGGER } from '../src/auto-atlas.mjs';
import { registerNature } from '../src/nature.mjs';

const ENV_KEYS = ['OMO_ORACLE_AUTO_ATLAS', 'SENPI_CODING_AGENT_DIR', 'OMO_CODING_AGENT_DIR'];

function driverEntry(agentId) {
  return { type: 'custom', id: `driver-${agentId}`, customType: 'primary-agent/v1', data: { schemaVersion: 1, agentId } };
}

function setup({ entries = [], sessionId = 'lead-1' } = {}) {
  const fake = createFakePi({ sessionId, entries });
  const ledger = createLedger(fake.pi);
  const runtime = { ledger, getSessionStatus: () => 'lead' };
  const autoAtlas = registerAutoAtlas(fake.pi, runtime);
  return { fake, ledger, runtime, autoAtlas };
}

const userInput = text => ({ text, source: 'interactive' });

describe('auto-atlas trigger', () => {
  const saved = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('writes an auto-disabled-by-env receipt when OMO_ORACLE_AUTO_ATLAS=0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-atlas-'));
    try {
      process.env.OMO_ORACLE_AUTO_ATLAS = '0';
      process.env.SENPI_CODING_AGENT_DIR = dir;
      setup({ entries: [driverEntry('atlas')] });
      const line = JSON.parse(readFileSync(join(dir, 'logs', 'oracle-advisor.jsonl'), 'utf8').trim());
      assert.equal(line.status, 'auto-disabled-by-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports the trigger rule as data', () => {
    assert.deepEqual(AUTO_TRIGGER.commands, ['/skill:ulw-execute', '/ulw-execute']);
  });

  it('opens at session ready only for Atlas without an execution command', async () => {
    for (const agentId of ['atlas', 'sisyphus', 'hephaestus', 'other']) {
      const { fake, ledger, autoAtlas } = setup({ entries: [driverEntry(agentId)] });
      autoAtlas.noteSessionReady(fake.ctx);
      assert.equal(ledger.state.job?.status ?? null, agentId === 'atlas' ? 'active' : null, agentId);
      await fake.emit('before_agent_start', {});
      assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_opened').length,
        agentId === 'atlas' ? 1 : 0, agentId);
    }
  });

  it('opens on the first Atlas turn when identity arrives after session ready', async () => {
    const { fake, ledger, autoAtlas } = setup();
    autoAtlas.noteSessionReady(fake.ctx);
    fake.entries.push(driverEntry('atlas'));
    await fake.emit('before_agent_start', {});
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.state.job.auto.trigger, 'atlas_session_start');
  });

  it('opens exactly one auto job on the next atlas turn after /ulw-execute', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', { systemPrompt: 'base' });
    await fake.emit('before_agent_start', { systemPrompt: 'base' });
    const opened = fake.calls.appendEntry.filter(([, data]) => data.type === 'job_opened');
    assert.equal(opened.length, 1);
    assert.equal(opened[0][1].auto.trigger, 'atlas_ulw_execute');
    assert.equal(typeof opened[0][1].auto.run_id, 'string');
    assert.equal(ledger.state.job.auto.run_id, opened[0][1].auto.run_id);
  });

  it('accepts the skill form and rejects non-matches', async () => {
    for (const [text, expected] of [
      ['/skill:ulw-execute', 1], ['/ulw-execute please', 1],
      ['/ulw-executex', 0], ['hello /ulw-execute', 0], ['/ulw-plan', 0],
    ]) {
      const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
      await fake.emit('input', userInput(text));
      await fake.emit('before_agent_start', { systemPrompt: 'base' });
      assert.equal(ledger.state.job ? 1 : 0, expected, text);
    }
  });

  it('ignores extension-sourced input', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', { text: '/ulw-execute', source: 'extension' });
    await fake.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(ledger.state.job, null);
  });

  it('opens no job for a non-atlas driver or no driver', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('sisyphus')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(ledger.state.job, null);
    const none = setup();
    await none.fake.emit('input', userInput('/ulw-execute'));
    await none.fake.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(none.ledger.state.job, null);
  });

  it('registers nothing when OMO_ORACLE_AUTO_ATLAS=0', async () => {
    process.env.OMO_ORACLE_AUTO_ATLAS = '0';
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', { systemPrompt: 'base' });
    assert.equal(ledger.state.job, null);
    assert.equal(fake.calls.on.length, 0);
  });
});

describe('auto-atlas run rules', () => {
  const base = { systemPrompt: 'base' };

  it('shows one Korean notice line each on open, pause and resume', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    const notes = [];
    fake.ctx.ui = { notify: text => notes.push(text) };
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.deepEqual(notes, ['고문 자동 작업 J1 시작 (Atlas /ulw-execute)']);
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(notes.at(-1), '고문 자동 작업 J1 일시정지: Atlas 아님');
    driverSwitch(fake, 'atlas');
    await fake.emit('before_agent_start', base);
    assert.equal(notes.at(-1), '고문 자동 작업 J1 재개: Atlas 복귀');
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(notes.length, 3);
  });
  const driverSwitch = (fake, agentId) => fake.entries.push(driverEntry(agentId));

  it('pauses on a driver switch and resumes on the next atlas turn', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'paused');
    assert.equal(ledger.state.job.paused_by, 'auto');
    driverSwitch(fake, 'atlas');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.state.job.owner_touched, false);
  });

  it('defers the pause while a STOP is open and keeps the STOP held', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'stop_opened', job_id: ledger.state.job.job_id, stop_id: 'S1', reason: 'test' });
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.state.job.gate_state, 'HELD');
  });

  it('leaves an owner-paused job alone across driver switches', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'job_paused', job_id: ledger.state.job.job_id, by: 'owner' });
    driverSwitch(fake, 'atlas');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'paused');
    assert.equal(ledger.state.job.paused_by, 'owner');
    assert.equal(ledger.state.job.owner_touched, true);
  });

  it('ends the auto job on the first turn after a session resume', async () => {
    const { fake, ledger, autoAtlas } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    autoAtlas.noteSessionStart({ reason: 'resume' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('ends the auto job when the owner requests a plan', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    await fake.emit('input', userInput('/ulw-plan'));
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('handlers are registered without previewSafe and ignore preview passes', async () => {
    const fake = createFakePi({ sessionId: 't-prev', entries: [driverEntry('atlas')] });
    const ledger = createLedger(fake.pi);
    const seen = [];
    const origOn = fake.pi.on.bind(fake.pi);
    fake.pi.on = (...args) => { seen.push(args); return origOn(...args); };
    registerAutoAtlas(fake.pi, { ledger, getSessionStatus: () => 'lead' });
    const bas = seen.filter(([name]) => name === 'before_agent_start');
    assert.equal(bas.length, 1);
    assert.notEqual(bas[0][2]?.previewSafe, true);
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', { preview: true, systemPrompt: 'base' });
    assert.equal(ledger.state.job, null);
  });

  it('reloads and keeps the active auto job without pausing on first turn', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    const runId = ledger.state.job.auto.run_id;

    // Simulate reload: fresh auto-atlas instance on the same ledger/session
    // A0-A7 rule: first turn after reload rebuilds the run from ledger's auto.run_id
    // and is NOT treated as "no run" (which would pause the job)
    const freshAuto = registerAutoAtlas(fake.pi, { ledger, getSessionStatus: () => 'lead' });
    freshAuto.noteSessionStart({}); // normal reload (reason not resume/fork)
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.state.job.auto.run_id, runId);
    assert.equal(ledger.state.job.paused_by, null);
  });

  it('defers A1 session_restarted while a STOP is open or consult is running', async () => {
    const { fake, ledger, autoAtlas } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'stop_opened', job_id: ledger.state.job.job_id, stop_id: 'S1', reason: 'blocker' });
    autoAtlas.noteSessionStart({ reason: 'resume' });
    await fake.emit('before_agent_start', base);
    // Still active because STOP is open
    assert.equal(ledger.state.job.status, 'active');
    // Clear STOP
    ledger.append({ type: 'stop_override', job_id: ledger.state.job.job_id, stop_id: 'S1', reason: 'cleared', actor: 'owner' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('A4: /skill:ulw-plan ends the auto job', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    await fake.emit('input', userInput('/skill:ulw-plan'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    const ended = fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0][1].reason, 'plan_request');
  });

  it('A3: superseded ends previous auto job and opens a new run', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    const firstJobId = ledger.state.job.job_id;
    const firstRunId = ledger.state.job.auto.run_id;
    assert.equal(firstJobId, 'J1');

    // New owner run
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J2');
    assert.equal(ledger.state.job.status, 'active');
    assert.notEqual(ledger.state.job.auto.run_id, firstRunId);

    const endedEvents = fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(endedEvents.length, 1);
    assert.equal(endedEvents[0][1].job_id, 'J1');
    assert.equal(endedEvents[0][1].reason, 'superseded');
  });

  it('A3: superseded waits while a consult runs and keeps its answer', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1', slot: 'work', kind: 'work' });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J1');
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended').length, 0);
    ledger.append({ type: 'consult_finished', request_id: 'r1', status: 'answered' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J2');
    const ended = fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0][1].job_id, 'J1');
    assert.equal(ended[0][1].reason, 'superseded');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'consult_interrupted').length, 0);
  });

  it('A3: superseded waits while a STOP is open and releases it only after the STOP clears', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'stop_opened', job_id: 'J1', stop_id: 'S1', reason: 'blocker' });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J1');
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended').length, 0);
    ledger.append({ type: 'stop_override', job_id: 'J1', stop_id: 'S1', reason: 'cleared', actor: 'owner' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J2');
    const ended = fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0][1].reason, 'superseded');
  });

  it('A7: never opens an auto job when a manual job exists', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 1, at: new Date().toISOString() });
    assert.equal(ledger.state.job.auto, null);
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    // Still J1 manual, not superseded or auto
    assert.equal(ledger.state.job.job_id, 'J1');
    assert.equal(ledger.state.job.auto, null);
  });

  it('does not reopen an auto job for the same run id once closed', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J1');
    ledger.append({ type: 'job_ended', job_id: 'J1', by: 'owner' });
    assert.equal(ledger.state.job.status, 'closed');
    // Another before_agent_start without a new /ulw-execute should NOT reopen
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('owner precedence: /oracle off/end marks owner_touched and J3 ignores it', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.owner_touched, false);
    ledger.append({ type: 'job_paused', job_id: 'J1', by: 'owner' });
    assert.equal(ledger.state.job.owner_touched, true);
    // Driver switch should not resume it
    driverSwitch(fake, 'atlas');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'paused');
  });

  it('A0: an owner-touched active auto job is left alone by a later driver switch', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'job_resumed', job_id: 'J1', by: 'owner' });
    assert.equal(ledger.state.job.owner_touched, true);
    assert.equal(ledger.state.job.status, 'active');
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.state.job.paused_by, null);
  });

  it('A4: /ulw-plan ends the auto job and a later non-atlas turn does not pause it', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    await fake.emit('input', userInput('/ulw-plan'));
    assert.equal(ledger.state.job.status, 'closed');
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_paused').length, 0);
  });

  it('A4: a plan request during an open STOP defers the end until the STOP clears', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    const jobId = ledger.state.job.job_id;
    ledger.append({ type: 'stop_opened', job_id: jobId, stop_id: 'S1', reason: 'blocker' });
    await fake.emit('input', userInput('/ulw-plan'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    ledger.append({ type: 'stop_override', job_id: jobId, stop_id: 'S1', reason: 'cleared', actor: 'owner' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    const ended = fake.calls.appendEntry.filter(([, d]) => d.type === 'job_ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0][1].reason, 'plan_request');
    assert.equal(ended[0][1].by, 'auto');
  });

  it('A4: a plan request during a running consult defers the end and leaves the consult running', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1', slot: 'work', kind: 'work' });
    await fake.emit('input', userInput('/ulw-plan'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    assert.equal(ledger.hasPendingConsult, true);
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'consult_interrupted').length, 0);
    ledger.append({ type: 'consult_finished', request_id: 'r1', status: 'answered' });
    assert.equal(ledger.hasPendingConsult, false);
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('A4: an ended plan run is never reopened by a later atlas turn', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    await fake.emit('input', userInput('/ulw-plan'));
    await fake.emit('before_agent_start', base);
    await fake.emit('before_agent_start', base);
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_opened').length, 1);
    assert.equal(ledger.state.job.status, 'closed');
  });

  it('A4: a restart end deferred by a STOP is never paused or reopened by a non-atlas turn', async () => {
    const { fake, ledger, autoAtlas } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    const jobId = ledger.state.job.job_id;
    ledger.append({ type: 'stop_opened', job_id: jobId, stop_id: 'S1', reason: 'blocker' });
    autoAtlas.noteSessionStart({ reason: 'resume' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    ledger.append({ type: 'stop_override', job_id: jobId, stop_id: 'S1', reason: 'cleared', actor: 'owner' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    driverSwitch(fake, 'atlas');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_paused').length, 0);
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_opened').length, 1);
  });

  it('A4: a restart end deferred by a running consult waits for the consult to clear', async () => {
    const { fake, ledger, autoAtlas } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1', slot: 'work', kind: 'work' });
    autoAtlas.noteSessionStart({ reason: 'resume' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
    ledger.append({ type: 'consult_finished', request_id: 'r1', status: 'answered' });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'closed');
    assert.equal(fake.calls.appendEntry.filter(([, d]) => d.type === 'job_paused').length, 0);
  });

  it('malformed newest driver entry treats driver as sisyphus and does not keep job alive on stale atlas', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');

    // Newer malformed primary-agent/v1 entry (e.g. schemaVersion 99)
    fake.entries.push({
      type: 'custom', id: 'driver-malformed', customType: 'primary-agent/v1',
      data: { schemaVersion: 99, agentId: 'atlas' },
    });
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'paused');
    assert.equal(ledger.state.job.paused_by, 'auto');
  });

  it('defers A5 pause while a consult is running', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1', slot: 'work', kind: 'work' });
    assert.equal(ledger.hasPendingConsult, true);
    driverSwitch(fake, 'sisyphus');
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.status, 'active');
  });

  it('the auto open sets the nature job-open horizon', async () => {
    const { fake } = setup({ entries: [driverEntry('atlas')] });
    const nature = registerNature(fake.pi, {});
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', {});
    assert.equal(typeof nature.getState('lead-1').jobOpen, 'number');
  });

  it('a reload does NOT re-seed job-open: after a rebuild the job-open horizon is unset', async () => {
    // own session id: the nature module keeps per-session state across tests (--test-isolation=none)
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')], sessionId: 'reload-1' });
    const nature = registerNature(fake.pi, {});
    ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 1, auto: { run_id: 'R-old', trigger: 'atlas_ulw_execute' } });
    await fake.emit('before_agent_start', {});
    assert.equal(ledger.state.job.job_id, 'J1');
    assert.equal(nature.getState('reload-1').jobOpen, null);
  });

  it('noteJobOpen is called on job open seeding nature horizons', async () => {
    const { fake, ledger } = setup({ entries: [driverEntry('atlas')] });
    const { registerNature } = await import('../src/nature.mjs');
    registerNature(fake.pi, {});
    // Emit task before job open so nature records it
    await fake.emit('tool_call', { toolName: 'task', toolCallId: 't1', input: { category: 'visual-engineering', prompt: 'test' } });
    const { getNature } = await import('../src/nature.mjs');
    assert.equal(getNature('lead-1', 'completion'), 'design');

    // Now trigger auto job open; noteJobOpen should be called setting jobOpen horizon
    await fake.emit('input', userInput('/ulw-execute'));
    await fake.emit('before_agent_start', base);
    assert.equal(ledger.state.job.job_id, 'J1');

    // Completion consult after job open needs records strictly after job open -> neutral
    assert.equal(getNature('lead-1', 'completion'), 'neutral');
  });
});
