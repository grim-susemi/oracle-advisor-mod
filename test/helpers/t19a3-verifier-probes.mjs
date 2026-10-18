import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateVerdict } from '../../qa/verdict-spec.mjs';
import { assertHeldExecutions, scenarioFacts } from '../../qa/scenario-verdict.mjs';
import { READONLY_ORACLE_TOOLS } from '../../scripts/oracle-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = join(root, '.omo/evidence/v19b/g2');
export const originalProbeScripts = ['ce.mjs', 'r12.mjs', 'hold.mjs', 'r7-probe.mjs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function rejection(error) {
  const rejected = error.name !== 'TypeError' &&
    ['ERR_ASSERTION', 'scenario_not_reached'].includes(error.code) &&
    typeof error.verdict_row === 'string' &&
    ['admission', 'behavioral'].includes(error.verdict_phase);
  return { accepted: false, rejected, unexpected_error: !rejected,
    error_name: error.name, code: error.code, row: error.verdict_row ?? null,
    phase: error.verdict_phase ?? null, message: String(error.message).split('\n')[0] };
}

export function verdictResult(family, observation, options) {
  try {
    const rows = evaluateVerdict(family, structuredClone(observation), options);
    return { accepted: true, rejected: false, unexpected_error: false, rows };
  } catch (error) {
    return rejection(error);
  }
}

// Only module imports and output destinations are adapted. All mutation and
// invocation statements run verbatim, in the host realm, against the live table.
// No product snapshot module is imported and the original writes stay in memory.
export function runOriginalVerifierProbes({ nativeMatrix } = {}) {
  const inputs = new Map();
  const scripts = [];
  const replacements = new Map(), freshInputs = new Map();
  if (nativeMatrix) {
    const matrix = JSON.parse(readFileSync(nativeMatrix, 'utf8'));
    for (const [name, todo] of [['stop-forged', 8], ['stop-real', 8], ['nudge-real', 9], ['resident-stuck', 6]]) {
      const result = matrix.results.find(result => result.case === name);
      assert.equal(result?.exit_code, 0, `Fresh native base: ${name}`);
      const bytes = readFileSync(result.receipt);
      const receipt = JSON.parse(bytes);
      const retained = join(verifier,
        `product/.omo/evidence/gate19g2-${name}/task-${todo}-piomo-oracle-advisor-mod/${name}.json`);
      replacements.set(resolve(retained), bytes);
      freshInputs.set(resolve(result.receipt), bytes);
      if (name === 'resident-stuck') {
        const path = resolve(receipt.event_log_path ?? join(receipt.run_dir, 'probe.jsonl'));
        freshInputs.set(path, readFileSync(path));
      }
    }
  }
  const read = (path, encoding) => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(verifier, path);
    if (freshInputs.has(absolute)) {
      const bytes = freshInputs.get(absolute);
      return encoding ? bytes.toString(encoding) : bytes;
    }
    assert.ok(absolute === verifier || absolute.startsWith(verifier + '/')
      || absolute.startsWith(verifier + '\\'), `Read outside retained verifier: ${absolute}`);
    const bytes = readFileSync(absolute);
    inputs.set(absolute, sha256(bytes));
    const supplied = replacements.get(absolute) ?? bytes;
    return encoding ? supplied.toString(encoding) : supplied;
  };
  // The reviewer result catalog is evidence, not an alternative case generator.
  const catalog = JSON.parse(read('new-counterexamples.json', 'utf8'));
  for (const name of originalProbeScripts) {
    const source = read(name, 'utf8');
    const outputs = {};
    const calls = [];
    const stdout = [];
    const invoke = (family, observation, options) => {
      const input = structuredClone(observation);
      const call = { family, observation: input, options: structuredClone(options) };
      try {
        const rows = evaluateVerdict(family, observation, options);
        calls.push({ ...call, accepted: true, rejected: false, unexpected_error: false, rows });
        return rows;
      } catch (error) {
        calls.push({ ...call, ...rejection(error) });
        // Original scripts perform their own catches and write their diagnostics.
        throw error;
      }
    };
    const dependencies = { readFileSync: read,
      writeFileSync(path, data) { outputs[path] = String(data); },
      evaluateVerdict: invoke, assertHeldExecutions, scenarioFacts,
      READONLY_ORACLE_TOOLS, join,
      console: { log(...args) { stdout.push(args.join(' ')); } } };
    const body = source.replace(/^import [^\r\n]+;\r?$/gm, '');
    const extra = name === 'ce.mjs' ? '\nreturn cases;' : '';
    const definitions = new Function(...Object.keys(dependencies), body + extra)(
      ...Object.values(dependencies));
    scripts.push({ name, source_sha256: sha256(source), outputs, calls, stdout,
      definitions: definitions?.map(entry => ({ id: entry.id, family: entry.family,
        expect: entry.expect, note: entry.note })) });
  }
  // Includes scripts, original JSON receipts, raw JSONL, skill and catalog.
  const manifest = [...inputs].map(([path, before]) => {
    const after = sha256(readFileSync(path));
    assert.equal(after, before, `Original verifier evidence changed: ${path}`);
    return { path, sha256: before };
  });
  return { scripts, manifest, original_catalog: catalog,
    base_substitutions: [...replacements].map(([retained_path, bytes]) => ({
      retained_path, supplied_sha256: sha256(bytes),
    })),
    fresh_manifest: [...freshInputs].map(([path, bytes]) => {
      const hash = sha256(bytes);
      assert.equal(sha256(readFileSync(path)), hash, `Fresh base changed: ${path}`);
      return { path, sha256: hash };
    }),
    evidence_unchanged: true, actual_real_model_calls: 0, actual_native_qa_calls: 0 };
}
