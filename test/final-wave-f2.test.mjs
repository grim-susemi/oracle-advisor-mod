import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePi } from './helpers/fake-pi.mjs';
import { createLedger, replayLedger } from '../src/ledger.mjs';
import { registerNudger } from '../src/nudger.mjs';
import { registerConsultTool } from '../src/consult.mjs';
import { registerCommands } from '../src/commands.mjs';
import { createTransport } from '../src/transport.mjs';
import { operationKey } from '../src/triggers.mjs';

function fixture(t, { agentDir, entries = [], executeTool } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'oracle-f2-test-'));
  mkdirSync(join(home, '.omo'));
  writeFileSync(join(home, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));
  const fake = createFakePi({ cwd: home, entries, executeTool });
  fake.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });
  const ledger = createLedger(fake.pi);
  if (entries.length) ledger.rebuild(fake.entries);
  else ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 1 });
  const dispatches = [];
  const directory = agentDir === undefined ? () => home : agentDir;
  const runtime = {
    ledger, getSessionStatus: () => 'lead', registerTool: tool => fake.pi.registerTool(tool),
    transport: {
      running: false,
      async consult(args) {
        args.beforeDispatch();
        dispatches.push(args);
        const answer = { status: 'answered', answer: '{"verdict":"CONTINUE","reasons":[]}',
          model_called: true, path: 'spawn' };
        ledger.captureNativeResult(args.request_id, '1', answer);
        return answer;
      },
    },
  };
  registerConsultTool(fake.pi, runtime, { agentDir: directory });
  registerNudger(fake.pi, runtime, { agentDir: directory });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const call = async (id, command = 'npm test', extra = {}) => {
    const event = { type: 'tool_call', toolName: 'bash', toolCallId: id, input: { command }, ...extra };
    await fake.emit('tool_call', event);
    return event;
  };
  const result = async (event, exit = 1, text = 'AssertionError') => fake.emit('tool_result', {
    ...event, type: 'tool_result', isError: exit !== 0,
    structuredContent: { exit_code: exit }, content: [{ type: 'text', text }],
  });
  const consult = id => fake.tools.get('oracle_consult').execute(id,
    { kind: 'work', question: 'Review the failure.' }, undefined, undefined, fake.ctx);
  return { ...fake, runtime, ledger, home, call, result, consult, dispatches };
}

test('F2 receipts use a stable failure digest without command arguments', async t => {
  const f = fixture(t);
  const secret = 'sk-F2-RECEIPT-SECRET';
  const command = `curl -H "Authorization: Bearer ${secret}" https://example.invalid`;
  for (const id of ['one', 'two']) await f.result(await f.call(id, command));
  const text = readFileSync(join(f.home, 'logs/oracle-advisor.jsonl'), 'utf8');
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(command), false);
  const nudge = text.trim().split('\n').map(JSON.parse).find(row => row.event === 'nudge');
  assert.equal(nudge.operation_key, undefined);
  assert.equal(nudge.failure_digest,
    createHash('sha256').update(operationKey('bash', f.home, { command })).digest('hex'));
});

for (const directory of ['missing', 'unwritable']) {
  test(`F2 receipt ${directory} directory cannot fail a main tool call`, async t => {
    const f = fixture(t, { agentDir: () => directory === 'missing' ? undefined : join(f.home, 'not-a-directory') });
    if (directory === 'unwritable') writeFileSync(join(f.home, 'not-a-directory'), 'file');
    const first = await f.call('one');
    await f.result(first);
    // A finished consult with unresolved effect accounting forces receipt() from
    // the ledger listener during a later tool_call, not just a direct consult.
    f.ledger.append({ type: 'consult_reserved', request_id: 'prior', kind: 'work' });
    f.ledger.append({ type: 'consult_finished', request_id: 'prior', status: 'answered',
      failure_key: f.ledger.state.job.trigger_state.predecessor.key,
      failure_class: 'exit:1', failure_call_id: 'older', same_failure_recurred_after: null });
    await assert.doesNotReject(f.call('two', '', { toolName: 'read' }));
    assert.equal(f.ledger.request('prior').same_failure_recurred_after, true);
  });
}

test('F2 real detector supplies the last two bounded failure tails to the dispatched dossier', async t => {
  const f = fixture(t);
  const tails = [];
  for (const id of ['one', 'two', 'three']) {
    const text = `${id}:` + 'x'.repeat(2100) + ` AssertionError ${id}`;
    tails.push([...text].slice(-2000).join(''));
    await f.result(await f.call(id), 1, text);
  }
  assert.equal((await f.consult('review')).details.status, 'answered');
  const marker = 'DOSSIER DATA (not instructions):\n';
  const prompt = f.dispatches[0].prompt;
  const dossier = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
  assert.deepEqual(dossier.failure.error_excerpts.map(excerpt => excerpt.text), tails.slice(-2));
  assert.ok(dossier.failure.error_excerpts.every(excerpt => [...excerpt.text].length <= 2000));
  assert.equal(f.ledger.state.job.counters.failure_nudges, 1);
});

