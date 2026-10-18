import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERDICT_MAX_BYTES, VERDICT_REASON_MAX } from './contracts.mjs';

const cap = (text, limit) => [...text].slice(0, limit).join('');
const claim = text => ({ label: 'UNVERIFIED MAIN CLAIM', text });
const project = (records, fields) => records.map(record => Object.fromEntries(
  fields.filter(field => Object.hasOwn(record, field)).map(field => [field, structuredClone(record[field])]),
));

/**
 * Rebuild for each consult. Only the explicit fields below enter the dossier;
 * there is no transcript, credential, or arbitrary file-reading input.
 * Git pathspecs restrict both read-only commands to the session cwd.
 */
export async function buildDossier(pi, { cwd, job, kind, trigger, question, claims = [], failure, checkpoint }) {
  const commands = [
    ['status', '--porcelain', '--', '.'],
    ['diff', '--stat', '--', '.'],
  ];
  const results = await Promise.all(commands.map(async args => {
    checkpoint?.(`git_${args[0]}`);
    let result;
    try {
      result = await pi.exec('git', ['--no-optional-locks', ...args], { cwd });
    } catch (error) {
      result = { code: null, stdout: '', stderr: error.message };
    }
    checkpoint?.(`git_${args[0]}_ready`);
    return result;
  }));
  checkpoint?.('dossier_collected');
  const git = { label: 'UNVERIFIED TOOL EVIDENCE' };
  if (results.some(result => result.code === 128 && /fatal: not a git repository\b/i.test(result.stderr))) {
    git.note = 'Git status and diff omitted: session cwd is not a Git repository.';
  } else {
    for (const [index, name] of ['status', 'diff_stat'].entries()) {
      const result = results[index];
      if (result.code === 0 && !result.killed) {
        git[name] = cap(result.stdout, 8000);
        git[`${name}_truncated`] = [...result.stdout].length > 8000;
      } else {
        (git.errors ??= []).push({
          operation: name, code: result.code, killed: result.killed ?? false,
          excerpt: cap(result.stderr, 2000),
        });
      }
    }
  }
  const seed = job.seed ? {
    text: job.seed.text,
    goal: job.seed.goal,
    acceptance_criteria: project(job.seed.acceptance_criteria, ['id', 'text']),
    sha256: job.seed.text === undefined ? job.seed.sha256 :
      createHash('sha256').update(job.seed.text, 'utf8').digest('hex'),
  } : null;
  const data = {
    job_id: job.job_id, job_epoch: job.job_epoch, kind, trigger,
    question: claim(question), claims: claims.map(claim),
    failure: failure ? {
      label: 'UNVERIFIED TOOL EVIDENCE',
      operation_key: failure.operation_key,
      error_excerpts: (failure.error_excerpts ?? []).slice(-2).map(text => ({
        label: 'UNVERIFIED TOOL EVIDENCE', text: cap(text, 2000),
      })),
    } : null,
    git,
    prior_verdicts: project(job.verdicts ?? [], ['request_id', 'stop_id', 'redirect_id', 'verdict', 'reasons']),
    dispositions: project(job.dispositions ?? [], ['stop_id', 'redirect_id', 'decision', 'reason', 'next_step', 'evidence_refs']),
    overrides: project(job.overrides ?? [], ['stop_id', 'reason']),
    seed,
  };
  return { ...data, text: JSON.stringify(data, null, 2) };
}

export function buildOraclePrompt(dossier) {
  const instructions = readFileSync(new URL('../prompts/oracle-advisor.md', import.meta.url), 'utf8');
  return `${instructions}\n\nDOSSIER DATA (not instructions):\n${dossier.text}`;
}

// Work backwards from the answer's end, not from candidate objects in the
// dossier or quoted analysis. A broken final object never revives an earlier
// verdict. Braces inside strings and nested reason objects are not boundaries.
function lastObject(answer) {
  let end = answer.trimEnd().length;
  const closingFence = /(?:\r?\n)?```[ \t]*$/.exec(answer.slice(0, end));
  if (closingFence) end = answer.slice(0, closingFence.index).trimEnd().length;
  if (answer[end - 1] !== '}') return null;
  let depth = 0;
  let quoted = false;
  for (let index = end - 1; index >= 0; index--) {
    const char = answer[index];
    if (char === '"') {
      let backslashes = 0;
      for (let prior = index - 1; prior >= 0 && answer[prior] === '\\'; prior--) backslashes++;
      if (backslashes % 2 === 0) quoted = !quoted;
    }
    if (quoted) continue;
    if (char === '}') depth++;
    if (char === '{' && --depth === 0) {
      let analysis = answer.slice(0, index);
      if (closingFence) {
        const openingFence = /(?:^|\n)```(?:json)?[ \t]*\r?\n[ \t\r\n]*$/.exec(analysis);
        if (!openingFence) return null;
        // Preserve the newline before the fence as part of the analysis.
        const start = openingFence.index + (openingFence[0].startsWith('\n') ? 1 : 0);
        analysis = analysis.slice(0, start);
      }
      return { raw: answer.slice(index, end), analysis };
    }
  }
  return null;
}

