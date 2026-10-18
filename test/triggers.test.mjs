import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson, classifyOutcome, createTriggerState, operationKey, reduceTriggers,
} from '../src/triggers.mjs';
import triggersProbe from '../qa/triggers-probe-extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

function driver(options = {}) {
  let state = createTriggerState({ active: true, ...options });
  const triggers = [];
  let sequence = 0;
  const send = event => {
    const reduced = reduceTriggers(state, event, { cwd: '/repo' });
    state = reduced.state;
    triggers.push(...reduced.triggers);
    return reduced.triggers;
  };
  const call = (input = { command: 'npm test' }, toolName = 'bash', extra = {}) => {
    const toolCallId = `call-${++sequence}`;
    const event = { type: 'tool_call', toolName, input, toolCallId, ...extra };
    send(event);
    return event;
  };
  const result = (callEvent, extra = {}) => send({
    ...callEvent, type: 'tool_result', isError: true,
    structuredContent: { exit_code: 1 }, ...extra,
  });
  return {
    send, call, result, triggers,
    fail(input, toolName, extra) { return result(call(input, toolName, extra)); },
    get state() { return state; },
  };
}

test('canonical operation JSON sorts recursively, preserving arrays, strings and cwd', () => {
  assert.equal(canonicalJson({ z: { b: 1, a: 2 }, a: [{ y: 3, x: 4 }, ' a \n'] }),
    '{"a":[{"x":4,"y":3}," a \\n"],"z":{"a":2,"b":1}}');
  assert.equal(canonicalJson({ 2: 2, 10: 10 }), '{"10":10,"2":2}');
  assert.equal(operationKey('bash', '/repo', { b: 2, a: 1 }),
    '{"args":{"a":1,"b":2},"effective_cwd":"/repo","logical_tool":"bash"}');
  assert.notEqual(operationKey('bash', '/repo', { args: ['a', 'b'] }),
    operationKey('bash', '/repo', { args: ['b', 'a'] }));
});

test('same command fails serially twice -> one trigger; third failure does not repeat', () => {
  const d = driver();
  d.fail();
  const first = d.state.predecessor.tool_call_id;
  const [trigger] = d.fail();
  assert.equal(trigger.kind, 'repeated_failure');
  assert.equal(trigger.error_class, 'exit:1');
  assert.deepEqual(trigger.tool_call_ids, [first, 'call-2']);
  assert.equal(trigger.count, 2);
  d.fail();
  assert.equal(d.triggers.length, 1);
});

test('concurrent duplicate failures do not count as a serial pair', () => {
  for (const reverse of [false, true]) {
    const d = driver();
    const a = d.call();
    const b = d.call();
    for (const event of reverse ? [b, a] : [a, b]) d.result(event);
    assert.equal(d.triggers.length, 0);
    d.fail();
    assert.equal(d.triggers.length, 1);
    assert.deepEqual(d.triggers[0].tool_call_ids, [b.toolCallId, 'call-3']);
  }
});

test('different flags, cwd, logical tool or class start a new chain', () => {
  for (const change of [
    { input: { command: 'npm test -- --watch' } },
    { input: { command: 'npm test', cwd: '/other' } },
    { tool: 'powershell' },
    { result: { structuredContent: { exit_code: 2 } } },
  ]) {
    const d = driver();
    d.fail();
    const second = d.call(change.input, change.tool);
    d.result(second, change.result);
    assert.equal(d.triggers.length, 0);
    d.result(d.call(change.input, change.tool), change.result);
    assert.equal(d.triggers.length, 1);
  }
});

test('success between failures resets the episode even with misleading output', () => {
  const d = driver();
  d.fail();
  d.result(d.call(), { isError: false, structuredContent: { exit_code: 0 },
    content: [{ type: 'text', text: 'tests failed; done; failure' }] });
  d.fail();
  assert.equal(d.triggers.length, 0);
  d.fail();
  assert.equal(d.triggers.length, 1);
});

test('read and edit between failures keep the chain', () => {
  const d = driver();
  d.fail();
  for (const tool of ['read', 'edit']) {
    d.result(d.call({ path: 'a' }, tool), { isError: false, structuredContent: undefined });
  }
  d.fail();
  assert.equal(d.triggers.length, 1);
});

test('a background result never arriving does not block a later serial pair', () => {
  const d = driver();
  d.call({ command: 'long running check', run_in_background: true });
  d.fail();
  d.fail();
  assert.equal(d.triggers.length, 1);
});

