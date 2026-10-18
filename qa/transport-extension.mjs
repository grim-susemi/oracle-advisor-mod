import { appendFileSync } from 'node:fs';
import extension from '../src/extension.mjs';
import { nativeResult } from '../src/transport.mjs';
import { guardAuth, reserveRealOracleRuns } from './harness.mjs';
import { observeScenario } from './scenario-observer.mjs';

export default function transportQA(pi) {
  let ctx;
  let sequence = 0;
  const results = [];
  const nativeCalls = [];
  const dispatches = new Map();
  const emit = (event, data = {}) => {
    const entry = { event, ...data };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(entry) + '\n');
    pi.rpc.emit('oracle-qa.transport', entry);
  };
  let runtime;
  const scenario = observeScenario(pi, emit, { getRuntime: () => runtime });
  const observed = new Proxy(scenario, {
    get(target, key) {
      if (key === 'sendMessage') return (message, options) => {
        emit('visible', { message });
        return pi.sendMessage(message, options);
      };
      if (key !== 'registerCommand') return Reflect.get(target, key);
      return (name, definition) => scenario.registerCommand(name, {
        ...definition,
        async handler(args, context) {
          const result = await definition.handler(args, context);
          emit('command', { args, result, state: runtime.ledger.state });
          return result;
        },
      });
    },
  });
  runtime = extension(observed);
  if (!runtime) return;
  pi.on('tool_call', event => {
    if (event.toolName === 'task' && event.input?.subagent_type === 'oracle') {
      dispatches.set(event.toolCallId, { call_id: event.toolCallId,
        request_id: event.parentToolCallId, prompt: event.input.prompt });
    }
  });
  let observation;
  const consult = runtime.transport.consult;
  runtime.transport.consult = async options => {
    const current = observation;
    const result = await consult(options);
    const record = { request_id: options.request_id, ...current, ...result };
    results.push(record);
    emit('consult_result', record);
    return result;
  };
  pi.on('session_start', (_event, context) => {
    ctx = context;
    emit('ready', { decision: runtime.transport.decision, state: runtime.ledger.state });
  });
  pi.on('tool_result', event => {
    if (['task', 'task_send', 'task_cancel', 'task_output'].includes(event.toolName)) {
      const record = { name: event.toolName, call_id: event.toolCallId, parent: event.parentToolCallId, details: event.details,
        isError: event.isError };
      nativeCalls.push(record);
      if (event.toolName === 'task') emit('native_task_returned', record);
    }
  });
  pi.on('session_shutdown', () => emit('shutdown_complete', { state: runtime.ledger.state, running: runtime.transport.running }));
  pi.rpc.handle('oracle.transport.status', () => ({
    state: runtime.ledger.state, results, nativeCalls, running: runtime.transport.running,
  }));
  pi.rpc.handle('oracle.transport.provider_hold', provider => {
    const text = provider.text.startsWith('[')
      ? JSON.parse(provider.text).map(part => part.text ?? '').join('\n') : provider.text;
    const taskId = text.match(/(?:^|\n)Task id: ([^\s.]+)\./)?.[1];
    const running = runtime.transport.running;
    const requests = Object.values(runtime.ledger.state.requests).filter(request =>
      running?.oracle_task_id === taskId && running.request_id === request.request_id);
    const dispatch = [...dispatches.values()].filter(call =>
      requests.length === 1 && call.request_id === requests[0].request_id &&
      text.includes(call.prompt));
    if (provider.model !== 'oracle' || !provider.provider_request_id || !Number.isFinite(provider.held_at) ||
        dispatch.length !== 1 || !taskId) throw Object.assign(new Error('Uncorrelated raw provider hold'),
      { code: 'scenario_not_reached' });
    const request = requests[0];
    const hold = { source: 'qa.transport-provider', provider_request_id: provider.provider_request_id,
      request_id: request.request_id, call_id: dispatch[0].call_id, task_id: taskId,
      job_id: request.job_id, job_epoch: request.job_epoch };
    emit('provider_hold', hold);
    return hold;
  });
  pi.rpc.handle('oracle.transport.dead', async () => {
    const ids = runtime.ledger.state.job.oracle_task_ids;
    const id = ids.at(-1);
    const [result] = await runtime.transport.retire(ctx, 'qa_dead_target', [id]);
    emit('dead', { oracle_task_id: id, result });
    return { oracle_task_id: id, result };
  });
  pi.rpc.handle('oracle.transport.shutdown', () => {
    ctx.shutdown();
    return { shutdown_requested: true };
  });
  runtime.registerTool({
    name: 'qa_transport_run', label: 'Transport QA',
    description: 'Run one owned native oracle transport observation with a complete dossier.',
    parameters: { type: 'object', properties: {
      marker: { type: 'string' }, mode: { type: 'string', enum: ['normal', 'hold'] },
    }, required: ['marker', 'mode'], additionalProperties: false },
    async execute(toolCallId, args, signal, _update, context) {
      const job = runtime.ledger.state.job;
      const kind = ++sequence <= 3 ? 'work' : 'completion';
      const dossier_prior_ids = Object.values(job.consults).filter(item => item.verdict).map(item => item.request_id);
      if (process.env.ORACLE_QA_REAL_ORACLE === '1') {
        await guardAuth(process.env.ORACLE_QA_ATTEMPT_DIR, undefined, { before: true });
        reserveRealOracleRuns(process.env.ORACLE_QA_ATTEMPT_DIR);
      }
      observation = { toolCallId, dossier_prior_ids };
      emit('consult_admitted', observation);
      // Use the product entry point for admission, dossier and accounting.
      // The transport observer publishes cleanup even if Escape ends this wait.
      const outcome = await context.executeTool('oracle_consult', {
        kind, question: args.mode === 'hold' ? 'QA_TRANSPORT_HOLD' : 'Review this owned QA observation.',
      }, { signal, activateInactiveTool: true });
      return nativeResult(outcome);
    },
  });
}
