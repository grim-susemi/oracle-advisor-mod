import { appendFileSync } from 'node:fs';
import extension from '../src/extension.mjs';
import { guardAuth, reserveRealOracleRuns } from './harness.mjs';
import { observeScenario } from './scenario-observer.mjs';
import { fixtureSetupError, fixtureShellCommand, validateShellFixture } from './fixture-executable.mjs';

// Observe product patches at their API boundary; never manufacture a trigger,
// tool result, verdict, or oracle dispatch.
export default function nudgerQA(pi) {
  const nativeCalls = [];
  const operations = new Map();
  let completedOperation;
  let runtime, validation;
  const emit = (event, data = {}) => {
    const record = { event, ...data };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(record) + '\n');
    pi.rpc.emit('oracle-qa.nudger', record);
  };
  pi = observeScenario(pi, emit, { getRuntime: () => runtime });
  runtime = extension(new Proxy(pi, {
    get(target, key) {
      if (key === 'on') return (name, handler) => pi.on(name, async (event, ctx) => {
        const result = await handler(event, ctx);
        if (name === 'tool_result' && result?.content) emit('result_patch', {
          tool_name: event.toolName, call_id: event.toolCallId, patch: result,
          original_content: event.content,
          structured_preserved: result.structuredContent === event.structuredContent,
          details_preserved: result.details === event.details,
          state: runtime.ledger.state,
        });
        return result;
      });
      if (key === 'registerCommand') return (name, definition) => pi.registerCommand(name, {
        ...definition,
        async handler(args, ctx) {
          const result = await definition.handler(args, ctx);
          emit('command', { args, result, state: runtime.ledger.state });
          return result;
        },
      });
      if (key === 'registerTool') return definition => pi.registerTool({
        ...definition,
        async execute(id, args, signal, update, ctx) {
          const result = await definition.execute(id, args, signal, update, {
            ...ctx,
            async executeTool(name, input, options) {
              if (name === 'task' && process.env.ORACLE_QA_REAL_ORACLE === '1') {
                await guardAuth(process.env.ORACLE_QA_ATTEMPT_DIR, undefined, { before: true, providers: ['ollama'] });
                reserveRealOracleRuns(process.env.ORACLE_QA_ATTEMPT_DIR);
              }
              nativeCalls.push({ name, parent: id });
              emit('native_call', { name, parent: id });
              return ctx.executeTool(name, input, options);
            },
          });
          emit('tool_result', { tool_name: definition.name, call_id: id, result, state: runtime.ledger.state });
          return result;
        },
      });
      return Reflect.get(target, key);
    },
  }));
  if (!runtime) return;
  pi.on('session_start', () => emit('ready'));
  pi.on('tool_call', event => {
    if (event.toolName === 'bash') operations.set(event.toolCallId, {
      input: event.input, predecessor_call_id: completedOperation,
    });
    if (validation && event.toolName === 'bash' && event.input.command === validation.command) {
      validation.call_id = event.toolCallId;
    }
  });
  pi.on('tool_result', event => {
    if (event.toolName === 'bash') {
      emit('operation_result', {
        tool_name: event.toolName, call_id: event.toolCallId, ...operations.get(event.toolCallId),
        is_error: event.isError, structured_content: event.structuredContent ?? null,
      });
      completedOperation = event.toolCallId;
      if (validation?.call_id === event.toolCallId) Object.assign(validation, {
        input: operations.get(event.toolCallId)?.input,
        is_error: event.isError, structured_content: event.structuredContent ?? null,
        content: event.content, details: event.details,
      });
    }
  });
  pi.on('before_provider_request', event => emit('provider_request', {
    provider: event.model?.provider, model: event.model?.id,
  }));
  pi.rpc.handle('oracle.nudger.status', () => ({
    state: runtime.ledger.state, native_calls: nativeCalls, running: runtime.transport.running,
  }));
  pi.rpc.handle('oracle.nudger.validate', async ({ executable }) => {
    if (runtime.ledger.state.job || validation) {
      throw fixtureSetupError('executable_validation', executable, 'validation_requires_idle_fixture');
    }
    validation = { command: fixtureShellCommand(executable, ['--version']) };
    try {
      await pi.executeTool('bash', {
        command: validation.command, description: 'Validate owned nudge fixture Node executable',
        timeout: 30, run_in_background: false,
      }, { activateInactiveTool: true });
      const evidence = validateShellFixture(executable, validation);
      emit(evidence.event, evidence);
      return evidence;
    } finally { validation = undefined; }
  });
}
