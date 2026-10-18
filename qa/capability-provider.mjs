import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { describePolicyRequest } from './provider-purpose.mjs';

// This provider reports the real HTTP tool schema, not the oracle's recollection.
// Held streams are released by an exact host event or cancelled by the host.
export async function startCapabilityProvider(rawPath) {
  const requests = [];
  const events = new EventEmitter();
  const held = new Map();
  const issuedMainPrompts = new Set();
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: ['main', 'oracle'].map(id => ({ id, object: 'model' })) }));
      return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const userContent = body.messages.findLast(message => message.role === 'user')?.content ?? '';
    const text = typeof userContent === 'string' ? userContent
      : userContent.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort();
    const record = { ...describePolicyRequest(body), index: requests.length + 1, model: body.model, tools, text,
      started_at: Date.now(), response_id: `capability-${requests.length + 1}` };
    requests.push(record);
    appendFileSync(rawPath, JSON.stringify(record) + '\n');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: `capability-${record.index}`, object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    const finish = () => {
      chunk({ role: 'assistant', content: '' });
      if (body.model === 'main' && body.messages.at(-1)?.role !== 'tool') {
        const action = text.match(/QA_CAPABILITY:(\w+)/)?.[1];
        const requestKey = text.match(/QA_RUN_[a-zA-Z0-9_-]+/)?.[0] ?? text;
        if (action && !issuedMainPrompts.has(requestKey)) {
          issuedMainPrompts.add(requestKey);
          chunk({ tool_calls: [{ index: 0, id: `probe-${record.index}`, type: 'function',
            function: { name: 'probe_oracle', arguments: JSON.stringify({ action }) } }] });
          chunk({}, 'tool_calls');
        } else { chunk({ content: 'QA complete.' }); chunk({}, 'stop'); }
      } else if (body.model === 'oracle' && /QA_IMAGE_READ/.test(text) && body.messages.at(-1)?.role !== 'tool') {
        const path = text.match(/QA_IMAGE_READ\s+(.+?)\. Read/)?.[1];
        chunk({ tool_calls: [{ index: 0, id: `image-${record.index}`, type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path }) } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: body.model === 'oracle'
          ? JSON.stringify({ answer: text.match(/QA_ANSWER_\w+/)?.[0] ?? 'QA_ANSWER', tools })
          : 'QA complete.' });
        chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
      }
      response.end('data: [DONE]\n\n');
      record.ended_at = Date.now();
      record.finished_at = record.ended_at;
      record.completed = true;
      events.emit('ended', record);
    };
    if (body.model === 'oracle' && /QA_HOLD_(ABORT|PROMOTE|IDLE)/.test(text)) {
      const kind = text.match(/QA_HOLD_(ABORT|PROMOTE|IDLE)/)[1];
      if (kind === 'IDLE') chunk({ role: 'assistant', content: 'QA_STREAM_STARTED' });
      held.set(kind, finish);
      response.once('close', () => { held.delete(kind); events.emit('closed', { kind, index: record.index }); });
    } else finish();
    events.emit('request', record);
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, events,
    release(kind) { const finish = held.get(kind); if (!finish) throw new Error(`No held stream: ${kind}`); held.delete(kind); finish(); },
    async close() {
      const ended = once(server, 'close');
      server.close(); server.closeAllConnections(); await ended;
    },
  };
}