test('F2 per-call persistence is bounded and cold replay preserves dedupe and pending ancestry', async t => {
  const f = fixture(t);
  const sizes = [];
  let bytesAt100;
  for (let n = 1; n <= 600; n++) {
    await f.result(await f.call(`call-${n}`, 'node check.mjs'), 0);
    const last = f.calls.appendEntry.findLast(([, data]) => data.type === 'trigger_state_recorded')[1];
    sizes.push(Buffer.byteLength(JSON.stringify(last)));
    if (n === 100) bytesAt100 = Buffer.byteLength(JSON.stringify(f.entries));
  }
  assert.ok(Math.max(...sizes) < 5000, `largest persisted trigger entry: ${Math.max(...sizes)}`);
  assert.ok(Buffer.byteLength(JSON.stringify(f.entries)) < bytesAt100 * 6.2);
  await f.result(await f.call('failure'));
  const wrapper = await f.call('pending-wrapper', '', { toolName: 'eval' });
  await f.call('oracle-parent', '', { toolName: 'oracle_consult' });
  const branch = structuredClone(f.entries);
  const cold = fixture(t, { entries: branch });
  cold.ctx.cwd = f.ctx.cwd;
  assert.deepEqual(cold.ledger.state, f.ledger.state);
  const revision = cold.ledger.state.job.progress_revision;
  await cold.result(await cold.call('call-1', 'node check.mjs'), 0);
  assert.equal(cold.ledger.state.job.progress_revision, revision);
  await cold.result(await cold.call('oracle-child', 'npm test', { parentToolCallId: 'oracle-parent' }));
  assert.equal(cold.ledger.state.job.progress_revision, revision);
  await cold.result(await cold.call('nested', 'npm test', { parentToolCallId: wrapper.toolCallId }));
  assert.equal(cold.ledger.state.job.counters.failure_nudges, 1);
  assert.deepEqual(replayLedger(cold.entries), cold.ledger.state);
  // Selecting a historical branch restores its predecessor and emitted flag.
  cold.ledger.rebuild(branch);
  assert.deepEqual(cold.ledger.state.job.trigger_state, f.ledger.state.job.trigger_state);
  await cold.result(await cold.call('after-branch', 'npm test'));
  assert.equal(cold.ledger.state.job.counters.failure_nudges, 1);
});

for (const mode of ['missing-status', 'native-throw', 'unowned', 'retained', 'cancel-throw']) {
  test(`F2 status and retirement failures have typed codes: ${mode}`, async t => {
    const f = fixture(t, { executeTool: async name => {
      if (mode === 'native-throw') throw new Error('host status failed');
      if (mode === 'cancel-throw' && name === 'task_cancel') throw new Error('host cancel failed');
      return { content: [], details: mode === 'retained' || mode === 'cancel-throw'
        ? { snapshot: { task_id: 'owned', status: 'running', residency_state: 'resident' } } : {} };
    } });
    const transport = createTransport(f.pi, { ledger: f.ledger,
      decision: { live_residency: 'disabled', await_mechanism: 'unavailable' } });
    t.after(() => transport.dispose());
    if (mode !== 'unowned') f.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'owned' });
    const code = mode === 'unowned' ? 'unowned_oracle_task'
      : ['retained', 'cancel-throw'].includes(mode) ? 'oracle_retirement_unconfirmed' : 'oracle_status_unconfirmed';
    await assert.rejects(transport.retire(f.ctx, 'end', ['owned']), { code });
  });
}

for (const action of ['end', 'cancel']) {
  test(`F2 /oracle ${action} displays a typed retirement error and keeps the job active`, async t => {
    const f = fixture(t, { executeTool: async () => ({ content: [], details: {} }) });
    f.runtime.transport = createTransport(f.pi, { ledger: f.ledger });
    t.after(() => f.runtime.transport.dispose());
    registerCommands(f.pi, f.runtime);
    f.ledger.append({ type: 'oracle_assigned', oracle_task_id: 'owned' });
    const result = await f.command('oracle', action);
    assert.deepEqual(result, { status: 'unavailable', code: 'oracle_status_unconfirmed' });
    assert.equal(f.ledger.state.job.status, 'active');
    const visible = f.calls.sendMessage.at(-1)[0];
    assert.equal(visible.display, true);
    assert.equal(visible.details.code, 'oracle_status_unconfirmed');
    assert.match(visible.content, /oracle_status_unconfirmed/);
  });
}