test('duplicate result notifications and duplicate admission are counted once', () => {
  const d = driver();
  const a = d.call();
  d.result(a);
  const revision = d.state.progress_revision;
  for (let n = 0; n < 5; n++) {
    d.send(a);
    d.result(a);
  }
  assert.equal(d.state.progress_revision, revision);
  assert.equal(d.triggers.length, 0);
  const b = d.call();
  for (let n = 0; n < 5; n++) d.result(b);
  assert.equal(d.state.progress_revision, revision + 1);
  assert.equal(d.triggers.length, 1);
});

test('only actual oracle_consult descendants are excluded, including grandchildren', () => {
  const d = driver();
  d.fail();
  const oracle = d.call({}, 'oracle_consult', { toolCallId: 'opaque-oracle-id' });
  d.fail(undefined, 'bash', { parentToolCallId: oracle.toolCallId });
  const wrapper = d.call({}, 'eval', { parentToolCallId: oracle.toolCallId });
  d.fail(undefined, 'bash', { parentToolCallId: wrapper.toolCallId });
  d.result(d.call({}, 'edit', { parentToolCallId: wrapper.toolCallId }), { isError: false });
  d.result(d.call({}, 'brief', { parentToolCallId: wrapper.toolCallId }), { isError: false });
  assert.equal(d.triggers.length, 0);
  assert.equal(d.state.progress_revision, 1);
  d.fail();
  assert.equal(d.triggers.length, 1);
});

test('D1: serial bash failures under separate non-oracle eval parents trigger once', () => {
  const d = driver();
  for (let n = 1; n <= 2; n++) {
    const outer = `eval-${n}`;
    d.send({ type: 'tool_call', toolName: 'eval', toolCallId: outer,
      input: { code: 'await tool.bash({command:"npm test"})' } });
    const call = { toolName: 'bash', toolCallId: `${outer}/1`,
      parentToolCallId: outer, input: { command: 'npm test' } };
    d.send({ type: 'tool_call', ...call });
    d.send({ type: 'tool_result', ...call, isError: true,
      structuredContent: { exit_code: 1 } });
    d.send({ type: 'tool_result', toolName: 'eval', toolCallId: outer,
      input: {}, isError: false });
  }
  assert.equal(d.triggers.length, 1);
  assert.deepEqual(d.triggers[0].tool_call_ids, ['eval-1/1', 'eval-2/1']);
  assert.equal(d.state.progress_revision, 2);
});

test('nested eligible wrappers count only their underlying verification operations', () => {
  const d = driver();
  for (let n = 1; n <= 2; n++) {
    const wrapper = d.call({}, 'project_check');
    const middle = d.call({}, 'eval', { parentToolCallId: wrapper.toolCallId });
    const inner = d.call(undefined, 'bash', { parentToolCallId: middle.toolCallId });
    d.result(inner);
    d.result(middle, { isError: false, structuredContent: undefined });
    d.result(wrapper, { isError: false, structuredContent: undefined });
  }
  assert.equal(d.triggers.length, 1);
  assert.equal(d.state.progress_revision, 2);
});

test('non-oracle nested edits and brief signals work even with oracle-shaped ids', () => {
  const d = driver();
  const wrapper = d.call({}, 'eval', { toolCallId: 'oracle_consult-looking-id' });
  d.result(d.call({}, 'edit', { parentToolCallId: wrapper.toolCallId }),
    { isError: false, structuredContent: undefined });
  const [signal] = d.result(d.call({}, 'brief', { parentToolCallId: wrapper.toolCallId }),
    { isError: false, structuredContent: undefined });
  assert.equal(d.state.progress_revision, 1);
  assert.equal(signal.kind, 'completion');
});

