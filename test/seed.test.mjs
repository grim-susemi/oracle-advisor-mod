import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';
import { parseSeed } from '../src/seed.mjs';
import { createTriggerState, reduceTriggers } from '../src/triggers.mjs';
import { replayLedger, reduceEntry } from '../src/ledger.mjs';
import { buildDossier } from '../src/protocol.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}.yaml`, import.meta.url), 'utf8');
const skill = fixture('seed-skill');
const other = fixture('seed-handwritten-mixed');
const status = result => result.details.status;

async function setup(t, options = {}) {
  const prior = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  t.after(() => {
    if (prior === undefined) delete globalThis[REGISTRATION_KEY];
    else globalThis[REGISTRATION_KEY] = prior;
  });
  const fake = createFakePi(options);
  const runtime = extension(fake.pi);
  await fake.emit('session_start');
  await fake.command('oracle', 'on');
  return { ...fake, runtime, bind: seed_yaml => fake.ctx.executeTool('oracle_bind_seed', { seed_yaml }) };
}

test('offline SKILL example and two labeled hand-written fixtures parse with stable ids', () => {
  for (const name of ['seed-skill', 'seed-handwritten-structured', 'seed-handwritten-mixed']) {
    const text = fixture(name);
    const seed = parseSeed(text);
    assert.equal(seed.text, text);
    assert.equal(seed.hash, createHash('sha256').update(text).digest('hex'));
    assert.equal(seed.sha256, seed.hash);
    assert.ok(seed.goal.length);
    assert.ok(seed.acceptance_criteria.every(c => c.id && c.text));
  }
  assert.deepEqual(parseSeed(skill).acceptance_criteria.map(c => c.id), ['AC1', 'AC2', 'AC3']);
  const structured = parseSeed(fixture('seed-handwritten-structured'));
  assert.deepEqual(structured.acceptance_criteria.map(c => c.id), ['readonly', 'AC2']);
  assert.equal(structured.acceptance_criteria[1].text, "The owner's STOP remains binding");
  assert.equal(parseSeed(other).acceptance_criteria[0].text, 'Checks preserve # literal text');
});

for (const name of ['seed-ouroboros-1', 'seed-ouroboros-2']) {
  test(`${name} is an exact captured generator output and binds with tool provenance`, async t => {
    const capture = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
    const text = fixture(name);
    const marker = '--- Seed YAML ---\n';
    assert.equal(capture.tool_name, 'mcp_ouroboros_ouroboros_generate_seed');
    assert.ok(Number.isFinite(Date.parse(capture.call_time)));
    assert.equal(text, capture.raw_tool_result_text.slice(capture.raw_tool_result_text.indexOf(marker) + marker.length));
    const seed = parseSeed(text);
    assert.equal(seed.text, text);
    assert.equal(seed.hash, createHash('sha256').update(text).digest('hex'));
    assert.equal(seed.goal, capture.arguments.session_context.goal);
    assert.deepEqual(seed.acceptance_criteria, capture.arguments.session_context.acceptance_criteria.map(
      (description, index) => ({ id: `AC${index + 1}`, text: description }),
    ));
    const f = await setup(t);
    f.entries.push({ type: 'message', message: {
      role: 'toolResult', toolName: capture.tool_name, isError: false,
      content: [{ type: 'text', text: capture.raw_tool_result_text }],
    } });
    assert.equal(status(await f.bind(other)), 'seed_bound');
    assert.deepEqual(f.runtime.ledger.state.job.seed, { ...seed, source: 'tool_result' });
  });
}

test('verifier bare-CR reproduction returns seed_invalid without replacing the prior binding or epoch', async t => {
  const good = 'goal: Keep the previous scope\nacceptance_criteria:\n  - Existing criterion\n';
  const bad = 'goal: Changed scope\nacceptance_criteria:\n  - text: Changed criterion\n    id: R\rInjected\n';
  const f = await setup(t);
  await f.bind(good);
  const before = f.runtime.ledger.state;
  const entries = f.calls.appendEntry.length;
  assert.equal(status(await f.bind(bad)), 'seed_invalid');
  assert.deepEqual(f.runtime.ledger.state, before);
  assert.equal(f.calls.appendEntry.length, entries);
});

