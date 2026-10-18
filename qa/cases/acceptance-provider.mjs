import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';

export const SEED = 'goal: Normalize names without weakening the fixture test\n' +
  'acceptance_criteria:\n' +
  '  - id: AC1\n    text: Keep fixture.test.mjs unchanged and make its assertion pass.\n' +
  '  - id: AC2\n    text: Normalize names by trimming whitespace and lowercasing.\n';
export const ORIGINAL = 'export const normalize = value => value;\n';
export const OBVIOUS = 'export const normalize = value => value.toLowerCase();\n';
export const CORRECT = 'export const normalize = value => value.trim().toLowerCase();\n';
export const FIXTURE_TEST = "import assert from 'node:assert/strict';\n" +
  "import test from 'node:test';\nimport { normalize } from './normalize.mjs';\n" +
  "test('normalize trims and lowercases', () => assert.equal(normalize('  ALIce  '), 'alice'));\n";

const edit = (oldText, newText, path = 'normalize.mjs') => ({ tool: 'edit', arguments: { path, oldText, newText } });
const consult = (kind, question) => ({ tool: 'oracle_consult', arguments: { kind, question } });
const check = testCommand => ({ tool: 'eval', arguments: {
  language: 'js', summary: 'Run the owned normalization fixture test',
  code: `display(await tool.bash(${JSON.stringify(testCommand)}));`,
} });

function actions(down, stop_id, redirect_id, testCommand) {
  return [
    { tool: 'oracle_bind_seed', arguments: { seed_yaml: SEED } },
    ...(down ? [
      consult('work', 'Review the normalization fixture. If advice is unavailable I will still finish the bounded task.'),
      edit(ORIGINAL, CORRECT), check(testCommand),
    ] : [
      edit(ORIGINAL, OBVIOUS), check(testCommand), check(testCommand),
      consult('work', 'The same fixture test failed twice after the obvious lowercase fix. What must change?'),
      edit(OBVIOUS, CORRECT),
      { tool: 'oracle_record_stop', arguments: {
        redirect_id, decision: 'followed',
        reason: 'The whitespace failure confirms the advice to trim before lowercasing.',
        next_step: 'Verify the corrected trim plus lowercase implementation with the unchanged test.',
        evidence_refs: ['normalize.mjs', 'fixture.test.mjs'],
      } },
      check(testCommand),
      consult('work', 'I now propose weakening fixture.test.mjs instead of preserving its assertion. Judge this drift against AC1.'),
      edit("'alice'", "'  alice  '", 'fixture.test.mjs'),
      { tool: 'oracle_record_stop', arguments: {
        stop_id, decision: 'redirect',
        reason: 'Preserve the original fixture assertion and reject the proposed Seed drift.',
        next_step: 'Keep the trim plus lowercase implementation and verify the unchanged test.',
        evidence_refs: ['fixture.test.mjs', 'normalize.mjs'],
      } },
      consult('work', 'I recorded the redirect and kept the fixture unchanged. Review the corrected plan before continuing.'),
      { tool: 'oracle_advisor', arguments: { action: 'finish_intent' } },
      consult('completion', 'Final review: the unchanged normalization test passes and the Seed drift was rejected.'),
      consult('work', 'This fifth request must be refused without dispatching another oracle.'),
    ]),
    { text: 'Owned acceptance main finished.' },
  ];
}

// Gate decisions are scripts, not model compliance. The host still performs
// validation, provider streaming, native task dispatch and all product hooks.
export async function startAcceptanceProvider(rawPath, { down = false, testCommand } = {}) {
  const requests = [];
  let mainStep = 0;
  let oracleStep = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!['main', 'oracle'].includes(body.model)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Unknown fixture model: ${body.model}`, code: 'model_not_found' } }));
        return;
      }
      const transcript = JSON.stringify(body.messages);
      const stop_id = [...transcript.matchAll(/J1-[a-f0-9]{16}/g)].at(-1)?.[0];
      const redirect_id = [...transcript.matchAll(/J1-redirect-[a-f0-9]{16}/g)].at(-1)?.[0];
      const verdicts = [
        { verdict: 'REDIRECT', reasons: [{ text: 'The lowercase-only fix retains whitespace; trim before lowercasing.', criterion_id: 'AC2' }] },
        { verdict: 'STOP', reasons: [{ text: 'Do not weaken the fixture test; that violates AC1.', criterion_id: 'AC1' }] },
        { verdict: 'CONTINUE', reasons: [{ text: 'The recorded redirect preserves AC1 and the implementation satisfies AC2.' }] },
        { verdict: 'CONTINUE', reasons: [{ text: 'The unchanged fixture test passes; the bounded work can finish.' }] },
      ];
      const step = body.model === 'main' ? actions(down, stop_id, redirect_id, testCommand)[mainStep++] ?? { text: 'Owned acceptance main finished.' }
        : { text: 'Read-only fixture analysis.\n' + JSON.stringify(verdicts[oracleStep++] ?? { verdict: 'CONTINUE', reasons: [] }) };
      const record = {
        index: requests.length + 1, model: body.model, action: step.tool ?? 'answer',
        usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 },
        usage_source: 'mock-provider-fixed-fixture-numbers',
        ...(body.model === 'oracle' ? { oracle_sequence: oracleStep,
          dossier_has_seed: transcript.includes('AC1') && transcript.includes('AC2'),
          dossier_has_prior_verdicts: transcript.includes('prior_verdicts') } : {}),
      };
      requests.push(record);
      appendFileSync(rawPath, JSON.stringify(record) + '\n');
      // Native work can outlast the server's idle keep-alive window. These
      // independent fixture replies must not depend on a pooled socket surviving.
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: `acceptance-${record.index}`, object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: record.usage } : {}),
      })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      if (step.tool) {
        chunk({ tool_calls: [{ index: 0, id: `acceptance-call-${record.index}`, type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.arguments) } }] });
        chunk({}, 'tool_calls');
      } else { chunk({ content: step.text }); chunk({}, 'stop'); }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: { message: error.message } }));
    }
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
