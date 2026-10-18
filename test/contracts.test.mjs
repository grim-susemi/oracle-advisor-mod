import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../src/contracts.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

test('product limits reserve completion and do not impose a consult deadline', () => {
  for (const [name, value] of Object.entries({
    CONSULT_CAP: 4, WORK_CONSULTS: 3, NUDGE_CAP: 3, FAILURE_NUDGES: 2,
    GATE_TERMINATE_AFTER: 5, OVERRIDE_MIN_REASON: 20, REASON_MAX: 800,
    VERDICT_REASON_MAX: 240, VERDICT_MAX_BYTES: 4096,
  })) assert.equal(contracts[name], value, name);
  assert.equal(contracts.CONSULT_CAP - contracts.WORK_CONSULTS, 1);
  assert.equal(contracts.NUDGE_CAP - contracts.FAILURE_NUDGES, 1);
  assert.equal(Object.keys(contracts).some(name => /DEADLINE|TIMEOUT/.test(name)), false);
});

test('consult receipt fields are the complete accounting contract', () => {
  assert.deepEqual(contracts.RECEIPT_FIELDS, [
    'job_id', 'job_epoch', 'request_id', 'kind', 'trigger', 'oracle_task_id',
    'oracle_run_epoch', 'path', 'status', 'latency_ms', 'main_cache_wait_exceeded',
    'analysis_chars', 'analysis_path', 'provider_stop_reason', 'engine_completion_chars',
    'model', 'usage_status', 'input_tokens', 'output_tokens', 'reasoning_tokens',
    'verdict', 'verdict_changed_direction', 'same_failure_recurred_after', 'calls_remaining', 'failure_digest', 'redirect_id',
  ]);
  assert.deepEqual(contracts.CONSULT_PATHS, ['revival', 'spawn', 'fresh_fallback']);
  assert.deepEqual(contracts.CONSULT_STATUSES, [
    'answered', 'timed_out', 'cancelled', 'oracle_dead', 'unavailable', 'quota',
    'invalid', 'interrupted', 'revival_failed', 'oracle_not_readonly',
  ]);
  assert.deepEqual(contracts.USAGE_STATUSES, ['actual', 'estimated', 'unknown']);
  assert.ok(Object.isFrozen(contracts.RECEIPT_FIELDS));
});

test('ledger discriminants cover lifecycle, oracle ownership, STOP and accounting', () => {
  assert.equal(contracts.LEDGER_ENTRY_TYPE, 'oracle-advisor');
  assert.deepEqual(contracts.LEDGER_ENTRY_TYPES, [
    'job_opened', 'job_paused', 'job_resumed', 'job_ended',
    'consult_reserved', 'consult_started', 'consult_finished', 'consult_interrupted',
    'consult_released', 'consult_effect_recorded', 'oracle_assigned', 'oracle_retired', 'revival_failed', 'stuck_record_retired',
    'verdict_recorded', 'redirect_disposition', 'stop_opened', 'stop_disposition', 'stop_override',
    'seed_bound', 'nudge_recorded', 'gate_blocked', 'progress_recorded', 'trigger_state_recorded',
  ]);
  assert.equal(new Set(contracts.LEDGER_ENTRY_TYPES).size, contracts.LEDGER_ENTRY_TYPES.length);
  assert.ok(Object.isFrozen(contracts.LEDGER_ENTRY_TYPES));
});

test('fake Pi records API calls and replays subscribed handlers in registration order', async () => {
  const fake = createFakePi();
  const order = [];
  fake.pi.on('session_start', async (event, ctx) => {
    order.push(event.marker);
    fake.pi.appendEntry(contracts.LEDGER_ENTRY_TYPE, { type: 'job_opened', job_id: 'J1' });
    assert.equal(ctx.sessionManager.getBranch().length, 1);
    return { first: true };
  });
  fake.pi.on('session_start', () => { order.push('second'); });
  fake.pi.registerCommand('probe', { handler: async args => order.push(args) });
  fake.pi.registerTool({
    name: 'probe_tool',
    execute: async (id, args) => ({ content: [{ type: 'text', text: args.value }], details: { id } }),
  });
  assert.deepEqual(await fake.emit('session_start', { marker: 'first' }), [{ first: true }, undefined]);
  await fake.command('probe', 'command');
  const result = await fake.ctx.executeTool('probe_tool', { value: 'tool result' });
  assert.equal(result.content[0].text, 'tool result');
  assert.deepEqual(order, ['first', 'second', 'command']);
  assert.equal(fake.calls.on.length, 2);
  assert.equal(fake.calls.registerCommand.length, 1);
  assert.equal(fake.calls.registerTool.length, 1);
  assert.equal(fake.calls.appendEntry.length, 1);
  assert.deepEqual(fake.calls.executeTool[0].slice(0, 2), ['probe_tool', { value: 'tool result' }]);
  await assert.rejects(fake.ctx.executeTool('missing', {}), /Unknown tool: missing/);
});

test('fake Pi can supply native tool behavior without replacing extension execution', async () => {
  const fake = createFakePi({
    executeTool: async (name, args) => ({ name, args }),
  });
  assert.deepEqual(await fake.ctx.executeTool('task', { subagent_type: 'oracle' }), {
    name: 'task', args: { subagent_type: 'oracle' },
  });
  assert.equal(fake.calls.executeTool.length, 1);
});
