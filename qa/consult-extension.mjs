import { appendFileSync } from 'node:fs';
import extension from '../src/extension.mjs';
import { guardAuth, reserveRealOracleRuns } from './harness.mjs';
import { observeScenario } from './scenario-observer.mjs';

export default function consultQA(pi) {
  const nativeCalls = [];
  const emit = (event, data = {}) => {
    const entry = { event, ...data };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(entry) + '\n');
    pi.rpc.emit('oracle-qa.consult', entry);
  };
  let runtime;
  const scenario = observeScenario(pi, emit, { getRuntime: () => runtime });
  runtime = extension(new Proxy(scenario, {
    get(target, key) {
      if (key === 'registerCommand') return (name, definition) => scenario.registerCommand(name, {
        ...definition,
        async handler(args, ctx) {
          const result = await definition.handler(args, ctx);
          emit('command', { args, result, state: runtime.ledger.state });
          return result;
        },
      });
      if (key === 'registerTool') return definition => pi.registerTool({
        ...definition,
        async execute(callId, args, signal, update, ctx) {
          const wrapped = {
            ...ctx,
            async executeTool(name, input, options) {
                nativeCalls.push({ name, parent: callId, input });
                if (name === 'task' && process.env.ORACLE_QA_REAL_ORACLE === '1') {
                  await guardAuth(process.env.ORACLE_QA_ATTEMPT_DIR, undefined,
                    { before: true, providers: ['ollama'] });
                  reserveRealOracleRuns(process.env.ORACLE_QA_ATTEMPT_DIR);
                }
                return ctx.executeTool(name, input, options);
            },
          };
          const result = await definition.execute(callId, args, signal, update, wrapped);
          if (definition.name === 'oracle_consult') emit('consult_result', {
            call_id: callId, result, state: runtime.ledger.state, native_calls: nativeCalls,
          });
          return result;
        },
      });
      return Reflect.get(target, key);
    },
  }));
  if (!runtime) return;
  const consult = runtime.transport.consult.bind(runtime.transport);
  runtime.transport.consult = async args => {
    try { return await consult(args); }
    catch (error) {
      emit('transport_error', { code: error.code ?? null, message: error.message, stack: error.stack });
      throw error;
    }
  };
  pi.on('session_start', () => emit('ready', { state: runtime.ledger.state }));
  pi.rpc.handle('oracle.consult.status', () => ({
    state: runtime.ledger.state, native_calls: nativeCalls, running: runtime.transport.running,
  }));
}