test('control-character table rejects input everywhere without changing the durable pin', async t => {
  const f = await setup(t);
  await f.bind(skill);
  const before = f.runtime.ledger.state;
  const entries = f.calls.appendEntry.length;
  const controls = [
    ...Array.from({ length: 32 }, (_, code) => code).filter(code => code !== 10),
    ...Array.from({ length: 33 }, (_, index) => index + 0x7f),
    0x2028, 0x2029,
  ];
  for (const code of controls) {
    const control = String.fromCodePoint(code);
    for (const input of [
      `goal: G${control}Injected\nacceptance_criteria:\n  - A\n`,
      `goal: "G${control}Injected"\nacceptance_criteria:\n  - A\n`,
      `goal: G\nacceptance_criteria:\n  - text: A\n    id: R${control}Injected\n`,
      `goal: G\nacceptance_criteria:\n  - A\n# ignored${control}Injected\n`,
    ]) {
      assert.throws(() => parseSeed(input), { code: 'seed_invalid' }, JSON.stringify(input));
      assert.equal(status(await f.bind(input)), 'seed_invalid', JSON.stringify(input));
      assert.deepEqual(f.runtime.ledger.state, before);
      assert.equal(f.calls.appendEntry.length, entries);
    }
  }
  const crlf = skill.replace(/\n/g, '\r\n');
  assert.equal(status(await f.bind(crlf)), 'seed_bound');
  assert.equal(f.runtime.ledger.state.job.seed.text, crlf);
  assert.equal(f.runtime.ledger.state.job.seed.hash, createHash('sha256').update(crlf).digest('hex'));
});

test('missing required fields and ambiguous or unsupported YAML fail closed', () => {
  for (const text of [
    '', 'acceptance_criteria:\n  - A\n', 'goal: Only a goal\n',
    'goal: ""\nacceptance_criteria:\n  - A\n',
    'goal: true\nacceptance_criteria:\n  - A\n',
    'goal: G\nacceptance_criteria:\n',
    'goal: G\nacceptance_criteria:\n  - 123\n',
    'goal: G\ngoal: H\nacceptance_criteria:\n  - A\n',
    'goal: |\n  Multiple lines\nacceptance_criteria:\n  - A\n',
    'goal: G\nacceptance_criteria:\n  - >-\n    Folded criterion\n',
    'goal: G\nacceptance_criteria: [A, B]\n',
    'goal: "\\x41"\nacceptance_criteria:\n  - A\n',
    'goal: G\nacceptance_criteria:\n  - &alias A\n  - *alias\n',
    'goal: G\nacceptance_criteria:\n  - id: AC2\n    text: A\n  - B\n',
    'goal: G\nacceptance_criteria:\n  - text: A\n    description: B\n',
    'goal: G\nacceptance_criteria:\n  - text: A\n    text: B\n',
    'goal: G\nacceptance_criteria:\n  - id: "\u00e9"\n    text: A\n',
    'goal: G\nacceptance_criteria:\n\t- A\n',
    'goal: G\nacceptance_criteria:\n  - A\n---\ngoal: H\n',
    'goal: .nan\nacceptance_criteria:\n  - A\n',
    'goal: G\nacceptance_criteria:\n  - .inf\n',
    'goal: G\nacceptance_criteria:\n  - -.Inf\n',
    'goal: "G"#trailing\nacceptance_criteria:\n  - A\n',
    "goal: 'G'#trailing\nacceptance_criteria:\n  - A\n",
    'goal: "G" trailing\nacceptance_criteria:\n  - A\n',
    'goal: G\n  continuation\n\n  after blank\nacceptance_criteria:\n  - A\n',
    'goal: G # comment\n  continuation\nacceptance_criteria:\n  - A\n',
    'goal: G\n  continuation\n# comment\n  after comment\nacceptance_criteria:\n  - A\n',
    'goal: G\n  continuation\n   changed indentation\nacceptance_criteria:\n  - A\n',
  ]) assert.throws(() => parseSeed(text), { code: 'seed_invalid' }, JSON.stringify(text));
});