test('D2: QA observer preserves existing PTY bash and observes its tool_error channel', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-trigger-surface-test-'));
  const saved = Object.fromEntries(['ORACLE_QA_PROBE_LOG', 'ORACLE_QA_BASH_MODULE']
    .map(key => [key, process.env[key]]));
  const fake = createFakePi({ cwd: '/repo' });
  const records = [];
  fake.pi.rpc = { emit: (_name, record) => records.push(record) };
  const ptyBash = { name: 'bash', async execute() { return { content: [], isError: true }; } };
  fake.pi.registerTool(ptyBash);
  try {
    process.env.ORACLE_QA_PROBE_LOG = join(directory, 'probe.jsonl');
    // A stale test environment must not make an observer replace the real tool.
    process.env.ORACLE_QA_BASH_MODULE = 'data:text/javascript,' + encodeURIComponent(
      'export function createBashToolDefinition(){return {name:"bash",execute:async()=>({content:[],isError:true,structuredContent:{exit_code:1}})}}');
    await triggersProbe(fake.pi);
    assert.equal(fake.tools.get('bash'), ptyBash);
    for (let n = 1; n <= 2; n++) {
      const event = { toolName: 'bash', toolCallId: `pty-${n}`,
        input: { command: 'node -e "process.exit(1)"', description: 'same fixture', timeout: 30 } };
      await fake.emit('tool_call', { ...event, type: 'tool_call' });
      const result = await fake.ctx.executeTool('bash', event.input);
      await fake.emit('tool_result', { ...event, ...result, type: 'tool_result' });
    }
    const signals = records.filter(record => record.event === 'trigger');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].error_class, 'tool_error');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unmodified PTY isError success between failures resets the tool_error chain', () => {
  const d = driver();
  for (const isError of [true, false, true]) {
    d.result(d.call(), { isError, structuredContent: undefined });
  }
  assert.equal(d.triggers.length, 0);
  const [signal] = d.result(d.call(), { isError: true, structuredContent: undefined });
  assert.equal(signal.error_class, 'tool_error');
  assert.equal(d.triggers.length, 1);
});

test('eligible tools are bash, powershell and names ending test or check only', () => {
  for (const tool of ['bash', 'powershell', 'test', 'check', 'npm_test', 'typecheck']) {
    const d = driver();
    d.fail(undefined, tool);
    d.fail(undefined, tool);
    assert.equal(d.triggers.length, 1, tool);
  }
  for (const tool of ['read', 'edit', 'oracle_consult', 'test_runner', 'check_status']) {
    const d = driver();
    d.fail(undefined, tool);
    d.fail(undefined, tool);
    assert.equal(d.triggers.length, 0, tool);
  }
});

test('error class uses exit code, then timeout, then structured code, then isError', () => {
  const cases = [
    [{ structuredContent: { exit_code: 2, timed_out: true, error: { code: 'BAD' } } }, 'exit:2'],
    [{ structuredContent: { exit_code: 0, timed_out: true }, isError: true }, null],
    [{ structuredContent: { timed_out: true, error: { code: 'BAD' } } }, 'timeout'],
    [{ structuredContent: { timeout: true } }, 'timeout'],
    [{ structuredContent: { error: { code: 'E_PARSE' } } }, 'E_PARSE'],
    [{ structuredContent: { code: 'E_PARSE' } }, 'E_PARSE'],
    [{ structuredContent: undefined, isError: true }, 'tool_error'],
  ];
  for (const [event, errorClass] of cases) {
    assert.equal(classifyOutcome(event).error_class, errorClass);
  }
});

test('missing or odd structuredContent is safe and prose never supplies a failure class', () => {
  for (const structuredContent of [undefined, null, false, 'exit_code: 1', [1], 23,
    { exit_code: '1' }, { exit_code: {} }, { error: { code: {} } }]) {
    const d = driver();
    const outcome = { isError: false, structuredContent,
      content: [{ type: 'text', text: 'tests failed timeout exit 1' }] };
    d.result(d.call(), outcome);
    d.result(d.call(), outcome);
    assert.equal(d.triggers.length, 0);
    assert.doesNotThrow(() => classifyOutcome({ structuredContent }));
  }
});

test('cancel and unknown outcome reset a failure chain', () => {
  for (const reset of [
    { structuredContent: { cancelled: true } },
    { structuredContent: { status: 'cancelled' } },
    { structuredContent: undefined, isError: undefined },
  ]) {
    const d = driver();
    d.fail();
    d.result(d.call(), reset);
    d.fail();
    assert.equal(d.triggers.length, 0);
    d.fail();
    assert.equal(d.triggers.length, 1);
  }
});

test('canonical equivalent arguments form the same chain', () => {
  const d = driver();
  d.fail({ command: 'npm test', env: { Z: '2', A: '1' } });
  d.fail({ env: { A: '1', Z: '2' }, command: 'npm test' });
  assert.equal(d.triggers.length, 1);
});

