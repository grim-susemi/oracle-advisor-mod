import extension from '../src/extension.mjs';
import { observeScenario } from './scenario-observer.mjs';

export default function lifecycleProbe(pi) {
  const emit = (event, data = {}) => pi.rpc.emit('oracle-qa.lifecycle-retirement', { event, ...data });
  let runtime;
  const owned = new Set();
  const scenario = observeScenario(pi, emit, { getRuntime: () => runtime });
  const observed = new Proxy(scenario, {
    get(target, name) {
      if (name !== 'registerCommand') return Reflect.get(target, name);
      return (command, definition) => scenario.registerCommand(command, {
        ...definition,
        async handler(args, ctx) {
          try {
            const result = await definition.handler(args, ctx);
            emit('command', { args, result, state: runtime.ledger.state,
              context_executeTool: typeof ctx.executeTool, command_context: typeof ctx.waitForIdle });
            return result;
          } catch (error) {
            emit('command_error', { args, code: error.code, message: error.message, state: runtime.ledger.state });
            throw error;
          }
        },
      });
    },
  });
  runtime = extension(observed);
  if (!runtime) return;
  pi.on('session_start', () => emit('ready'));
  pi.on('tool_result', event => emit('tool_result', event));
  pi.registerTool({
    name: 'qa_transport_run', label: 'Owned lifecycle fixture',
    description: 'Create a retained native oracle to exercise owner lifecycle cleanup.',
    parameters: { type: 'object', properties: { marker: { type: 'string' }, mode: { type: 'string' } },
      required: ['marker', 'mode'], additionalProperties: false },
    async execute(_id, _args, signal, _update, ctx) {
      const outcome = await ctx.executeTool('task', {
        subagent_type: 'oracle', description: 'oracle-advisor owned lifecycle fixture',
        prompt: 'Return the JSON verdict CONTINUE with no reasons.', run_in_background: false,
      }, { signal, activateInactiveTool: true });
      if (outcome.isError) throw new Error(JSON.stringify(outcome));
      const id = outcome.result.details.task_id;
      owned.add(id);
      runtime.ledger.append({ type: 'oracle_assigned', oracle_task_id: id, residency: 'resident' });
      const output = await ctx.executeTool('task_output', { task_id: id, mode: 'status' },
        { signal, activateInactiveTool: true });
      emit('seeded', { id, task: output.result.details.snapshot });
      return { content: [{ type: 'text', text: 'Owned retained oracle seeded.' }] };
    },
  });
  pi.rpc.handle('oracle.lifecycle.hold', () => {
    runtime.ledger.append({ type: 'stop_opened', stop_id: 'fixture-stop',
      reasons: [{ text: 'Owner lifecycle cleanup must remain available while held.' }] });
    return { state: runtime.ledger.state };
  });
  pi.rpc.handle('oracle.lifecycle.state', async () => {
    const tasks = [];
    for (const id of owned) {
      const output = await pi.executeTool('task_output', { task_id: id, mode: 'status' }, { activateInactiveTool: true });
      tasks.push(output.details.snapshot);
    }
    return { state: runtime.ledger.state, tasks };
  });
  // Failure cleanup is distinct from the behavior under test. It touches only
  // this fixture's native IDs and is not needed on the passing owner path.
  pi.rpc.handle('oracle.lifecycle.cleanup', async () => {
    runtime.ledger.append({ type: 'job_paused' });
    const tasks = [];
    for (const id of owned) {
      await pi.executeTool('task_cancel', { task_id: id, reason: 'Owned failed-fixture cleanup.' }, { activateInactiveTool: true });
      const output = await pi.executeTool('task_output', { task_id: id, mode: 'status' }, { activateInactiveTool: true });
      tasks.push(output.details.snapshot);
    }
    return tasks;
  });
}
