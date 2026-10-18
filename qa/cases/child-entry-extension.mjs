import extension from '../../src/extension.mjs';

export default function childEntryProbe(pi) {
  const registrations = { hooks: [], commands: [], tools: [] };
  let runtime;
  const factory = {
    session_kind: pi.sessionKind,
    session_context: pi.sessionContext,
  };
  const emit = (event, ctx, details = {}) => pi.rpc.emit('oracle-qa.child-entry', {
    event, factory, registrations, ...details,
    actual_session_file: ctx.sessionManager.getSessionFile(),
    session_id: ctx.sessionManager.getSessionId(),
    session_status: runtime.getSessionStatus(),
    state: runtime.ledger.state,
    ledger_entries: ctx.sessionManager.getBranch().filter(entry =>
      entry.type === 'custom' && entry.customType === 'oracle-advisor'),
  });
  const observed = new Proxy(pi, {
    get(target, key) {
      if (key === 'on') return (name, ...args) => {
        registrations.hooks.push(name);
        return pi.on(name, ...args);
      };
      if (key === 'registerCommand') return (name, definition) => {
        registrations.commands.push(name);
        return pi.registerCommand(name, {
          ...definition,
          async handler(args, ctx) {
            const result = await definition.handler(args, ctx);
            emit('command', ctx, { args, result });
            return result;
          },
        });
      };
      if (key === 'registerTool') return definition => {
        registrations.tools.push(definition.name);
        return pi.registerTool(definition);
      };
      return Reflect.get(target, key);
    },
  });
  runtime = extension(observed);
  // This observer's hook is deliberately outside the product registration capture.
  pi.on('session_start', (_event, ctx) => {
    emit('session_start', ctx);
  });
}
