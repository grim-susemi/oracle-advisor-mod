import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createFakePi } from './fake-pi.mjs';
import { createLedger } from '../../src/ledger.mjs';
import { registerConsultTool } from '../../src/consult.mjs';
import { registerStopGate } from '../../src/stop-gate.mjs';
import { registerNudger } from '../../src/nudger.mjs';
import { createTransport } from '../../src/transport.mjs';

export function callCostFixture(entries = [], originalCwd) {
  const home = mkdtempSync(join(tmpdir(), 'oracle-call-cost-'));
  const cwd = originalCwd ?? join(home, 'work');
  mkdirSync(join(cwd, '.omo'), { recursive: true });
  writeFileSync(join(cwd, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));
  const records = new Map();
  const fake = createFakePi({ entries, cwd, executeTool: async (name, args) => {
    if (name === 'task') {
      const task = { task_id: `cost-oracle-${records.size + 1}`, status: 'completed',
        residency_state: 'persisted_only', run_epoch: 0,
        final_response: '{"verdict":"CONTINUE","reasons":[]}' };
      records.set(task.task_id, task);
      return { details: task, content: [{ type: 'text', text: task.final_response }] };
    }
    if (name === 'task_output') return { details: { kind: 'status', snapshot: records.get(args.task_id) } };
    throw new Error(`Unexpected native call: ${name}`);
  } });
  fake.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });
  const ledger = createLedger(fake.pi);
  if (entries.length) ledger.rebuild(fake.entries);
  else ledger.append({ type: 'job_opened', job_id: 'J1', job_epoch: 1 });
  const runtime = { ledger, getSessionStatus: () => 'lead',
    registerTool: tool => fake.pi.registerTool(tool), transport: { running: false } };
  fake.pi.events = new EventEmitter();
  const transport = createTransport(fake.pi, { ledger });
  runtime.transport = transport;
  registerConsultTool(fake.pi, runtime, { agentDir: () => home });
  registerStopGate(fake.pi, runtime);
  registerNudger(fake.pi, runtime, { agentDir: () => home });
  const call = (id, toolName, input, parentToolCallId) => fake.emit('tool_call', {
    type: 'tool_call', toolCallId: id, toolName, input, parentToolCallId,
  });
  const result = (id, toolName, structuredContent) => fake.emit('tool_result', {
    type: 'tool_result', toolCallId: id, toolName, structuredContent,
    content: [{ type: 'text', text: `bounded failure output for ${id}` }],
  });
  async function consult(id, kind = 'work') {
    return fake.tools.get('oracle_consult').execute(id,
      { kind, question: 'Review this owned fixture.' }, undefined, undefined, fake.ctx);
  }
  const progressEvents = new Map();
  function progress(tasks) {
    if (!progressEvents.has(tasks)) progressEvents.set(tasks, {
      name: 'omo.task.updated', data: { parent_session_id: 'fake-session',
        tasks: Array.from({ length: tasks }, (_, i) => ({
          task_id: `unowned-${i}`, status: 'running', live_progress: { tokens: 0 },
        })) },
    });
    const event = progressEvents.get(tasks);
    event.data.tasks[0].live_progress.tokens++;
    fake.pi.events.emit('senpi:extension-rpc-event', event);
  }
  async function step(i) {
    const id = `cost-${i}`;
    const slot = i % 20;
    const toolName = slot === 1 ? 'eval' : slot === 3 ? 'oracle_consult' :
      slot === 5 ? 'edit' : slot === 6 ? 'read' : slot === 7 ? 'powershell' : 'bash';
    const parent = slot === 2 || slot === 4 ? `cost-${i - 1}` : undefined;
    const input = toolName === 'oracle_consult'
      ? { kind: i === 63 ? 'completion' : 'work', question: 'Review this owned fixture.' } :
      ['bash', 'powershell'].includes(toolName) ? { command: 'owned-check --fixture' } : { path: 'fixture.mjs' };
    await call(id, toolName, input, parent);
    if (slot === 3) {
      const answer = await consult(id, i === 63 ? 'completion' : 'work');
      await result(id, toolName, answer.structuredContent);
    }
    if (![1, 3].includes(slot)) {
      const outcome = slot === 8 ? { timed_out: true } : { exit_code: [0, 5, 6].includes(slot) ? 0 : 1 };
      await result(id, toolName, outcome);
      if (slot === 2) await result(parent, 'eval', outcome);
      if (slot === 4) await result(parent, 'oracle_consult', { exit_code: 0 });
    }
    if (i % 37 === 0) {
      await call('cost-1', 'eval', {});
      await result('cost-1', 'eval', { exit_code: 1 });
    }
    if (i % 10 === 0) await fake.emit('turn_end', { type: 'turn_end' });
    if (i % 200 === 0) {
      ledger.append({ type: 'job_paused', job_id: 'J1' }, { snapshot: false });
      ledger.append({ type: 'job_resumed', job_id: 'J1' }, { snapshot: false });
    }
  }
  return { ...fake, ledger, runtime, home, step, call, result, consult, progress,
    close: () => { transport.dispose(); rmSync(home, { recursive: true, force: true }); } };
}

