import extension from '../../src/extension.mjs';
import { observeScenario } from '../scenario-observer.mjs';

// Only the owned QA host loads this observer. Product receipts and branch entries,
// rather than assistant prose, decide the assertions in lifecycle.mjs.
export default function lifecycleProbe(pi) {
  const registered = [];
  let runtime;
  const snapshot = ctx => ({
    state: runtime?.ledger.state ?? null,
    entries: ctx.sessionManager.getBranch().filter(entry =>
      entry.type === 'custom' && entry.customType === 'oracle-advisor'),
    registered_commands: registered,
    session_id: ctx.sessionManager.getSessionId(),
    generation: runtime?.generation ?? null,
  });
  const emit = (event, ctx, details = {}) =>
    pi.rpc.emit('oracle-qa.lifecycle', { event, ...details, ...(ctx ? snapshot(ctx) : {}) });
  const scenario = observeScenario(pi, (event, data) => emit(event, null, data));
  const observed = new Proxy(scenario, {
    get(target, key) {
      if (key !== 'registerCommand') return Reflect.get(target, key);
      return (name, definition) => {
        registered.push(name);
        scenario.registerCommand(name, {
          ...definition,
          async handler(args, ctx) {
            const result = await definition.handler(args, ctx);
            emit('command', ctx, { command: name, args, result });
            return result;
          },
        });
      };
    },
  });
  runtime = extension(observed);
  if (process.env.OMO_ORACLE_ADVISOR === '0') extension(observed);
  pi.on('session_start', (_event, ctx) => emit('session_start', ctx));
  pi.on('before_provider_request', (event, ctx) => emit('provider_request', ctx, {
    provider: event.model?.provider, model: event.model?.id,
  }));
  pi.registerTool({
    name: 'qa_lifecycle_probe', label: 'Lifecycle QA probe',
    description: 'Harmless owned-host QA marker; no files, tasks or provider calls.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'Lifecycle probe available.' }] };
    },
  });
  scenario.registerCommand('qa_lifecycle', {
    description: 'Owned lifecycle fixture snapshots and interrupted ledger fixture.',
    handler(args, ctx) {
      if (args === 'begin') {
        const { job } = runtime.ledger.state;
        runtime.ledger.append({
          type: 'consult_reserved', job_id: job.job_id, job_epoch: job.job_epoch,
          request_id: 'qa-interrupted', kind: 'work',
        });
        runtime.ledger.append({
          type: 'consult_started', job_id: job.job_id, job_epoch: job.job_epoch,
          request_id: 'qa-interrupted', started_at: new Date().toISOString(),
        });
      }
      emit('fixture', ctx, { args });
    },
  });
}
