import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';

// Local scripted main/oracle. Provider traffic still traverses the installed
// host, native task engine, and the product's real oracle_consult tool.
export async function startConsultProvider(rawPath) {
  const requests = [];
  const issued = new Set();
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const user = body.messages.findLast(message => message.role === 'user')?.content ?? '';
    const text = typeof user === 'string' ? user : JSON.stringify(user);
    const record = { index: requests.length + 1, model: body.model,
      tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name),
      started_at: new Date().toISOString() };
    requests.push(record);
    appendFileSync(rawPath, JSON.stringify(record) + '\n');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: `consult-${record.index}`, object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    const marker = text.match(/QA_CONSULT_(work|completion)_([A-Za-z0-9_-]+)/);
    if (body.model === 'main' && marker && !issued.has(marker[0])) {
      issued.add(marker[0]);
      chunk({ tool_calls: [{ index: 0, id: `consult-call-${record.index}`, type: 'function',
        function: { name: 'oracle_consult', arguments: JSON.stringify({
          kind: marker[1], question: 'Review this owned QA fixture.',
          claims: ['The fixture is ready for review.'],
        }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: body.model === 'oracle'
        ? 'Inspect the verification evidence before proceeding.\n{"verdict":"CONTINUE","reasons":[]}'
        : 'Consult QA observed.' });
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
