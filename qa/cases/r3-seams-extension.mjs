import extension from '../../src/extension.mjs';

// Test-only wrapper. Records appendEntry calls, commands, tool execution and native
// tool calls as extension_event rows. qa-only input verbs (/qa-driver, /qa-stop) are
// handled here and never reach the model; they drive a driver switch and a STOP fixture.
export default function r3SeamsExtension(pi) {
  const emit = (event, data = {}) => pi.rpc.emit('oracle-qa.r3-seams', { event, ...data, at: Date.now() });
  let runtime;
  const wrapped = new Proxy(pi, {
    get(target, key) {
      if (key === 'appendEntry') {
        return (type, data) => {
          emit('append', { type, data });
          return target.appendEntry(type, data);
        };
      }
      if (key === 'registerCommand') {
        return (name, definition) => target.registerCommand(name, {
          ...definition,
          async handler(args, ctx) {
            const result = await definition.handler(args, ctx);
            emit('command', { name, args, result });
            return result;
          },
        });
      }
      if (key === 'registerTool') {
        return definition => target.registerTool({
          ...definition,
          async execute(id, input, signal, update, ctx) {
            emit('tool_executing', { name: definition.name, input });
            return definition.execute(id, input, signal, update, {
              ...ctx,
              async executeTool(name, args, options) {
                emit('native_tool_call', { name, args });
                return ctx.executeTool(name, args, options);
              },
            });
          },
        });
      }
      if (key === 'sendMessage') {
        return (message, options) => {
          emit('message', { customType: message?.customType ?? null, content: message?.content ?? null, details: message?.details ?? null });
          return target.sendMessage(message, options);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  pi.on('session_start', () => {
    const driver = process.env.ORACLE_QA_R3_DRIVER || '';
    if (driver) pi.appendEntry('primary-agent/v1', { schemaVersion: 1, agentId: driver });
    emit('ready', { driver: driver || null });
  });

  pi.on('input', event => {
    const text = event?.text ?? '';
    emit('input_seen', { source: event?.source ?? null, text });
    const driver = /^\/qa-driver (\w+)$/.exec(text);
    const stop = text === '/qa-stop';
    if (!driver && !stop) return undefined;
    try {
      if (driver) pi.appendEntry('primary-agent/v1', { schemaVersion: 1, agentId: driver[1] });
      if (stop) {
        runtime.ledger.append({ type: 'stop_opened', job_id: runtime.ledger.state.job?.job_id, stop_id: 'S1', reasons: [{ text: 'Hold.' }] });
      }
      emit('qa_done', { input: text });
    } catch (err) {
      emit('qa_done', { input: text, error: err.message });
    }
    return { action: 'handled' };
  });

  runtime = extension(wrapped);
}
