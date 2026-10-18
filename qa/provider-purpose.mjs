import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { samePath } from './scenario-verdict.mjs';

// Installed look-at/prompts.js and runner.js use a separate, tool-free
// media request. Tool count alone cannot distinguish it from a broken oracle.
export const LOOK_AT_RUNNER_SYSTEM = `You analyze attached media for a downstream agent that cannot inspect the attachments directly.

Extract only the information requested by the goal. Match the language of the goal.

Evidence rules:
- Be evidence-first. Clearly separate direct observations from inferences, and label inferences as such.
- Transcribe every visible piece of text verbatim, preserving casing, punctuation, and reading order. Mark unreadable text explicitly rather than guessing.
- Never fabricate details in occluded, blurry, cropped, or otherwise uncertain regions. State that the detail is unavailable or uncertain.
- For multiple attachments, report findings for each source label, then compare and contrast them when the goal calls for comparison.
- Be thorough about the goal and concise about unrelated detail.

Return only the response body. Do not add a preamble, meta commentary, or postscript.`;

export function describePolicyRequest(payload, { origin = { kind: 'unknown' } } = {}) {
  const messages = payload.messages ?? [];
  const tools = (payload.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort();
  const images = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => {
      const url = part.type === 'image_url' ? part.image_url?.url
        : part.type === 'input_image' ? part.image_url : undefined;
      return typeof url === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(url) &&
        Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length > 0;
    });
  const parts = Array.isArray(messages[1]?.content) ? messages[1].content : [];
  const text = parts.at(-1)?.type === 'text' ? parts.at(-1).text : '';
  const signature = !tools.length && messages.length === 2 &&
    messages[0].role === 'system' && messages[0].content === LOOK_AT_RUNNER_SYSTEM &&
    messages[1].role === 'user' && images.length > 0 && parts.length === images.length + 1 &&
    parts.slice(0, -1).every(part => images.includes(part)) &&
    /^Goal:\n[\s\S]+\n\nAttached sources:\n- [^\n]+(?:\n- [^\n]+)*$/.test(text);
  const lookAt = signature && origin.kind === 'look_at' && typeof origin.tool_call_id === 'string';
  return {
    model: payload.model, tools, image_parts: images.length,
    image_sha256s: images.map(part => {
      const url = part.type === 'image_url' ? part.image_url.url : part.image_url;
      return createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).digest('hex');
    }),
    goal: signature ? text.slice(6, text.lastIndexOf('\n\nAttached sources:\n')) : null,
    source_labels: signature ? text.slice(text.lastIndexOf('\n\nAttached sources:\n') + 20).split('\n')
      .map(line => line.slice(2)) : [],
    look_at_signature: signature, origin,
    purpose: lookAt ? 'look_at_media_analysis' : 'oracle_agent',
    purpose_evidence: lookAt
      ? { exact_runner_signature: true, tool_call_id: origin.tool_call_id }
      : { recognized_side_request: false },
  };
}

// Origin comes from the owned child transcript, never request text. A response
// persisted as an oracle assistant turn cannot be exempted even if it copies the
// entire media prompt and attachments.
export function correlatePolicyOrigins(requests, entries, { fixture_path, fixture_sha256 } = {}) {
  const messages = entries.map(entry => entry.message).filter(Boolean);
  const assistantIds = new Set(messages.filter(message => message.role === 'assistant')
    .map(message => message.responseId).filter(Boolean));
  const calls = entries.flatMap((entry, index) => entry.message?.role === 'assistant'
    ? (entry.message.content ?? []).filter(part => part.type === 'toolCall' && part.name === 'look_at')
      .map(call => ({ call, index, time: Date.parse(entry.timestamp) })) : []);
  const results = entries.flatMap((entry, index) => {
    const message = entry.message;
    if (message?.role !== 'toolResult' || message.toolName !== 'look_at' || message.isError) return [];
    const candidates = calls.filter(call => call.call.id === message.toolCallId && call.index < index);
    return candidates.length === 1 ? [{ message, call: candidates[0], time: Date.parse(entry.timestamp) }] : [];
  });
  const edges = new Map();
  for (const request of requests) {
    edges.set(request, results.filter(({ message, call, time }) => {
      const paths = call.call.arguments?.file_paths ??
        (call.call.arguments?.file_path ? [call.call.arguments.file_path] : []);
      const text = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
      return !assistantIds.has(request.response_id) && request.completed && request.response_id &&
        request.look_at_signature && fixture_path && fixture_sha256 && paths.length === 1 &&
        samePath(paths[0], fixture_path) && request.image_sha256s?.length === 1 &&
        request.image_sha256s[0] === fixture_sha256 && call.call.arguments.goal === request.goal &&
        call.time <= request.started_at && request.started_at <= request.finished_at &&
        request.finished_at <= time && message.details?.model?.endsWith(`/${request.model}`) &&
        JSON.stringify(message.details.sources) === JSON.stringify(request.source_labels) &&
        text && createHash('sha256').update(text).digest('hex') === request.response_sha256;
    }));
  }
  for (const request of requests) {
    const uniqueId = request.response_id && requests.filter(other => other.response_id === request.response_id).length === 1;
    const ownTurn = uniqueId && assistantIds.has(request.response_id);
    const candidates = edges.get(request);
    const result = uniqueId && candidates.length === 1 &&
      [...edges.values()].filter(matches => matches.includes(candidates[0])).length === 1 ? candidates[0].message : null;
    request.origin = ownTurn ? { kind: 'oracle_agent', response_id: request.response_id }
      : result ? { kind: 'look_at', tool_call_id: result.toolCallId, response_id: request.response_id }
        : { kind: 'unknown' };
    request.purpose = result ? 'look_at_media_analysis' : 'oracle_agent';
    request.purpose_evidence = result
      ? { exact_runner_signature: true, tool_call_id: result.toolCallId,
        matched_tool_result_sha256: request.response_sha256, outside_oracle_assistant_turn: true }
      : { recognized_side_request: false };
  }
  return requests;
}

export function assertOracleSchemas(requests, expected) {
  const turns = requests.filter(request => request.purpose === 'oracle_agent');
  assert.ok(turns.length > 0, 'No oracle agent provider turn was observed.');
  for (const turn of turns) assert.deepEqual(turn.tools, expected,
    'Oracle agent tool schema differs from the exact read-only allow-list.');
  return turns;
}
