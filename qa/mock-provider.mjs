import { createServer } from 'node:http';
import { once } from 'node:events';

// Test-only OpenAI-compatible provider. The real host does schema validation,
// tool execution and transcript persistence; this server only scripts responses.
export async function startMockProvider({ steps = [], onRequest = () => {} } = {}) {
  const requests = [];
  let holdResponse = null;
  let holdPromiseResolve = null;
  let holdPromise = new Promise(resolve => { holdPromiseResolve = resolve; });

  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: ['main', 'oracle', 'gpt-qa', 'claude-qa', 'gpt-6-astra'].map(id => ({ id, object: 'model' })) }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString();
      const body = JSON.parse(rawBody);
      const reasoning = body.reasoning ?? body.reasoning_effort ?? null;
      const thinking = body.thinking ?? null;
      const record = {
        index: requests.length + 1,
        model: body.model,
        messages: body.messages.length,
        rawBody,
        body,
        reasoning,
        thinking,
      };
      requests.push(record);
      onRequest(record);
      const lastUser = body.messages.findLast(message => message.role === 'user');
      const userContentStr = JSON.stringify(lastUser?.content ?? '');
      if (userContentStr.includes('QA_CANCEL_HANG')) {
        // Deterministic mid-stream cancellation fixture; only close() ends it.
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        return;
      }
      if (body.model === 'oracle' && (userContentStr.includes('QA_HOLD') || userContentStr.includes('QA_ORACLE_HOLD'))) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.flushHeaders();
        holdResponse = () => {
          try {
            const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
              id: `mock-${requests.length}`, object: 'chat.completion.chunk',
              created: 0, model: body.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`);
            chunk({ role: 'assistant', content: '' });
            chunk({ content: JSON.stringify({ verdict: 'CONTINUE', reasons: ['Released hold fixture.'] }) });
            chunk({}, 'stop');
            response.write('data: [DONE]\n\n');
            response.end();
          } catch { /* client disconnected */ }
        };
        if (holdPromiseResolve) {
          holdPromiseResolve({ index: record.index, model: body.model });
          holdPromiseResolve = null;
        }
        return;
      }
      const marker = userContentStr.match(/QA_TOOL_[a-z0-9-]+/i)?.[0];
      const last = body.messages.at(-1);
      const step = steps.shift() ?? (
        body.model === 'oracle'
          ? { text: JSON.stringify({ verdict: 'CONTINUE', reasons: ['Scripted oracle fixture.'] }) }
          : marker && last?.role !== 'tool'
            ? { tool: 'qa_probe_tool', arguments: { marker } }
            : { text: 'QA prompt answered.' }
      );
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: `mock-${requests.length}`, object: 'chat.completion.chunk',
        created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      if (step.tool) {
        chunk({ tool_calls: [{
          index: 0, id: `mock-tool-${requests.length}`, type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.arguments ?? {}) },
        }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: step.text ?? JSON.stringify(step.verdict) });
        chunk({}, 'stop');
      }
      response.write('data: [DONE]\n\n');
      response.end();
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, steps,
    awaitHold(timeoutMs = 15000) {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for mock hold after ${timeoutMs}ms`)), timeoutMs);
      });
      return Promise.race([
        holdPromise.finally(() => clearTimeout(timer)),
        timeoutPromise,
      ]);
    },
    releaseHold() {
      if (holdResponse) {
        const fn = holdResponse;
        holdResponse = null;
        try {
          fn();
          return { released: true, error: null };
        } catch (err) {
          return { released: false, error: err.message };
        }
      }
      return { released: false, error: 'no_held_response' };
    },
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