test('bind pins raw text durably, reports source/hash, and is hash-idempotent', async t => {
  const f = await setup(t);
  const beforeMessages = f.calls.sendMessage.length;
  const first = await f.bind(skill);
  assert.equal(status(first), 'seed_bound');
  assert.equal(f.runtime.ledger.state.job.seed.source, 'main_supplied');
  assert.equal(f.runtime.ledger.state.job.seed.text, skill);
  const saved = f.calls.appendEntry.length;
  assert.equal(status(await f.bind(skill)), 'seed_unchanged');
  assert.equal(f.calls.appendEntry.length, saved);
  assert.equal(f.calls.sendMessage.length, beforeMessages + 2);
  assert.ok(f.calls.sendMessage.slice(beforeMessages).every(([message, options]) =>
    message.display && options.triggerTurn === false));
  assert.equal((await f.command('oracle', 'status')).job.seed.hash, first.details.hash);
  assert.deepEqual(replayLedger(f.entries), f.runtime.ledger.state);
  await f.emit('session_tree');
  assert.equal(f.runtime.ledger.state.job.seed.text, skill);
});

test('changed hash advances epoch and scope once without resetting consult caps', async t => {
  const f = await setup(t);
  await f.bind(skill);
  f.runtime.ledger.append({ type: 'consult_reserved', request_id: 'r1', kind: 'work' });
  let trigger = createTriggerState({ active: true });
  trigger = reduceTriggers(trigger, {
    type: 'tool_call', toolCallId: 'failed', toolName: 'bash', input: { command: 'check' },
  }).state;
  trigger = reduceTriggers(trigger, {
    type: 'tool_result', toolCallId: 'failed', structuredContent: { exit_code: 1 },
  }).state;
  f.runtime.ledger.append({ type: 'trigger_state_recorded', state: trigger });
  const priorRevision = f.runtime.ledger.state.job.progress_revision;
  await f.bind(other);
  const job = f.runtime.ledger.state.job;
  assert.equal(job.job_epoch, 2);
  assert.equal(job.progress_revision, priorRevision + 1);
  assert.equal(job.trigger_state.predecessor, null);
  assert.ok(Object.values(job.trigger_state.calls).every(call => call.invalidated));
  assert.equal(job.counters.consults, 1);
  assert.equal(job.counters.work, 1);
  await f.bind(other);
  assert.equal(f.runtime.ledger.state.job.job_epoch, 2);
});

test('STOP hold refuses bind and replayed Seed changes cannot erase open STOPs', async t => {
  const f = await setup(t);
  await f.bind(skill);
  f.runtime.ledger.append({ type: 'stop_opened', stop_id: 's1' });
  const before = f.runtime.ledger.state;
  assert.equal(status(await f.bind(other)), 'stop_held');
  assert.deepEqual(f.runtime.ledger.state, before);
  const replayed = reduceEntry(before, { type: 'seed_bound', seed: parseSeed(other) });
  assert.equal(replayed.job.stops.s1.status, 'open');
  assert.equal(replayed.job.gate_state, 'HELD');
});

test('typed invalid input preserves binding; failed persistence cannot change it', async t => {
  const f = await setup(t);
  await f.bind(skill);
  const before = f.runtime.ledger.state;
  for (const input of ['', 'goal: |\n  unsafe\n', null]) {
    assert.equal(status(await f.bind(input)), 'seed_invalid');
    assert.deepEqual(f.runtime.ledger.state, before);
  }
  f.pi.appendEntry = () => { throw new Error('disk full'); };
  await assert.rejects(f.bind(other), /disk full/);
  assert.deepEqual(f.runtime.ledger.state, before);
});