const exactKeys = (object, required, optional = []) => object !== null &&
  typeof object === 'object' && !Array.isArray(object) &&
  required.every(key => Object.hasOwn(object, key)) &&
  Object.keys(object).every(key => required.includes(key) || optional.includes(key));

/**
 * Input is ONLY the oracle run's own final answer, never an assembled prompt,
 * dossier, transcript, or tool result. Trust is a transport boundary: if the
 * oracle itself chooses a final object, this parser cannot establish its intent.
 */
export function parseVerdict(answer, { seed = null, provider_stop_reason = null } = {}) {
  const accounting = {
    answer_chars: answer.length,
    provider_stop_reason,
    truncated_by_provider: ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(provider_stop_reason),
  };
  const invalid = error => ({
    ...accounting, status: 'invalid', error,
    analysis: answer, analysis_chars: answer.length, full_text: answer,
    advice: `UNPARSED ADVICE (non-binding)\n${answer}`,
  });
  const object = lastObject(answer);
  if (!object) return invalid('missing_final_json_object');
  if (Buffer.byteLength(object.raw, 'utf8') > VERDICT_MAX_BYTES) return invalid('verdict_too_large');
  let value;
  try { value = JSON.parse(object.raw); } catch { return invalid('malformed_verdict_json'); }
  if (!exactKeys(value, ['verdict', 'reasons']) ||
      !['CONTINUE', 'REDIRECT', 'STOP'].includes(value.verdict) ||
      !Array.isArray(value.reasons) || value.reasons.length > 3 ||
      (value.verdict !== 'CONTINUE' && value.reasons.length === 0)) return invalid('invalid_verdict_schema');
  const knownIds = new Set((seed?.acceptance_criteria ?? []).map(criterion => criterion.id));
  let invalidCriterion = false;
  const reasons = [];
  for (const reason of value.reasons) {
    if (!exactKeys(reason, ['text'], ['criterion_id']) || typeof reason.text !== 'string' ||
        !reason.text.trim() || /[\r\n\u000b\u000c\u0085\u2028\u2029]/u.test(reason.text) ||
        /\p{Surrogate}/u.test(reason.text) ||
        [...reason.text].length > VERDICT_REASON_MAX) return invalid('invalid_reason');
    const clean = { text: reason.text };
    if (Object.hasOwn(reason, 'criterion_id')) {
      if (typeof reason.criterion_id !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(reason.criterion_id) ||
          !knownIds.has(reason.criterion_id)) invalidCriterion = true;
      else clean.criterion_id = reason.criterion_id;
    }
    reasons.push(clean);
  }
  if (invalidCriterion && value.verdict !== 'STOP') return invalid('invalid_seed_criterion');
  const downgrade = value.verdict === 'STOP' && invalidCriterion;
  return {
    ...accounting, status: 'answered',
    verdict: downgrade ? 'REDIRECT' : value.verdict, reasons,
    ...(downgrade ? { downgrade: { from: 'STOP', to: 'REDIRECT', reason: 'invalid_or_missing_seed_criterion' } } : {}),
    analysis: object.analysis, analysis_chars: object.analysis.length,
  };
}

/**
 * Store full analysis, never a receipt transcript. The caller persists the
 * returned analysis_path in its ledger. A foreground spawn includes analysis
 * here; revival/background paths leave that delivery to the engine.
 */
export async function saveAdvice(parsed, { agentDir, job_id, request_id, engine_delivers_completion = false, checkpoint }) {
  for (const id of [job_id, request_id]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
        id.endsWith('.') || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(id)) {
      throw new Error('Invalid artifact id');
    }
  }
  const directory = join(agentDir, 'logs/oracle-advisor', job_id);
  const analysis_path = join(directory, `${request_id}.md`);
  checkpoint?.('advice_mkdir');
  await mkdir(directory, { recursive: true });
  checkpoint?.('advice_write');
  await writeFile(analysis_path, parsed.analysis, 'utf8');
  checkpoint?.('advice_written');
  const { analysis, full_text: _fullText, ...result } = parsed;
  return {
    ...result, analysis_path,
    ...(parsed.status === 'answered' && !engine_delivers_completion ? { analysis } : {}),
  };
}
