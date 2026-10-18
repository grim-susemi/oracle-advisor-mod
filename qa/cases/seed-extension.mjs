import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import extension from '../../src/extension.mjs';
import { observeScenario } from '../scenario-observer.mjs';

export default function seedProbe(pi) {
  let runtime;
  const tools = new Map();
  const snapshot = ctx => ({
    state: runtime.ledger.state,
    entries: ctx.sessionManager.getBranch().filter(entry =>
      entry.type === 'custom' && entry.customType === 'oracle-advisor'),
    session_id: ctx.sessionManager.getSessionId(),
  });
  const emit = (event, ctx, extra = {}) =>
    pi.rpc.emit('oracle-qa.seed', { event, ...snapshot(ctx), ...extra });
  pi = observeScenario(pi, (event, data) => pi.rpc.emit('oracle-qa.seed', { event, ...data }));
  const observed = new Proxy(pi, {
    get(target, key) {
      if (key === 'registerTool') return definition => {
        tools.set(definition.name, definition);
        pi.registerTool(definition);
      };
      if (key !== 'registerCommand') return Reflect.get(target, key);
      return (name, definition) => pi.registerCommand(name, {
        ...definition,
        async handler(args, ctx) {
          const result = await definition.handler(args, ctx);
          emit('command', ctx, { command: name, args, result });
          return result;
        },
      });
    },
  });
  runtime = extension(observed);
  pi.on('session_start', (_event, ctx) => emit('session_start', ctx));
  pi.on('before_provider_request', (event, ctx) => emit('provider_request', ctx, {
    provider: event.model?.provider, model: event.model?.id,
  }));
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'oracle_bind_seed') emit('tool_call', ctx, {
      tool_call_id: event.toolCallId, seed_yaml: event.input.seed_yaml,
    });
  });
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName === 'oracle_bind_seed') emit('tool_result', ctx, {
      tool_call_id: event.toolCallId, result: event.details,
    });
  });
  pi.registerCommand('qa_seed', {
    description: 'Owned Seed contract fixture: bind, invalid input, STOP or snapshot.',
    async handler(args, ctx) {
      let result, seed_yaml, call_id;
      if (args === 'hold') runtime.ledger.append({ type: 'stop_opened', stop_id: 'qa-seed-stop' });
      else if (!['snapshot', 'model-window'].includes(args)) {
        const inputs = {
          missing: 'acceptance_criteria:\n  - Missing goal\n',
          ambiguous: 'goal: |\n  A folded goal\nacceptance_criteria:\n  - A\n',
          quoting: 'goal: "\\x41"\nacceptance_criteria:\n  - A\n',
        };
        seed_yaml = args === 'drift' ? `${runtime.ledger.state.job.seed.text}\n`
          : Object.hasOwn(inputs, args) ? inputs[args] : readFileSync(
          new URL(`../../test/fixtures/${args === 'other' ? 'seed-handwritten-mixed' : 'seed-skill'}.yaml`, import.meta.url), 'utf8',
        );
        call_id = `qa-seed-${randomUUID()}`;
        emit('evidence', ctx, { kind: 'attempt', fixture: true,
          name: 'oracle_bind_seed', call_id, parent_id: null, input: { seed_yaml }, cwd: ctx.cwd });
        result = await tools.get('oracle_bind_seed').execute(call_id, { seed_yaml }, undefined, undefined, ctx);
        emit('evidence', ctx, { kind: 'executed', fixture: true,
          name: 'oracle_bind_seed', call_id, parent_id: null, result, is_error: result.isError === true });
      }
      emit('fixture', ctx, { args, result, seed_yaml, call_id });
    },
  });
}
