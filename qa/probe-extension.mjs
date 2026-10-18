import { appendFileSync } from 'node:fs';

export default function probe(pi) {
  const emit = (event, data = {}, ctx) => {
    const receipt = {
      event, ...data, pid: process.pid,
      session_id: ctx?.sessionManager.getSessionId(),
      session_file: ctx?.sessionManager.getSessionFile(),
      loading_mechanism: process.env.ORACLE_QA_LOADING,
      nonce: process.env.ORACLE_QA_NONCE,
    };
    appendFileSync(process.env.ORACLE_QA_PROBE_LOG, JSON.stringify(receipt) + '\n');
    pi.rpc.emit('oracle-qa.probe', receipt);
  };
  pi.on('session_start', (_event, ctx) => emit('session_start', {}, ctx));
  pi.on('before_provider_request', (event, ctx) => {
    emit('provider_request', { provider: event.model?.provider, model: event.model?.id }, ctx);
  });
  pi.on('after_provider_response', (event, ctx) => emit('provider_response', { status: event.status }, ctx));
  pi.registerCommand('qa_probe', {
    description: 'Owned QA command receipt; no model call.',
    handler: async (args, ctx) => { emit('command', { args }, ctx); },
  });
  pi.registerTool({
    name: 'qa_probe_tool',
    label: 'QA probe',
    description: 'Record the QA marker requested by the user. Call once, then answer.',
    parameters: {
      type: 'object', properties: { marker: { type: 'string' } },
      required: ['marker'], additionalProperties: false,
    },
    async execute(toolCallId, args, _signal, _update, ctx) {
      emit('tool', { tool_call_id: toolCallId, marker: args.marker }, ctx);
      return { content: [{ type: 'text', text: `Recorded ${args.marker}` }], details: { recorded: true } };
    },
  });
}
