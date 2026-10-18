import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Test-only provider. A held response is released by a host event, never a sleep.
export async function startTransportProvider(rawPath, oracleAnswers = [], { mainToolCall } = {}) {
  const events = new EventEmitter();
  const requests = [];
  const issued = new Set();
  const held = new Map();
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const user = body.messages.findLast(message => message.role === 'user')?.content ?? '';
    const text = typeof user === 'string' ? user : JSON.stringify(user);
    const record = { index: requests.length + 1, provider_request_id: randomUUID(), model: body.model, text,
      tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name), started_at: Date.now() };
    requests.push(record);
    appendFileSync(rawPath, JSON.stringify(record) + '\n');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: `transport-${record.index}`, object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    const finish = () => {
      chunk({ role: 'assistant', content: '' });
      const marker = text.match(/QA_TRANSPORT_RUN_[a-zA-Z0-9_-]+/)?.[0];
      if (body.model === 'main' && marker && !issued.has(marker)) {
        issued.add(marker);
        const call = mainToolCall?.(text) ?? { name: 'qa_transport_run', arguments: {
          marker, mode: text.includes('QA_TRANSPORT_HOLD') ? 'hold' : 'normal',
        } };
        chunk({ tool_calls: [{ index: 0, id: `transport-call-${record.index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: body.model === 'oracle'
          ? oracleAnswers.shift() ?? '{"verdict":"CONTINUE","reasons":[]}' : 'Transport QA observed.' });
        chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
      }
      response.end('data: [DONE]\n\n');
      record.ended_at = Date.now();
      events.emit('finished', record);
    };
    if (body.model === 'oracle' && text.includes('QA_TRANSPORT_HOLD')) {
      record.held_at = Date.now();
      appendFileSync(rawPath, JSON.stringify({ event: 'held', ...record }) + '\n');
      held.set(record.index, finish);
      response.once('close', () => {
        held.delete(record.index);
        events.emit('closed', record);
      });
      events.emit('held', record);
    } else finish();
    events.emit('request', record);
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, events, requests,
    release(index) {
      const finish = held.get(index);
      if (!finish) throw new Error(`No held transport stream ${index}`);
      held.delete(index);
      finish();
    },
    async close() {
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections(); await closed;
    },
  };
}
