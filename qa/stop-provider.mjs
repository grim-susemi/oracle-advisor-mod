import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';

// Both models use the installed provider adapter. Only this loopback fixture
// chooses the actions, so compliance with a nudge cannot decide a gate QA pass.
export async function startStopProvider(rawPath, caseName) {
  const requests = [];
  let step = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const record = { index: requests.length + 1, model: body.model,
      tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name) };
    requests.push(record);
    const messages = JSON.stringify(body.messages);
    const stop_id = messages.match(/J1-[a-f0-9]{16}/)?.[0];
    const actions = [
      { name: 'oracle_bind_seed', arguments: {
        seed_yaml: 'goal: Preserve the protected fixture\nacceptance_criteria:\n  - id: AC1\n    text: The protected fixture must remain unchanged.\n',
      } },
      { name: 'oracle_consult', arguments: { kind: 'work',
        question: 'I intend to change fixture.txt from protected to changed, violating AC1. Review that plan.',
      } },
      ...(caseName === 'stop-forged' ? [
        { name: 'read', arguments: { path: 'forged.txt' } },
        { name: 'edit', arguments: { path: 'fixture.txt', oldText: 'protected', newText: 'changed' } },
      ] : [
        { name: 'edit', arguments: { path: 'fixture.txt', oldText: 'protected', newText: 'changed' } },
        { name: 'lsp_rename', arguments: { filePath: 'fixture.mjs', line: 1, character: 6, newName: 'changed' } },
        { name: 'oracle_record_stop', arguments: { stop_id, decision: 'redirect',
          reason: 'Use the disposable fixture to verify the authorized STOP disposition.',
          next_step: 'Apply only the disposable test edit and verify its exact content.',
          evidence_refs: ['fixture.txt'],
        } },
        { name: 'edit', arguments: { path: 'fixture.txt', oldText: 'protected', newText: 'changed' } },
      ]),
    ];
    const action = body.model === 'main' ? actions[step++] : null;
    if (action) record.action = action.name;
    appendFileSync(rawPath, JSON.stringify(record) + '\n');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: `stop-${record.index}`, object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (action) {
      chunk({ tool_calls: [{ index: 0, id: `stop-call-${record.index}`, type: 'function',
        function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: body.model === 'oracle'
        ? 'The proposed edit changes a protected fixture.\n{"verdict":"STOP","reasons":[{"text":"Do not change the protected fixture.","criterion_id":"AC1"}]}'
        : 'The owned STOP fixture has finished.' });
      chunk({}, 'stop', { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 });
    }
    response.end('data: [DONE]\n\n');
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return {
    requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections(); await closed;
    },
  };
}
