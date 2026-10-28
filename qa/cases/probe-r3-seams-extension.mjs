import { appendFileSync } from 'node:fs';
import extension from '../../src/extension.mjs';

export default function probeR3SeamsExtension(pi) {
  let runtime;

  const emit = (event, data = {}) => {
    const entry = { event, ...data, at: Date.now() };
    if (process.env.ORACLE_QA_PROBE_LOG) {
      appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(entry) + '\n');
    }
    pi.rpc.emit('oracle-qa.probe-r3-seams', entry);
  };

  // Wire product extension so /oracle commands and tools exist
  try {
    runtime = extension(new Proxy(pi, {
      get(target, key) {
        if (key === 'registerCommand') return (name, definition) => pi.registerCommand(name, {
          ...definition,
          async handler(args, ctx) {
            const result = await definition.handler(args, ctx);
            emit('command', { name, args, result, state: runtime?.ledger?.state });
            return result;
          },
        });
        if (key === 'registerTool') return definition => pi.registerTool({
          ...definition,
          async execute(id, input, signal, update, ctx) {
            emit('tool_executing', { name: definition.name, id, input });
            const result = await definition.execute(id, input, signal, update, {
              ...ctx,
              async executeTool(name, args, options) {
                emit('native_tool_call', { name, parentTool: definition.name, parentId: id, args });
                return ctx.executeTool(name, args, options);
              },
            });
            emit('tool_executed', { name: definition.name, id, result, state: runtime?.ledger?.state });
            return result;
          },
        });
        return Reflect.get(target, key);
      },
    }));
  } catch (err) {
    emit('extension_load_error', { message: err.message });
  }

  // P2: Track input events
  pi.on('input', async (event, ctx) => {
    emit('input_seen', {
      source: event?.source ?? null,
      text: event?.text ?? null,
    });
    // P4: If input is trigger for atlas entry append
    if (event?.text?.includes('probe-p4-atlas')) {
      pi.appendEntry('primary-agent/v1', { schemaVersion: 1, agentId: 'atlas' });
      emit('p4_entry_appended', { agentId: 'atlas' });
    }
  });

  // P3: System prompt order and preview pass observation
  // Handler 1: previewSafe = true
  pi.on('before_agent_start', async (event, ctx) => {
    emit('before_agent_start_preview_safe', {
      preview: Boolean(event?.preview),
      systemPrompt: event?.systemPrompt,
      model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
    });
    // P4: check getBranch()
    if (!event?.preview && ctx?.sessionManager) {
      const branch = ctx.sessionManager.getBranch?.() ?? [];
      const primaryAgentEntries = branch.filter(e => e.customType === 'primary-agent/v1' || e.type === 'primary-agent/v1');
      emit('p4_branch_check', {
        entriesCount: primaryAgentEntries.length,
        entries: primaryAgentEntries.map(e => e.data ?? e),
      });
    }
    // P5: record ctx.model
    if (!event?.preview) {
      emit('p5_before_agent_start_model', {
        model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      });
    }
    return { systemPrompt: (event?.systemPrompt ?? '') + '\n[PROMPT_PART_1]' };
  }, { previewSafe: true });

  // Handler 2: previewSafe = false (default)
  pi.on('before_agent_start', async (event, ctx) => {
    emit('before_agent_start_normal', {
      preview: Boolean(event?.preview),
      systemPrompt: event?.systemPrompt,
    });
    return { systemPrompt: (event?.systemPrompt ?? '') + '\n[PROMPT_PART_2]' };
  });

  // Register a probe tool to execute sub-checks inside tool execution
  pi.registerTool({
    name: 'probe_tool',
    label: 'Probe tool',
    description: 'Execute probe actions from main agent',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['action'],
    },
    async execute(id, args, signal, update, ctx) {
      emit('probe_tool_called', { id, action: args.action, params: args.params });

      // P5: inside tool's execute
      const toolModel = ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
      emit('p5_tool_execute_model', { model: toolModel });

      if (args.action === 'task_spawn') {
        const { model, prompt = 'Reply test' } = args.params ?? {};
        const spawnArgs = {
          subagent_type: 'oracle',
          description: `probe spawn ${model ?? 'default'}`,
          prompt,
          run_in_background: false,
          ...(model ? { model } : {}),
        };
        try {
          const outcome = await ctx.executeTool('task', spawnArgs, { signal, activateInactiveTool: true });
          const res = outcome?.result ?? outcome;
          emit('task_spawn_result', { model, outcome: res, isError: outcome?.isError ?? false });
          return { content: [{ type: 'text', text: JSON.stringify(res) }] };
        } catch (err) {
          emit('task_spawn_error', { model, error: { message: err.message, code: err.code } });
          return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
        }
      }

      return { content: [{ type: 'text', text: 'OK' }] };
    },
  });

  pi.on('session_start', (event, ctx) => {
    emit('ready', {
      sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
    });
  });

  pi.rpc.handle('probe.runtime.status', () => ({
    ledger: runtime?.ledger?.state ?? null,
    job: runtime?.ledger?.jobFacts ?? null,
    consultPending: runtime?.consult ? Boolean(runtime.consult.pending) : false,
  }));
}