test('scope change and Seed rebind reset; compaction and serialized reload keep the chain', () => {
  for (const type of ['scope_changed', 'seed_rebound', 'job_ended']) {
    const d = driver();
    d.fail();
    d.send({ type });
    if (type === 'job_ended') d.send({ type: 'job_started' });
    d.fail();
    assert.equal(d.triggers.length, 0, type);
  }
  const d = driver();
  d.fail();
  d.send({ type: 'compaction' });
  const snapshot = JSON.parse(JSON.stringify(d.state));
  const restored = driver({ snapshot });
  // Call ids are host ids and must remain unique across reload.
  const call = restored.call(undefined, 'bash', { toolCallId: 'after-reload' });
  restored.result(call);
  assert.equal(restored.triggers.length, 1);
});

test('scope reset invalidates in-flight operations and late results cannot resurrect a chain', () => {
  const d = driver();
  d.fail();
  const old = d.call();
  d.send({ type: 'seed_rebound' });
  d.result(old);
  d.fail();
  assert.equal(d.triggers.length, 0);
});

test('scope invalidation propagates to late nested descendants of an old main wrapper', () => {
  const d = driver();
  d.fail();
  const oldParent = d.call({}, 'eval');
  d.send({ type: 'seed_rebound' });
  const revision = d.state.progress_revision;
  d.result(d.call(undefined, 'bash', { parentToolCallId: oldParent.toolCallId }));
  assert.equal(d.state.progress_revision, revision);
  d.fail();
  assert.equal(d.triggers.length, 0);
});

test('finish_intent marks this revision and brief is a secondary completion signal', () => {
  const d = driver();
  const [finish] = d.send({ type: 'finish_intent' });
  assert.equal(finish.kind, 'completion');
  assert.equal(finish.source, 'finish_intent');
  assert.equal(d.state.finish_intent_revision, d.state.progress_revision);
  const brief = d.call({}, 'brief');
  const [signal] = d.result(brief, { isError: false, structuredContent: undefined });
  assert.equal(signal.source, 'brief');
  assert.equal(signal.progress_revision, d.state.progress_revision);
  d.send({ type: 'completion_covered', progress_revision: d.state.progress_revision });
  assert.equal(d.send({ type: 'finish_intent' }).length, 0);
  assert.equal(d.result(d.call({}, 'brief'), { isError: false }).length, 0);
  d.fail();
  assert.equal(d.send({ type: 'finish_intent' }).length, 1);
});

test('progress revision changes on edit, verification, Seed/scope and accepted disposition only', () => {
  const d = driver();
  assert.equal(d.state.progress_revision, 0);
  d.result(d.call({}, 'read'), { isError: false });
  assert.equal(d.state.progress_revision, 0);
  for (const tool of ['edit', 'write', 'apply_patch', 'lsp_rename']) {
    d.result(d.call({}, tool), { isError: false, structuredContent: undefined });
  }
  assert.equal(d.state.progress_revision, 4);
  d.fail();
  assert.equal(d.state.progress_revision, 5);
  for (const type of ['seed_rebound', 'scope_changed', 'disposition_accepted']) d.send({ type });
  assert.equal(d.state.progress_revision, 8);
  d.send({ type: 'disposition_rejected' });
  assert.equal(d.state.progress_revision, 8);
});

test('inactive and paused jobs produce no failure or completion triggers', () => {
  const d = driver({ active: false });
  d.fail();
  d.fail();
  d.send({ type: 'finish_intent' });
  d.result(d.call({}, 'brief'));
  assert.equal(d.triggers.length, 0);
  d.send({ type: 'job_started' });
  d.fail();
  d.send({ type: 'job_paused' });
  d.fail();
  d.send({ type: 'finish_intent' });
  assert.equal(d.triggers.length, 0);
});

test('reducer leaves its input and events untouched, and orphan results do not count', () => {
  const state = createTriggerState({ active: true });
  const original = structuredClone(state);
  const event = { type: 'tool_call', toolCallId: 'a', toolName: 'bash', input: { command: 'exit 1' } };
  const before = structuredClone(event);
  reduceTriggers(state, event, { cwd: '/repo' });
  assert.deepEqual(state, original);
  assert.deepEqual(event, before);
  const d = driver();
  const orphan = { ...event, type: 'tool_result', isError: true, structuredContent: { exit_code: 1 } };
  d.send(orphan);
  d.send(orphan);
  assert.equal(d.triggers.length, 0);
});
