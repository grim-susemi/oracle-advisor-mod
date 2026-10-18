import { createHash } from 'node:crypto';
import { openStops } from './ledger.mjs';

const invalid = message => Object.assign(new Error(message), { code: 'seed_invalid' });
const mapping = /^([A-Za-z_][A-Za-z0-9_-]*):(?: +(.*)|$)$/;
const sequence = /^-(?: |$)/;

// Deliberately not a general YAML loader. Reject constructs whose meaning this
// subset cannot preserve, rather than silently folding, resolving, or guessing.
function scalar(input) {
  const text = input.replace(/^ +| +$/g, '');
  if (text.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?: +#.*)?$/.exec(text);
    if (!quoted) throw invalid('Unsupported double-quoted scalar');
    try { return JSON.parse(quoted[1]); } catch { throw invalid('Unsupported quoted escape'); }
  }
  if (text.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?: +#.*)?$/.exec(text);
    if (!quoted) throw invalid('Unsupported single-quoted scalar');
    return quoted[1].replace(/''/g, "'");
  }
  const plain = text.replace(/ +#.*$/, '').replace(/ +$/, '');
  if (plain === '[]') return [];
  if (!plain || /^[!&*|>{}\[\],%@`#]/.test(plain) || /^[-?:](?:\s|$)/.test(plain) ||
      /:\s|:$/.test(plain)) throw invalid('Unsupported or ambiguous YAML scalar');
  if (/^(?:null|~)$/i.test(plain)) return null;
  if (/^(?:true|false|yes|no|on|off)$/i.test(plain)) return /^(?:true|yes|on)$/i.test(plain);
  if (/^[+-]?\.(?:inf|nan)$/i.test(plain)) throw invalid('Unsupported non-finite YAML scalar');
  if (/^[+-]?(?:\d|\.\d)/.test(plain) && /^[+\-\d.eExXa-fA-F_oObB:]+$/.test(plain)) return Number(plain);
  return plain;
}

function document(text) {
  if (typeof text !== 'string' || /[\t\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufeff]|\r(?!\n)/u.test(text)) {
    throw invalid('Seed YAML must be text without tabs or control characters');
  }
  const lines = text.split(/\r?\n/).map((line, row) => ({
    indent: /^ */.exec(line)[0].length, value: line.replace(/^ +| +$/g, ''), row,
  })).filter(line => line.value && !line.value.startsWith('#'));
  if (lines[0]?.value === '---') lines.shift();
  if (lines.at(-1)?.value === '...') lines.pop();
  if (!lines.length || lines[0].indent !== 0) throw invalid('Expected a Seed mapping');
  let index = 0;
  // The generator wraps plain scalars. Only contiguous, equally indented
  // continuation lines fold to spaces; blank/comment folding is outside this subset.
  function leaf(input, indent, row) {
    let value = input;
    const continuationIndent = lines[index]?.indent;
    while (index < lines.length && lines[index].indent > indent) {
      const line = lines[index];
      if (/^["']/.test(input) || typeof scalar(value) !== 'string' ||
          / +#/.test(value) || line.row !== row + 1 || line.indent !== continuationIndent ||
          typeof scalar(line.value) !== 'string') throw invalid('Unsupported YAML continuation');
      value += ` ${line.value}`;
      row = line.row;
      index++;
    }
    return scalar(value);
  }
  function block(indent, initial = null) {
    const list = !initial && sequence.test(lines[index]?.value ?? '');
    const result = list ? [] : Object.create(null);
    function pair({ value, row }) {
      const match = mapping.exec(value);
      if (!match || Object.hasOwn(result, match[1])) throw invalid('Invalid or duplicate YAML key');
      const rest = (match[2] ?? '').replace(/^#.*$/, '').replace(/^ +| +$/g, '');
      if (rest) result[match[1]] = leaf(rest, indent, row);
      else if (index < lines.length && (lines[index].indent > indent ||
          (lines[index].indent === indent && sequence.test(lines[index].value)))) {
        result[match[1]] = block(lines[index].indent);
      } else result[match[1]] = null;
    }
    if (initial) pair(initial);
    while (index < lines.length && lines[index].indent === indent) {
      const line = lines[index];
      if (sequence.test(line.value) !== list) break;
      index++;
      if (!list) pair(line);
      else {
        const value = line.value.slice(1).replace(/^ +/, '');
        if (!value) {
          if (!lines[index] || lines[index].indent <= indent) throw invalid('Empty criterion');
          result.push(block(lines[index].indent));
        } else if (mapping.test(value)) result.push(block(indent + 2, { value, row: line.row }));
        else result.push(leaf(value, indent, line.row));
      }
    }
    if (index < lines.length && lines[index].indent > indent) throw invalid('Unsupported YAML continuation');
    return result;
  }
  const value = block(0);
  if (index !== lines.length || Array.isArray(value)) throw invalid('Ambiguous or multiple YAML documents');
  return value;
}

export function parseSeed(text) {
  const value = document(text);
  if (typeof value.goal !== 'string' || !value.goal.trim() ||
      !Array.isArray(value.acceptance_criteria) || !value.acceptance_criteria.length) {
    throw invalid('Seed requires a goal and at least one acceptance criterion');
  }
  const ids = new Set();
  const acceptance_criteria = value.acceptance_criteria.map((criterion, index) => {
    let id = `AC${index + 1}`;
    let description = criterion;
    if (criterion && typeof criterion === 'object' && !Array.isArray(criterion)) {
      if (Object.hasOwn(criterion, 'text') === Object.hasOwn(criterion, 'description')) {
        throw invalid('Criterion requires exactly one text or description');
      }
      description = criterion.text ?? criterion.description;
      if (Object.hasOwn(criterion, 'id')) id = criterion.id;
    }
    if (typeof description !== 'string' || !description.trim() ||
        typeof id !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(id) || ids.has(id)) {
      throw invalid('Invalid criterion text or duplicate/invalid criterion id');
    }
    ids.add(id);
    return { id, text: description };
  });
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, hash, sha256: hash, goal: value.goal, acceptance_criteria };
}

function generatedSeed(branch) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const message = branch[index].type === 'message' ? branch[index].message : null;
    if (message?.role !== 'toolResult' || message.isError === true ||
        !/(?:^|[_./])ouroboros_generate_seed$/.test(message.toolName ?? '')) continue;
    const text = (message.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    const marker = '--- Seed YAML ---';
    if (text.includes(marker)) return { text: text.slice(text.indexOf(marker) + marker.length).replace(/^\r?\n/, '') };
    const fenced = /(?:^|\n)```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n)?$/.exec(text);
    return { text: fenced ? fenced[1] : text };
  }
  return null;
}

export function registerSeedTool(pi, runtime) {
  runtime.registerTool({
    name: 'oracle_bind_seed', label: 'Bind oracle Seed',
    description: 'Pin the latest generated Ouroboros Seed, or supplied YAML, as the oracle yardstick.',
    parameters: {
      type: 'object', properties: { seed_yaml: { type: 'string' } },
      required: ['seed_yaml'], additionalProperties: false,
    },
    async execute(_callId, args, _signal, _update, ctx) {
      const show = (status, text, extra = {}) => {
        const details = { status, ...extra };
        pi.sendMessage({
          customType: 'oracle-advisor-seed', content: text, display: true, details,
        }, { triggerTurn: false });
        return { content: [{ type: 'text', text }], details, structuredContent: details };
      };
      const job = runtime.ledger.state.job;
      if (job?.status !== 'active') return show('no_active_job', 'Seed not bound: no active oracle job.');
      if (openStops(job).length || ['HELD', 'HALTED'].includes(job.gate_state)) {
        return show('stop_held', 'Seed not bound: resolve the oracle STOP before changing scope.');
      }
      const generated = generatedSeed(ctx.sessionManager.getBranch());
      let seed;
      try {
        seed = { ...parseSeed(generated ? generated.text : args?.seed_yaml),
          source: generated ? 'tool_result' : 'main_supplied' };
      } catch (error) {
        if (error.code !== 'seed_invalid') throw error;
        return show('seed_invalid', `Seed invalid: ${error.message}`);
      }
      const unchanged = job.seed?.hash === seed.hash;
      if (!unchanged || job.seed.source !== seed.source) runtime.ledger.append({
        type: 'seed_bound', job_id: job.job_id, job_epoch: job.job_epoch + (job.seed && !unchanged ? 1 : 0), seed,
      });
      return show(unchanged ? 'seed_unchanged' : 'seed_bound',
        `oracle Seed ${seed.hash} (${seed.source}); epoch ${runtime.ledger.state.job.job_epoch}`,
        { hash: seed.hash, source: seed.source,
          job_epoch: runtime.ledger.state.job.job_epoch, criterion_ids: seed.acceptance_criteria.map(c => c.id) });
    },
  });
}
