import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { guardAuth, reserveRealOracleRuns } from '../harness.mjs';
import { observeScenario } from '../scenario-observer.mjs';
import { fixtureSetupError, fixtureShellCommand, validateShellFixture } from '../fixture-executable.mjs';

export default async function acceptanceQA(pi) {
  if (pi.sessionKind !== 'interactive') return;
  const nativeCalls = [];
  let validation;
  const brokerCalls = [];
  const emit = (event, data = {}) => {
    const record = { event, ...data };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(record) + '\n');
    pi.rpc.emit('oracle-qa.acceptance', record);
  };
  pi = observeScenario(pi, emit);
  const brokerPresent = process.env.ORACLE_QA_COORDINATION === '1';
  const brokerKey = Symbol.for('omo.agent-coordination.api.v1');
  const previousBroker = globalThis[brokerKey];
  const roster = [{ id: 'owned-fixture-peer', name: 'owned QA peer', status: 'live' }];
  if (brokerPresent) {
    const record = method => {
      const entry = { method, source: 'fake-coordination-broker-own-receipt' };
      brokerCalls.push(entry);
      appendFileSync(process.env.ORACLE_QA_COORDINATION_LOG, JSON.stringify(entry) + '\n');
    };
    globalThis[brokerKey] = {
      version: 1,
      getClient() {
        return {
          peers() { record('peers'); return roster; },
          onPeersChanged() { record('onPeersChanged'); return () => record('unsubscribe'); },
          ask() { record('ask'); throw new Error('Unexpected advisor ask'); },
          notify() { record('notify'); throw new Error('Unexpected advisor notify'); },
        };
      },
    };
  }
  // Import the installer-created shim, never the product source tree. The
  // proxy observes only API boundaries, exactly as the earlier owned QA cases.
  const installed = process.env.ORACLE_QA_INSTALLED_ENTRY;
  const factory = (await import(pathToFileURL(installed).href)).default;
  const runtime = factory(new Proxy(pi, {
    get(target, key) {
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
              nativeCalls.push({ name, parent: id, ...(name === 'task' ? { agent: input.subagent_type } : {}) });
              return ctx.executeTool(name, input, options);
            },
          });
          emit('tool', { name: definition.name, args, call_id: id, result, state: runtime.ledger.state });
          return result;
        },
      });
      if (key === 'on') return (name, handler, ...options) => pi.on(name, async (event, ctx) => {
        const result = await handler(event, ctx);
        if (name === 'tool_call' && result?.block) {
          emit('blocked', { name: event.toolName, call_id: event.toolCallId, result, state: runtime.ledger.state });
        }
        if (name === 'tool_result' && result?.content) {
          emit('result_patch', { name: event.toolName, call_id: event.toolCallId, result });
        }
        return result;
      }, ...options);
      return Reflect.get(target, key);
    },
  }));
  if (!runtime) throw new Error('Installed candidate did not register in owned lead session');
  pi.on('session_start', (_event, ctx) => emit('ready', {
    installed_entry: installed, session_id: ctx.sessionManager.getSessionId(),
  }));
  pi.on('tool_call', (event, ctx) => {
    if (validation && event.toolName === 'bash' && event.input.command === validation.command) {
      Object.assign(validation, { call_id: event.toolCallId, input: event.input, cwd: ctx.cwd });
    }
  });
  pi.on('tool_result', event => {
    if (validation?.call_id === event.toolCallId) Object.assign(validation, {
      is_error: event.isError, structured_content: event.structuredContent ?? null,
      details: event.details, content: event.content,
    });
    if (['bash', 'edit'].includes(event.toolName)) emit('operation_result', {
      name: event.toolName, call_id: event.toolCallId, is_error: event.isError,
      structuredContent: event.structuredContent, details: event.details, content: event.content,
    });
  });
  pi.on('before_provider_request', event => emit('provider_request', {
    provider: event.model?.provider, model: event.model?.id,
  }));
  pi.on('session_shutdown', () => {
    if (brokerPresent) {
      if (previousBroker === undefined) delete globalThis[brokerKey];
      else globalThis[brokerKey] = previousBroker;
    }
  });
  pi.rpc.handle('oracle.acceptance.status', () => ({
    state: runtime.ledger.state, native_calls: nativeCalls, running: runtime.transport.running,
    coordination: { present: brokerPresent, roster: brokerPresent ? roster : [], calls: brokerCalls },
  }));
  pi.rpc.handle('oracle.acceptance.validate', async ({ executable, test_command, cwd }) => {
    if (runtime.ledger.state.job || validation) {
      throw fixtureSetupError('executable_validation', executable, 'validation_requires_idle_fixture');
    }
    validation = { command: fixtureShellCommand(executable, ['--version']) };
    try {
      await pi.executeTool('bash', { command: validation.command,
        description: 'Validate owned acceptance fixture Node executable', timeout: 30, run_in_background: false },
      { activateInactiveTool: true });
      const fixture_args = ['--test', 'fixture.test.mjs'];
      if (test_command?.command !== fixtureShellCommand(executable, fixture_args) ||
          cwd !== validation.cwd) {
        throw fixtureSetupError('executable_validation', executable, 'fixture_command_mismatch');
      }
      const evidence = { ...validateShellFixture(executable, validation),
        fixture_args, fixture_command: test_command.command, argument_object: test_command, cwd: validation.cwd };
      emit(evidence.event, evidence);
      return evidence;
    } finally { validation = undefined; }
  });
}
