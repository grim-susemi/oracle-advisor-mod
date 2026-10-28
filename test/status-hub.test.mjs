import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createFakePi } from './helpers/fake-pi.mjs';
import { createLedger } from '../src/ledger.mjs';
import { registerStatusHub, STATUS_KEY } from '../src/status-hub.mjs';
// Same key as REGISTRATION_KEY in src/extension.mjs, referenced without importing
// the extension graph (other workers edit those modules concurrently).
const REGISTRATION_KEY = Symbol.for('omo.oracle-advisor.v1');

function makeRuntime(pi, ledger) {
  return { ledger, getSessionStatus: () => 'lead' };
}

function openJob(ledger, job_id = 'J1') {
  ledger.append({ type: 'job_opened', job_id, job_epoch: 1, at: '2026-10-28T00:00:00.000Z' });
}

function hubOf() {
  return globalThis[STATUS_KEY];
}

describe('status-hub shape', () => {
  let saved;
  beforeEach(() => {
    saved = globalThis[STATUS_KEY];
    delete globalThis[STATUS_KEY];
    delete globalThis[REGISTRATION_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete globalThis[STATUS_KEY];
    else globalThis[STATUS_KEY] = saved;
    delete globalThis[REGISTRATION_KEY];
  });

  it('adds exactly one global: the status hub key', async () => {
    const globalsBefore = Reflect.ownKeys(globalThis).filter(k => typeof k === 'symbol');
    assert.ok(!globalsBefore.includes(STATUS_KEY));
    assert.ok(!globalsBefore.includes(REGISTRATION_KEY));
    const fake = createFakePi({ sessionId: 's0' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    const globalsAfter = Reflect.ownKeys(globalThis).filter(k => typeof k === 'symbol');
    assert.deepEqual(globalsAfter.filter(k => !globalsBefore.includes(k)), [STATUS_KEY]);
  });

  it('publishes the no-job snapshot at session start before any job', async () => {
    const fake = createFakePi({ sessionId: 'sess-nojob' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    const hub = hubOf();
    assert.equal(hub.v, 1);
    assert.equal(Object.getPrototypeOf(hub.sessions), null);
    assert.deepEqual(hub.sessions['sess-nojob'], {
      job_id: null, status: null, gate_state: null, auto: null,
      consults_remaining: null, open_stops: 0, last_advisor: null,
    });
    assert.ok(Object.isFrozen(hub.sessions['sess-nojob']));
  });

  it('follows gate_state through HELD and HALTED', async () => {
    const fake = createFakePi({ sessionId: 's1' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J7');
    assert.equal(hubOf().sessions['s1'].gate_state, 'ACTIVE');
    assert.equal(hubOf().sessions['s1'].status, 'active');
    ledger.append({ type: 'stop_opened', job_id: 'J7', stop_id: 'S1', decision: 'halt', reason: 'x'.repeat(1) });
    assert.equal(hubOf().sessions['s1'].gate_state, 'HELD');
    ledger.append({ type: 'stop_disposition', job_id: 'J7', stop_id: 'S1', decision: 'halt', reason: 'r' });
    assert.equal(hubOf().sessions['s1'].gate_state, 'HALTED');
    assert.equal(hubOf().sessions['s1'].open_stops, 1);
  });

  it('snapshot is frozen; assignment throws in strict mode', async () => {
    const fake = createFakePi({ sessionId: 's2' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    const snap = hubOf().sessions['s2'];
    assert.ok(Object.isFrozen(snap));
    assert.throws(() => { snap.job_id = 'JX'; }, TypeError);
    assert.throws(() => { snap.auto = { run_id: 'z' }; }, TypeError);
  });

  it('sessions is a null-prototype object', async () => {
    const fake = createFakePi({ sessionId: 's3' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    assert.equal(Object.getPrototypeOf(hubOf().sessions), null);
  });

  it('contains no function values (deep walk)', async () => {
    const fake = createFakePi({ sessionId: 's4' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    ledger.append({ type: 'stop_opened', job_id: 'J1', stop_id: 'S1' });
    const walk = value => {
      if (typeof value === 'function') assert.fail('function value in snapshot');
      if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
    };
    walk(hubOf());
  });

  it('replaces (not mutates) the snapshot on change', async () => {
    const fake = createFakePi({ sessionId: 's5' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    const before = hubOf().sessions['s5'];
    openJob(ledger, 'J1');
    const after = hubOf().sessions['s5'];
    assert.notEqual(before, after);
    assert.equal(before.job_id, null);
    assert.equal(after.job_id, 'J1');
    ledger.append({ type: 'job_paused', job_id: 'J1', by: 'owner', reason: 'r' });
    const third = hubOf().sessions['s5'];
    assert.notEqual(after, third);
    assert.equal(after.status, 'active');
    assert.equal(third.status, 'paused');
  });

  it('removes the session snapshot on shutdown (stale_state)', async () => {
    const fake = createFakePi({ sessionId: 's6' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    assert.ok(hubOf().sessions['s6']);
    await fake.emit('session_shutdown', {});
    assert.ok(!Object.hasOwn(hubOf().sessions, 's6'));
  });

  it('leaves the existing omo.oracle-advisor.v1 registration unchanged', async () => {
    const regKey = REGISTRATION_KEY;
    const runtimeRef = { marker: true };
    const reg = { generation: 3, liveGenerations: 1, runtime: runtimeRef, disabled: false };
    globalThis[regKey] = reg;
    const before = { ...reg };
    const keysBefore = Reflect.ownKeys(reg);
    const globalsBefore = Reflect.ownKeys(globalThis).filter(k => typeof k === 'symbol');
    const fake = createFakePi({ sessionId: 's7' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    await fake.emit('session_shutdown', {});
    assert.equal(globalThis[regKey], reg);
    assert.equal(globalThis[regKey].runtime, runtimeRef);
    assert.deepEqual({ ...globalThis[regKey] }, before);
    assert.deepEqual(Reflect.ownKeys(globalThis[regKey]), keysBefore);
    const globalsAfter = Reflect.ownKeys(globalThis).filter(k => typeof k === 'symbol');
    assert.deepEqual(globalsAfter.filter(k => !globalsBefore.includes(k)), [STATUS_KEY]);
    delete globalThis[regKey];
  });

  it('reports 4 consults remaining at job open and fewer after a charged consult', async () => {
    const fake = createFakePi({ sessionId: 's10' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    assert.equal(hubOf().sessions['s10'].consults_remaining, 4);
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1',
      job_epoch: 1, slot: 'work', kind: 'work' });
    assert.equal(hubOf().sessions['s10'].consults_remaining, 3);
  });

  it('republishes after a ledger rebuild on session_tree', async () => {
    const fake = createFakePi({ sessionId: 's11' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    assert.equal(hubOf().sessions['s11'].job_id, 'J1');
    ledger.rebuild([], []);
    assert.equal(ledger.state.job, null);
    await fake.emit('session_tree', {});
    assert.deepEqual(hubOf().sessions['s11'], {
      job_id: null, status: null, gate_state: null, auto: null,
      consults_remaining: null, open_stops: 0, last_advisor: null,
    });
    ledger.rebuild(fake.entries, fake.entries);
    await fake.emit('session_tree', {});
    assert.equal(hubOf().sessions['s11'].job_id, 'J1');
    assert.equal(hubOf().sessions['s11'].status, 'active');
    assert.equal(hubOf().sessions['s11'].consults_remaining, 4);
  });

  it('freezes nested auto and last_advisor objects', async () => {
    const fake = createFakePi({ sessionId: 's12' });
    const ledger = createLedger(fake.pi);
    const hacked = {
      get state() {
        const s = ledger.state;
        if (!s.job) return s;
        return { ...s, job: { ...s.job, auto: { run_id: 'run9', trigger: 'atlas_ulw_execute' } } };
      },
      subscribe: l => ledger.subscribe(l),
    };
    registerStatusHub(fake.pi, { ledger: hacked, getSessionStatus: () => 'lead' });
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    ledger.append({ type: 'consult_admitted', request_id: 'r1', job_id: 'J1',
      job_epoch: 1, slot: 'work', kind: 'work',
      advisor: { profile: 'gpt', source: 'by_family' } });
    const snap = hubOf().sessions['s12'];
    assert.deepEqual(snap.auto, { run_id: 'run9' });
    assert.deepEqual(snap.last_advisor, { profile: 'gpt', source: 'by_family' });
    assert.ok(Object.isFrozen(snap.auto));
    assert.ok(Object.isFrozen(snap.last_advisor));
    assert.throws(() => { snap.auto.run_id = 'other'; }, TypeError);
    assert.throws(() => { snap.last_advisor.profile = 'claude'; }, TypeError);
  });

  it('maps unknown ledger status to null (malformed input)', async () => {
    const fake = createFakePi({ sessionId: 's8' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J1');
    ledger.append({ type: 'job_paused', job_id: 'J1', reason: 'x' });
    // force an unknown status through a direct state hack is not possible via
    // the reducer; simulate by publishing with a wrapped ledger view
    const hacked = {
      get state() {
        const s = ledger.state;
        return { ...s, job: { ...s.job, status: 'bogus', gate_state: 'WEIRD' } };
      },
      subscribe: l => ledger.subscribe(l),
    };
    const fake2 = createFakePi({ sessionId: 's8b' });
    registerStatusHub(fake2.pi, { ledger: hacked, getSessionStatus: () => 'lead' });
    await fake2.emit('session_start', {});
    assert.equal(hubOf().sessions['s8b'].status, null);
    assert.equal(hubOf().sessions['s8b'].gate_state, null);
  });

  it('pauses and resumes without going busy (cancel/resume transitions)', async () => {
    const fake = createFakePi({ sessionId: 's9' });
    const ledger = createLedger(fake.pi);
    registerStatusHub(fake.pi, makeRuntime(fake.pi, ledger));
    await fake.emit('session_start', {});
    openJob(ledger, 'J2');
    ledger.append({ type: 'job_paused', job_id: 'J2', by: 'owner', reason: 'r' });
    assert.equal(hubOf().sessions['s9'].status, 'paused');
    ledger.append({ type: 'job_resumed', job_id: 'J2', by: 'owner', reason: 'r' });
    assert.equal(hubOf().sessions['s9'].status, 'active');
    assert.equal(hubOf().sessions['s9'].job_id, 'J2');
  });
});
