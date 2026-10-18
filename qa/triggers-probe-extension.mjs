import { appendFileSync } from 'node:fs';
import { createTriggerState, reduceTriggers } from '../src/triggers.mjs';

// QA only. This probe observes real host events; it never fabricates tool calls,
// results, failures, or an oracle. Task 9 will wire the product hooks separately.
export default function triggersProbe(pi) {
  let state = createTriggerState({ active: true });
  const emit = (event, data, ctx) => {
    const receipt = {
      event, ...data, pid: process.pid, session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
      loading_mechanism: process.env.ORACLE_QA_LOADING,
    };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(receipt) + '\n');
    pi.rpc.emit('oracle-qa.triggers', receipt);
  };
  pi.on('session_start', (_event, ctx) => emit('session_start', {
    shell_surface: 'unmodified-installed-lead-tools',
  }, ctx));
  pi.on('before_provider_request', (event, ctx) =>
    emit('provider_request', { provider: event.model?.provider, model: event.model?.id }, ctx));
  pi.on('after_provider_response', (event, ctx) =>
    emit('provider_response', { status: event.status }, ctx));
  for (const type of ['tool_call', 'tool_result']) {
    pi.on(type, (event, ctx) => {
      const reduced = reduceTriggers(state, event, { cwd: ctx.cwd });
      state = reduced.state;
      emit(type, {
        tool_name: event.toolName, tool_call_id: event.toolCallId,
        parent_tool_call_id: event.parentToolCallId ?? null, input: event.input,
        ...(type === 'tool_result' ? {
          structured_content: event.structuredContent ?? null, is_error: event.isError,
        } : {}),
      }, ctx);
      for (const trigger of reduced.triggers) emit('trigger', trigger, ctx);
    });
  }
  pi.registerCommand('qa_trigger_status', {
    description: 'Receipt for the isolated trigger detector probe.',
    handler: async (_args, ctx) => emit('status', { state }, ctx),
  });
}
