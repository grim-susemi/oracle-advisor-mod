import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { guardAuth, reserveRealOracleRuns } from './harness.mjs';

const CHANNEL = 'senpi:extension-rpc-event';
const terminal = status => !['pending', 'running'].includes(status);
const textOf = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const dataOf = result => result?.details ?? {};

export default function capabilityProbe(pi) {
  const owned = new Set();
  const snapshots = [];
  const listeners = new Set();
  const nested = [];
  const completions = [];
  const providerHooks = [];
  let active = false;
  let ctx;
  const emit = (event, data = {}) => {
    const value = { event, at: Date.now(), tool_executing: active, ...data };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(value) + '\n');
    pi.rpc.emit('oracle-qa.capability', value);
  };
  pi.events.on(CHANNEL, event => {
    if (event.name !== 'omo.task.updated') return;
    const entry = { at: Date.now(), tool_executing: active, ...event.data };
    for (const task of entry.tasks ?? []) owned.add(task.task_id);
    snapshots.push(entry);
    emit('snapshot', entry);
    for (const listener of listeners) listener(entry);
  });
  pi.on('tool_call', event => {
    if (event.parentToolCallId) { nested.push({ phase: 'call', ...event }); emit('nested_call', event); }
  });
  pi.on('tool_result', event => {
    if (event.parentToolCallId) {
      const entry = { phase: 'result', toolName: event.toolName, toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId, isError: event.isError, details: event.details };
      nested.push(entry); emit('nested_result', entry);
    }
  });
  pi.on('message_start', event => {
    if (event.message?.customType === 'senpi-task.completion') {
      const value = { at: Date.now(), tool_executing: active, message: event.message,
        chars: typeof event.message.content === 'string' ? event.message.content.length : JSON.stringify(event.message.content).length };
      completions.push(value); emit('completion', value);
    }
  });
  pi.on('before_provider_request', (event, context) => {
    const entry = { model: event.model?.id, provider: event.model?.provider,
      session_id: context.sessionManager.getSessionId(),
      tools: (event.payload?.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort() };
    providerHooks.push(entry);
    emit('provider_hook', entry);
  });
  function persistedCompletions(context) {
    return context.sessionManager.getBranch().filter(entry =>
      entry.type === 'custom_message' && (entry.customType === 'senpi-task.completion' ||
        (entry.customType === 'omo-senpi:wake' && Array.isArray(entry.details) &&
          entry.details.some(part => part.customType === 'senpi-task.completion')))).map(entry => ({
      ...entry, chars: typeof entry.content === 'string' ? entry.content.length : JSON.stringify(entry.content).length,
    }));
  }
  pi.on('session_start', (_event, context) => { ctx = context; emit('ready', { session_id: ctx.sessionManager.getSessionId() }); });
  pi.rpc.handle('oracle.probe.retire', async () => retire(ctx));
  pi.rpc.handle('oracle.probe.status', () => ({ snapshots, nested, completions, providerHooks, owned: [...owned],
    records: [...owned].map(readRecord), persisted_completions: persistedCompletions(ctx) }));

  function subscribe(predicate, label, timeoutMs = 12000) {
    let listener;
    let timer;
    const promise = new Promise((resolve, reject) => {
      listener = entry => { const value = predicate(entry); if (value) { clearTimeout(timer); listeners.delete(listener); resolve(value); } };
      listeners.add(listener);
      timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`harness_observation_deadline: ${label}; no matching snapshot within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    promise.catch(() => {});
    return { promise, close() { clearTimeout(timer); listeners.delete(listener); } };
  }
  const lastTask = id => snapshots.flatMap(entry => entry.tasks ?? []).findLast(task => task.task_id === id);
  const epoch = task => task?.notification?.run_epoch ?? task?.run_epoch;
  const answer = task => typeof task?.final_response === 'string' && task.final_response.length > 0;
  function readRecord(id) {
    const path = join(process.env.ORACLE_QA_TASK_STATE, 'tasks', `${id}.json`);
    return existsSync(path) ? { path, record: JSON.parse(readFileSync(path, 'utf8')) }
      : { path, error: `ENOENT: no task record at ${path}` };
  }
  async function call(context, name, args, signal) {
    if (process.env.ORACLE_QA_REAL_ORACLE === '1' && ['task', 'task_send'].includes(name)) {
      await guardAuth(process.env.ORACLE_QA_ATTEMPT_DIR, undefined, { before: true });
      reserveRealOracleRuns(process.env.ORACLE_QA_ATTEMPT_DIR);
    }
    const outcome = await context.executeTool(name, args, { signal, activateInactiveTool: true });
    const result = { ...outcome.result, isError: outcome.isError };
    emit('call_result', { name, args, outcome, result });
    return result;
  }
  async function spawn(context, prompt, signal, runInBackground = false) {
    const begin = Date.now();
    const result = await call(context, 'task', {
      subagent_type: 'oracle', description: 'owned capability probe', task_summary: 'Owned oracle capability measurement',
      prompt, run_in_background: runInBackground, isolated: false,
    }, signal);
    const details = dataOf(result);
    const id = details.task_id ?? details.id ?? textOf(result).match(/st_[a-zA-Z0-9_-]+/)?.[0];
    if (id) owned.add(id);
    emit('spawn', { id, result, latency_ms: Date.now() - begin });
    return { id, result, latency_ms: Date.now() - begin };
  }
  async function retire(context) {
    const result = [];
    for (const id of owned) {
      const cancelled = await pi.executeTool('task_cancel', { task_id: id, reason: 'Owned capability probe finished.' }, { activateInactiveTool: true });
      const output = await pi.executeTool('task_output', { task_id: id, mode: 'status' }, { activateInactiveTool: true });
      const task = lastTask(id);
      const entry = { id, cancelled, output, snapshot: task, durable: readRecord(id) };
      result.push(entry);
      emit('retired', entry);
    }
    return result;
  }
  pi.registerTool({
    name: 'probe_oracle', label: 'Oracle capability probe', description: 'Run the exact isolated oracle capability measurement.',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
    async execute(toolCallId, args, signal, _update, context) {
      active = true;
      emit('begin', { toolCallId, action: args.action, tools: context.tools.map(tool => ({ name: tool.name, parameters: tool.parameters })),
        evalHandleHost: !!context.evalHandleHost, cache_safe_wait_seconds: context.getPromptCacheSafeWaitSeconds?.() ?? null });
      const report = { action: args.action, outer_tool_call_id: toolCallId };
      try {
        if (args.action === 'transport') {
          const first = await spawn(context, 'Reply only QA_ANSWER_FIRST. Do not call tools.', signal);
          report.foreground = first;
          if (!first.id) throw new Error(`No task id returned: ${textOf(first.result)}`);
          report.revivals = [];
          for (let index = 1; index <= 5; index++) {
            const before = lastTask(first.id);
            const started = Date.now();
            const expected = ['QA_ANSWER_MAPLE7', 'QA_ANSWER_CRYSTAL2', 'QA_ANSWER_JUPITER9',
              'QA_ANSWER_VELVET6', 'QA_ANSWER_TUNDRA3'][index - 1];
            const wait = subscribe(entry => {
              const task = entry.tasks?.find(task => task.task_id === first.id);
              return task && answer(task) && task.final_response.includes(expected) ? { task, entry } : undefined;
            }, `revival ${index} answer independent of status`);
            let sent;
            let arrival;
            let error;
            try {
              sent = await call(context, 'task_send', { to: first.id, message: `Reply only ${expected}. Do not call tools.` }, signal);
              if (sent.isError || ['not_continuable', 'not_found', 'denied'].includes(dataOf(sent).kind)) {
                error = textOf(sent);
              } else {
                try { arrival = await wait.promise; } catch (failure) { error = failure.message; }
              }
            } finally { wait.close(); }
            const output = await call(context, 'task_output', { task_id: first.id, mode: 'status' }, signal);
            const current = lastTask(first.id);
            report.revivals.push({
              index, task_id: first.id, subscribed_before_send: true, previous_epoch: epoch(before),
              sent, answer_arrival: arrival, output, answered: !!arrival,
              send_accepted: !sent?.isError && dataOf(sent).kind === 'revived',
              status: current?.status ?? dataOf(output).snapshot?.status ?? null,
              durable: readRecord(first.id),
              run_epoch: readRecord(first.id).record?.notification?.run_epoch ?? dataOf(sent).run_epoch ?? epoch(current) ?? null,
              notified_epoch: readRecord(first.id).record?.notification?.notified_epoch ?? null,
              latency_ms: Date.now() - started, error: error ?? null,
            });
            emit('revival', report.revivals.at(-1));
          }
          report.mechanisms = [{ name: 'omo.task.updated',
            works: report.revivals.some(item => item.answered),
            independent_of_terminal: report.revivals.some(item => item.answered),
            snapshots_while_tool_executing: snapshots.some(entry => entry.tool_executing && entry.tasks?.length),
          }];
          if (!report.mechanisms[0].works && context.evalHandleHost) {
            try {
              const current = lastTask(first.id);
              const ref = { kind: 'agent', id: first.id, run_epoch: epoch(current) ?? 1 };
              const watch = await context.evalHandleHost.watch([ref], { ownerSessionId: context.sessionManager.getSessionId(), signal });
              report.mechanisms.push({ name: 'evalHandleHost', provided: true, initial: watch.initial, works: false,
                error: 'No successful revival snapshot answer; watch admission alone does not prove awaiting a revived answer.' });
              watch.close();
            } catch (error) { report.mechanisms.push({ name: 'evalHandleHost', provided: true, works: false, error: error.message }); }
          } else report.mechanisms.push({ name: 'evalHandleHost', provided: !!context.evalHandleHost, works: false,
            skipped: report.mechanisms[0].works ? 'Earlier mechanism worked; keep first.' : 'Capability absent.' });
          const schemas = context.tools.filter(tool => ['task_output', 'task_send'].includes(tool.name)).map(tool => ({ name: tool.name, parameters: tool.parameters }));
          report.mechanisms.push({ name: 'schema-wait-option', works: false, schemas,
            error: 'No wait/block/timeout_ms option in the observed installed schemas; no unsupported option was sent.' });
          report.mechanisms.push({ name: 'completion-notification', works: completions.some(item => item.tool_executing),
            independent_of_terminal: false, observations: completions,
            skipped: report.mechanisms[0].works ? 'Earlier mechanism worked; notification measured but not selected.' : null });
        } else if (args.action === 'notification') {
          const wait = subscribe(entry => entry.tasks?.find(task => answer(task) && task.final_response.includes('QA_ANSWER_NOTIFICATION')), 'background answer');
          try {
            report.spawn = await spawn(context, 'Reply only QA_ANSWER_NOTIFICATION.', signal, true);
            report.arrival = await wait.promise;
            report.persisted_while_executing = persistedCompletions(context);
          } finally { wait.close(); }
        } else if (args.action === 'image') {
          report.spawn = await spawn(context, `QA_IMAGE_READ ${process.env.ORACLE_QA_IMAGE}. Read this image using the read tool, then reply QA_ANSWER_IMAGE.`, signal);
        } else if (args.action === 'abort') {
          const wait = subscribe(entry => entry.tasks?.find(task => owned.has(task.task_id) && terminal(task.status)), 'abort child terminal');
          try {
            report.spawn = await spawn(context, 'QA_HOLD_ABORT. Reply only QA_ANSWER_ABORT.', signal);
            try { report.terminal = await wait.promise; } catch (error) { report.error = error.message; }
          } finally { wait.close(); }
        } else if (args.action === 'promote') {
          const wait = subscribe(entry => entry.tasks?.find(task => answer(task) && task.final_response.includes('QA_ANSWER_PROMOTE')), 'promoted answer');
          try {
            report.spawn = await spawn(context, 'QA_HOLD_PROMOTE. Reply only QA_ANSWER_PROMOTE.', signal);
            emit('foreground_returned', report.spawn);
            try { report.arrival = await wait.promise; } catch (error) { report.error = error.message; }
          } finally { wait.close(); }
        } else if (args.action === 'dead') {
          report.spawn = await spawn(context, 'Reply only QA_ANSWER_DEAD.', signal, true);
          if (!report.spawn.id) throw new Error('No owned dead target id.');
          report.cancelled = await call(context, 'task_cancel', { task_id: report.spawn.id, reason: 'Owned dead-target refusal measurement.' }, signal);
          report.send = await call(context, 'task_send', { to: report.spawn.id, message: 'Reply only QA_ANSWER_MUST_NOT_RUN.' }, signal);
          report.output = await call(context, 'task_output', { task_id: report.spawn.id, mode: 'status' }, signal);
        } else {
          report.spawn = await spawn(context, args.action === 'idle'
            ? 'QA_HOLD_IDLE. Reply only QA_ANSWER_IDLE.' : 'List your own actual available tools as JSON. Reply QA_ANSWER_SURFACE.', signal);
        }
      } catch (error) { report.error = { message: error.message, code: error.code ?? null }; }
      finally {
        report.snapshots = snapshots;
        report.nested = nested;
        report.completions = completions;
        emit('result', report);
        active = false;
      }
      return { content: [{ type: 'text', text: 'Capability observations written.' }], details: report };
    },
  });
}
