export function createFakePi(options = {}) {
  const calls = Object.fromEntries([
    'on', 'registerTool', 'registerCommand', 'appendEntry', 'executeTool', 'sendMessage',
  ].map(name => [name, []]));
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = structuredClone(options.entries ?? []);
  const ctx = {
    cwd: options.cwd ?? process.cwd(),
    hasUI: false,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => options.sessionFile ?? 'owned/session.jsonl',
      getSessionId: () => options.sessionId ?? 'fake-session',
    },
    ui: { notify() {} },
    async executeTool(name, args, ...rest) {
      calls.executeTool.push([name, args, ...rest]);
      if (options.executeTool) return options.executeTool(name, args, ...rest);
      const definition = tools.get(name);
      if (!definition) throw new Error(`Unknown tool: ${name}`);
      return definition.execute(`fake-${calls.executeTool.length}`, args, rest[0], undefined, ctx);
    },
  };
  const pi = {
    sessionKind: options.sessionKind ?? 'interactive',
    on(name, handler) {
      calls.on.push([name, handler]);
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerTool(definition) {
      calls.registerTool.push(definition);
      tools.set(definition.name, definition);
    },
    registerCommand(name, definition) {
      calls.registerCommand.push([name, definition]);
      commands.set(name, definition);
    },
    appendEntry(customType, data) {
      calls.appendEntry.push([customType, data]);
      entries.push({ type: 'custom', id: `entry-${entries.length + 1}`, customType, data });
    },
    sendMessage(...args) { calls.sendMessage.push(args); },
    executeTool: ctx.executeTool,
  };
  return {
    pi, ctx, calls, handlers, tools, commands, entries,
    async emit(name, event = {}) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    async command(name, args = '') {
      const definition = commands.get(name);
      if (!definition) throw new Error(`Unknown command: ${name}`);
      return definition.handler(args, ctx);
    },
    async replay(events) {
      const results = [];
      for (const { name, event } of events) results.push(await this.emit(name, event));
      return results;
    },
  };
}