export async function measureCalls(fixture, start, count = 100) {
  const before = performance.now();
  for (let i = start; i < start + count; i++) await fixture.step(i);
  return (performance.now() - before) / count;
}

export function measureProgress(fixture, tasks, samples = 100) {
  const before = performance.now();
  let count = 0, elapsed;
  do {
    for (let i = 0; i < 100; i++) fixture.progress(tasks);
    count += 100;
    elapsed = performance.now() - before;
  } while (count < samples || elapsed < 20);
  return elapsed / count;
}

export function eventCostBenchmark(fixture, samples = 1000) {
  const inactive = callCostFixture(fixture.entries, fixture.ctx.cwd);
  try {
    inactive.ledger.append({ type: 'job_ended', job_id: 'J1' }, { snapshot: false });
    const costs = {};
    for (const [state, f] of [['active', fixture], ['ended', inactive]]) {
      for (const tasks of [10, 50]) {
        // Warm the emitter independently of the measured batch.
        for (let i = 0; i < Math.min(samples, 100); i++) f.progress(tasks);
        costs[`${state}-${tasks}`] = measureProgress(f, tasks, samples);
      }
    }
    return costs;
  } finally { inactive.close(); }
}

export async function mixedCallBenchmark(fixture, count = 5000, checkpoint = () => {}) {
  const times = [];
  const event_costs_ms = {};
  const earlyEvents = [];
  for (let i = 1; i <= count; i++) {
    const start = performance.now();
    await fixture.step(i);
    times.push(performance.now() - start);
    if (i >= 101 && i <= 200) earlyEvents.push(eventCostBenchmark(fixture, 10));
    if (i === 200) event_costs_ms[200] = Object.fromEntries(Object.keys(earlyEvents[0])
      .map(key => [key, earlyEvents.reduce((sum, sample) => sum + sample[key], 0) / earlyEvents.length]));
    if (i === 5000) event_costs_ms[5000] = eventCostBenchmark(fixture);
    if (i === 600 || i === 5000) await checkpoint(i);
  }
  const mean = (start, end) => times.slice(start - 1, end).reduce((sum, value) => sum + value, 0) / (end - start + 1);
  return { calls: count, means_ms: Object.fromEntries([[1, 100], [101, 200], [501, 600], [4901, 5000]]
    .filter(([, end]) => end <= count).map(([start, end]) => [`${start}-${end}`, mean(start, end)])),
    event_costs_ms,
    event_baseline_window: [101, 200],
    event_minimum_window_ms: 20,
    executed_consults: Object.keys(fixture.ledger.state.requests).length,
    native_dispatches: fixture.calls.executeTool.filter(([name]) => name === 'task').length,
    refusal_statuses: Object.values(fixture.ledger.state.requests).reduce((counts, record) => {
      counts[record.status] = (counts[record.status] ?? 0) + 1;
      return counts;
    }, {}),
    total_ms: times.reduce((sum, value) => sum + value, 0) };
}
