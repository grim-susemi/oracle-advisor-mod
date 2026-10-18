import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePi } from './helpers/fake-pi.mjs';
import { createLedger, replayLedger } from '../src/ledger.mjs';
import { registerNudger } from '../src/nudger.mjs';

function fixture({ active = true, session = 'lead' } = {}) {
  const fake = createFakePi();
  const directory = mkdtempSync(join(tmpdir(), 'oracle-nudger-test-'));
  const ledger = createLedger(fake.pi);
  const runtime = {
    ledger, transport: { running: false }, getSessionStatus: () => session,
    registerTool: tool => fake.pi.registerTool(tool),
  };
  registerNudger(fake.pi, runtime, { agentDir: () => directory });
  if (active) ledger.append({ type: 'job_opened', job_id: 'J1' });
  let next = 0;
  const call = async (toolName = 'bash', input = { command: 'check' }, extra = {}) => {
    const event = { type: 'tool_call', toolName, toolCallId: `call-${++next}`, input, ...extra };
    await fake.emit('tool_call', event);
    return event;
  };
  const result = async (event, extra = {}) => {
    const input = { ...event, type: 'tool_result', content: [{ type: 'text', text: 'native output' }],
      details: { native: true }, structuredContent: { exit_code: 1 }, isError: true, ...extra };
    const patches = await fake.emit('tool_result', input);
    return { event: input, patch: patches.find(Boolean) };
  };
  const fail = async input => result(await call('bash', input));
  const turn = () => fake.emit('turn_end', { type: 'turn_end', toolResults: [{}] });
  const finish = () => fake.tools.get('oracle_advisor').execute(
    `finish-${++next}`, { action: 'finish_intent' }, undefined, undefined, fake.ctx);
  return { ...fake, ledger, runtime, call, result, fail, turn, finish,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('second serial failure preserves content, structuredContent and details identities', async () => {
  const f = fixture();
  try {
    await f.fail();
    const { event, patch } = await f.fail();
    assert.equal(patch.content.length, 2);
    assert.equal(patch.content[0], event.content[0]);
    assert.equal(patch.structuredContent, event.structuredContent);
    assert.equal(patch.details, event.details);
    const nudge = f.ledger.state.job.nudges[0];
    assert.deepEqual(nudge.tool_call_ids, ['call-1', 'call-2']);
    assert.equal(nudge.error_class, 'exit:1');
    await f.result(event);
    assert.equal((await f.fail()).patch, undefined);
    assert.equal(f.ledger.state.job.counters.nudges, 1);
    assert.deepEqual(replayLedger(f.entries), f.ledger.state);
    assert.equal(f.calls.sendMessage.length, 0);
  } finally { f.close(); }
});

test('two completed tool-bearing turns separate failure notices; completion bypasses cooldown', async () => {
  const f = fixture();
  try {
    await f.fail(); await f.turn();
    assert.ok((await f.fail()).patch);
    await f.turn();
    await f.fail({ command: 'other' });
    assert.equal((await f.fail({ command: 'other' })).patch, undefined);
    const completion = await f.finish();
    assert.equal(completion.details.status, 'nudge');
    await f.turn();
    await f.fail({ command: 'third' });
    assert.ok((await f.fail({ command: 'third' })).patch);
    await f.turn(); await f.turn();
    await f.fail({ command: 'fourth' });
    assert.equal((await f.fail({ command: 'fourth' })).patch, undefined);
    assert.equal((await f.finish()).details.status, 'no_nudge');
    assert.equal(f.ledger.state.job.counters.nudges, 3);
    assert.equal(f.ledger.state.job.counters.failure_nudges, 2);
  } finally { f.close(); }
});

test('empty turns do not advance failure cooldown', async () => {
  const f = fixture();
  try {
    await f.fail(); await f.fail(); await f.turn();
    await f.emit('turn_end', { toolResults: [] });
    await f.emit('turn_end', { toolResults: [] });
    await f.fail({ command: 'other' });
    assert.equal((await f.fail({ command: 'other' })).patch, undefined);
  } finally { f.close(); }
});

test('brief result uses the completion notice once and preserves other result fields', async () => {
  const f = fixture();
  try {
    const { event, patch } = await f.result(await f.call('brief', {}), { isError: false });
    assert.equal(patch.content.length, 2);
    assert.equal(patch.details, event.details);
    assert.equal(patch.structuredContent, event.structuredContent);
    assert.equal((await f.finish()).details.status, 'no_nudge');
    assert.equal(f.ledger.state.job.nudges[0].kind, 'completion');
  } finally { f.close(); }
});

test('completion coverage is revision-specific and invalid advice does not cover it', async () => {
  const f = fixture();
  try {
    f.ledger.append({ type: 'consult_reserved', request_id: 'c1', kind: 'completion', progress_revision: 0 });
    f.ledger.append({ type: 'consult_finished', request_id: 'c1', kind: 'completion',
      status: 'answered', verdict: 'CONTINUE', progress_revision: 0 });
    assert.equal((await f.finish()).details.status, 'no_nudge');
    await f.result(await f.call('edit', {}), { isError: false, structuredContent: undefined });
    assert.equal(f.ledger.state.job.progress_revision, 1);
    assert.equal((await f.finish()).details.status, 'nudge');
  } finally { f.close(); }
  const invalid = fixture();
  try {
    invalid.ledger.append({ type: 'consult_finished', request_id: 'bad', kind: 'completion',
      status: 'invalid', progress_revision: 0 });
    assert.equal((await invalid.finish()).details.status, 'nudge');
  } finally { invalid.close(); }
});

test('inactive, paused, child, pending and exhausted jobs never nudge', async () => {
  for (const variant of ['inactive', 'paused', 'child', 'pending', 'reserved', 'exhausted']) {
    const f = fixture({ active: variant !== 'inactive', session: variant === 'child' ? 'child' : 'lead' });
    try {
      if (variant === 'paused') f.ledger.append({ type: 'job_paused' });
      if (variant === 'pending') f.runtime.transport.running = true;
      if (variant === 'reserved') f.ledger.append({ type: 'consult_reserved', request_id: 'c', kind: 'work' });
      if (variant === 'exhausted') for (let n = 0; n < 4; n++) {
        f.ledger.append({ type: 'consult_reserved', request_id: `c${n}`, kind: n === 3 ? 'completion' : 'work' });
        f.ledger.append({ type: 'consult_finished', request_id: `c${n}`, status: 'unavailable' });
      }
      await f.fail();
      assert.equal((await f.fail()).patch, undefined, variant);
      assert.equal((await f.finish()).details.status, 'no_nudge', variant);
      assert.equal(f.ledger.state.job?.counters.nudges ?? 0, 0, variant);
    } finally { f.close(); }
  }
});

test('consult descendants cannot cause failures, progress or completion notices', async () => {
  const f = fixture();
  try {
    const consult = await f.call('oracle_consult', { kind: 'work' });
    for (const tool of ['bash', 'bash', 'edit', 'brief']) {
      await f.result(await f.call(tool, {}, { parentToolCallId: consult.toolCallId }));
    }
    assert.equal(f.ledger.state.job.progress_revision, 0);
    assert.equal(f.ledger.state.job.counters.nudges, 0);
  } finally { f.close(); }
});

test('accepted dispositions advance progress and prompt patch composes only for active leads', async () => {
  const f = fixture();
  try {
    const [patch] = await f.emit('before_agent_start', { systemPrompt: 'Existing extension rule.' });
    assert.ok(patch.systemPrompt.startsWith('Existing extension rule.'));
    f.ledger.append({ type: 'stop_opened', stop_id: 's' });
    f.ledger.append({ type: 'stop_disposition', stop_id: 'unknown', decision: 'proceed' });
    assert.equal(f.ledger.state.job.progress_revision, 0);
    f.ledger.append({ type: 'stop_disposition', stop_id: 's', decision: 'redirect' });
    assert.equal(f.ledger.state.job.progress_revision, 1);
    f.ledger.append({ type: 'job_paused' });
    assert.deepEqual(await f.emit('before_agent_start', { systemPrompt: 'Original' }), [undefined]);
  } finally { f.close(); }
});