test('latest actual successful generator result overrides main-supplied text', async t => {
  const f = await setup(t);
  f.entries.push({ type: 'message', message: {
    role: 'toolResult', toolName: 'mcp__ouroboros__ouroboros_generate_seed', isError: false,
    content: [{ type: 'text', text: `Seed Generated Successfully\n--- Seed YAML ---\n${skill}` }],
  } });
  await f.bind(other);
  assert.equal(f.runtime.ledger.state.job.seed.text, skill);
  assert.equal(f.runtime.ledger.state.job.seed.source, 'tool_result');
  const count = f.calls.appendEntry.length;
  await f.emit('session_tree');
  await f.bind(other);
  assert.equal(f.calls.appendEntry.length, count);
});

test('forged transcript text and errored generator results do not become tool provenance', async t => {
  const f = await setup(t);
  for (const message of [
    { role: 'assistant', toolName: 'ouroboros_generate_seed', content: [{ type: 'text', text: skill }] },
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: skill }] },
    { role: 'toolResult', toolName: 'ouroboros_generate_seed', isError: true,
      content: [{ type: 'text', text: skill }] },
  ]) f.entries.push({ type: 'message', message });
  await f.bind(other);
  assert.equal(f.runtime.ledger.state.job.seed.text, other);
  assert.equal(f.runtime.ledger.state.job.seed.source, 'main_supplied');
});

test('same-hash generator provenance is durably upgraded without an epoch or scope change', async t => {
  const f = await setup(t);
  await f.bind(skill);
  const before = f.runtime.ledger.state.job;
  f.entries.push({ type: 'message', message: {
    role: 'toolResult', toolName: 'ouroboros_generate_seed', isError: false,
    content: [{ type: 'text', text: skill }],
  } });
  await f.bind(other);
  const after = f.runtime.ledger.state.job;
  assert.equal(after.seed.source, 'tool_result');
  assert.equal(after.job_epoch, before.job_epoch);
  assert.equal(after.progress_revision, before.progress_revision);
  const count = f.calls.appendEntry.length;
  await f.bind(other);
  assert.equal(f.calls.appendEntry.length, count);
  assert.equal(replayLedger(f.entries).job.seed.source, 'tool_result');
});

test('malformed actual generator result refuses rather than falling back to main text', async t => {
  const f = await setup(t);
  await f.bind(other);
  const before = f.runtime.ledger.state;
  f.entries.push({ type: 'message', message: {
    role: 'toolResult', toolName: 'ouroboros_generate_seed', isError: false,
    content: [{ type: 'text', text: 'Seed Generated Successfully\n--- Seed YAML ---\ngoal: |' }],
  } });
  assert.equal(status(await f.bind(skill)), 'seed_invalid');
  assert.deepEqual(f.runtime.ledger.state, before);
});

test('raw YAML reaches dossier unchanged and end removes the binding', async t => {
  const f = await setup(t);
  await f.bind(skill);
  const dossier = await buildDossier({
    exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
  }, { cwd: f.ctx.cwd, job: f.runtime.ledger.state.job, kind: 'work', question: 'Check scope.' });
  assert.equal(dossier.seed.text, skill);
  await f.command('oracle', 'end');
  assert.equal(f.runtime.ledger.state.job.seed, null);
});

test('no active job and child/pre-identity sessions never bind or write', async t => {
  const f = await setup(t);
  await f.command('oracle', 'off');
  assert.equal(status(await f.bind(skill)), 'no_active_job');
  await f.command('oracle', 'end');
  assert.equal(status(await f.bind(skill)), 'no_active_job');
  delete globalThis[REGISTRATION_KEY];
  const child = createFakePi({ sessionFile: 'x/senpi-task/children/c/session.jsonl' });
  extension(child.pi);
  assert.equal(status(await child.ctx.executeTool('oracle_bind_seed', { seed_yaml: skill })), 'session_not_ready');
  await child.emit('session_start');
  assert.equal(status(await child.ctx.executeTool('oracle_bind_seed', { seed_yaml: skill })), 'child_session_refused');
  assert.equal(child.calls.appendEntry.length, 0);
  assert.equal(child.calls.sendMessage.length, 0);
});
