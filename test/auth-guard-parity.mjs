import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ROOT, authHashes, finalizeAuthGuard, finalizeAuthObservation, guardAuth, readJson, writeJson,
} from '../qa/harness.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute each complete shipped finalizer, with process/model boundaries inert.
function finalizer(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const marker = '} finally {';
  const open = source.lastIndexOf(marker) + marker.length - 1;
  assert.ok(open >= marker.length, file);
  let depth = 1;
  let quote = null;
  let comment = null;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment === 'line') { if (ch === '\n') comment = null; continue; }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (["'", '"', '`'].includes(ch)) { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) {
      const code = source.slice(open + 1, i);
      return { code, sha256: createHash('sha256').update(code).digest('hex') };
    }
  }
  throw new Error(`Unclosed finalizer in ${file}`);
}

const specs = [
  { name: 'smoke-real', file: 'qa/run.mjs', guarded: true, changedStatus: 'auth_changed' },
  { name: 'smoke-mock', file: 'qa/run.mjs', guarded: true, providers: [], changedStatus: 'auth_changed' },
  { name: 'triggers-real', file: 'qa/triggers-case.mjs', guarded: true, changedStatus: 'auth_changed' },
  { name: 'capability-real', file: 'qa/capability-case.mjs', guarded: true, capability: true, changedStatus: 'auth_changed' },
  { name: 'policy-real', file: 'qa/oracle-policy-case.mjs', guarded: true, proxy: true, changedStatus: 'auth_changed' },
  { name: 'transport-real', file: 'qa/transport-case.mjs', guarded: true, transport: true, changedStatus: 'blocked_by_auth_guard' },
  { name: 'lifecycle-real', file: 'qa/cases/lifecycle.mjs', guarded: true, changedStatus: 'auth_changed' },
  { name: 'seed-real', file: 'qa/cases/seed.mjs', guarded: true, changedStatus: 'auth_changed' },
  { name: 'dossier-only', file: 'qa/cases/dossier.mjs', legacyStrict: true, changedStatus: 'auth_changed' },
  { name: 'policy-static', file: 'qa/oracle-policy-case.mjs', legacyStrict: true, changedStatus: 'auth_changed' },
  { name: 'lifecycle-mock', file: 'qa/cases/lifecycle.mjs' },
  { name: 'seed-mock', file: 'qa/cases/seed.mjs' },
  { name: 'transport-mock', file: 'qa/transport-case.mjs', transport: true },
  { name: 'capability-mock', file: 'qa/capability-case.mjs', capability: true, initializeGuard: true },
  { name: 'child-entry', file: 'qa/cases/child-entry.mjs' },
];
const mutations = ['unchanged', 'external', 'guarded', 'pool-external', 'pool-guarded',
  'format-only', 'malformed-auth', 'malformed-pool'];

// Original branch quoted by the independent todo-16 review. Execute it against
// each fixture's actual hashes instead of deriving history from current output.
function originalDossier(before, after) {
  const receipt = { status: 'passed', exit_code: 0 };
  receipt.auth_unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!receipt.auth_unchanged) {
    receipt.status = 'auth_changed';
    receipt.exit_code = 1;
  }
  return { status: receipt.status, exit_code: receipt.exit_code };
}

export async function strictParity(directory) {
  const previous = process.env.ORACLE_QA_AUTH_GUARD;
  const blocks = new Map(specs.map(spec => [spec.file, finalizer(spec.file)]));
  const rows = [];
  let checkedArtifacts = 0;
  try {
    for (const mode of ['absent', 'scope', 'scoped']) {
      if (mode === 'absent') delete process.env.ORACLE_QA_AUTH_GUARD;
      else process.env.ORACLE_QA_AUTH_GUARD = mode;
      for (const spec of specs) for (const mutation of mutations) {
        const scenario = join(directory, String(rows.length));
        const agent = join(scenario, 'fixture-agent');
        const attemptDir = join(scenario, 'attempt');
        const runDir = join(attemptDir, 'run');
        const evidenceDir = join(attemptDir, 'evidence');
        mkdirSync(agent, { recursive: true });
        mkdirSync(runDir, { recursive: true });
        mkdirSync(evidenceDir);
        const auth = { ollama: { type: 'api_key', key: 'parity-secret-main' },
          external: { type: 'oauth', access: 'parity-secret-access', expires: 1000 } };
        const pool = { schemaVersion: 1, installationKey: 'parity-secret-install',
          providers: { ollama: { lanes: {} }, external: { lanes: {} } } };
        const save = () => {
          writeJson(join(agent, 'auth.json'), auth);
          writeJson(join(agent, 'credential-pool-state.json'), pool);
        };
        save();
        const before = authHashes(agent);
        const providers = spec.providers ?? ['ollama'];
        if (spec.guarded || spec.initializeGuard) guardAuth(attemptDir, agent, { before: true, providers });
        if (mutation === 'external') { auth.external.access = 'parity-secret-next'; auth.external.expires = 2000; }
        if (mutation === 'guarded') auth.ollama.key = 'parity-secret-next';
        if (mutation === 'pool-external') pool.providers.external.lanes.one = { stateVersion: 1 };
        if (mutation === 'pool-guarded') pool.providers.ollama.lanes.one = { stateVersion: 1 };
        save();
        if (mutation === 'format-only') writeFileSync(join(agent, 'auth.json'), JSON.stringify(auth, null, 4));
        if (mutation === 'malformed-auth') writeFileSync(join(agent, 'auth.json'), 'parity-secret-malformed');
        if (mutation === 'malformed-pool') writeFileSync(join(agent, 'credential-pool-state.json'), 'parity-secret-malformed');
        const receipt = { case: spec.name, status: 'passed', exit_code: 0, children: [], cleanup: {},
          adversarial: {}, attempts: [], variants: [], auth_before: before,
          raw_output_path: join(runDir, 'observations.json') };
        if (spec.transport || spec.proxy || spec.name === 'policy-static') receipt.blocked_by_auth_guard = [];
        if (spec.capability) receipt.report = {};
        const outputs = [];
        const fakeProcess = {};
        const context = {
          ROOT, join, readJson, writeJson, readFileSync, writeFileSync,
          authHashes: () => authHashes(agent),
          guardAuth: (attempt, _source, options) => guardAuth(attempt, agent, options),
          finalizeAuthGuard: (value, attempt, _source, options) => finalizeAuthGuard(value, attempt, agent, options),
          finalizeAuthObservation: (value, baseline, _source, options) => finalizeAuthObservation(value, baseline, agent, options),
          receipt,
          host: {}, attemptDir, evidenceDir, runDir,
          receiptPath: join(evidenceDir, `${spec.name}.json`), authBefore: before, before, authProviders: providers,
          values: { case: spec.name, main: spec.guarded && !spec.proxy && !spec.capability && spec.name !== 'smoke-mock' ? 'real' : 'mock',
            oracle: spec.transport && spec.guarded ? 'real' : 'mock' },
          caseName: spec.name, usesRealOracle: spec.name === 'capability-real', usesReal: !!spec.guarded,
          owned: null, child: null, pending: null, sandbox: null, sandboxes: [],
          mock: spec.capability ? { requests: [], close: async () => {} } : null,
          proxy: spec.proxy ? { requests: [], close: async () => {} } : null,
          cleanupDisposableState: () => { throw new Error('Unexpected process cleanup'); },
          removeSandbox: () => { throw new Error('Unexpected process cleanup'); },
          probeEvents: () => [], isEvent: () => () => false,
          command: async () => ({ stdout: '', metadata: { exit_code: 0, pid_gone: true } }),
          process: fakeProcess, console: { log: line => outputs.push(JSON.parse(line)) },
        };
        await new AsyncFunction(...Object.keys(context), `{\n${blocks.get(spec.file).code}\n}`)(...Object.values(context));
        const persisted = readJson(join(runDir, 'receipt.json'));
        const after = { status: receipt.status, exit_code: receipt.exit_code };
        assert.deepEqual({ status: persisted.status, exit_code: persisted.exit_code }, after);
        assert.equal(fakeProcess.exitCode, after.exit_code);
        assert.equal(outputs.at(-1).exit_code, after.exit_code);
        // Dossier uses the preserved original branch. Triggers now deliberately
        // reports its complete guard/catch result even on the finalizer-only path.
        const strictBlocked = (spec.guarded || spec.legacyStrict) && mutation !== 'unchanged';
        const legacy = spec.name === 'dossier-only' ? originalDossier(before, authHashes(agent))
          : { status: strictBlocked ? spec.changedStatus : 'passed', exit_code: strictBlocked ? 1 : 0 };
        const scopedBlocked = spec.guarded && (['malformed-auth', 'malformed-pool'].includes(mutation) ||
          (providers.length > 0 && ['guarded', 'pool-guarded'].includes(mutation)));
        const expected = mode === 'scoped'
          ? { status: scopedBlocked ? spec.changedStatus : 'passed',
            exit_code: scopedBlocked ? 1 : 0 }
          : legacy;
        assert.deepEqual(after, expected, `${mode}/${spec.name}/${mutation}`);
        if (spec.guarded) {
          const guardReceipt = readJson(join(attemptDir, 'auth-guard-receipt.json'));
          if (mode === 'scoped' && ['external', 'pool-external'].includes(mutation)) {
            assert.deepEqual(guardReceipt.events[0].providers, ['external']);
          }
          assert.equal(readJson(join(attemptDir, 'real-model-safety.json')).blocked, after.exit_code === 1);
        }
        const inspect = path => {
          for (const item of readdirSync(path, { withFileTypes: true })) {
            const file = join(path, item.name);
            if (item.isDirectory()) inspect(file);
            else if (file.endsWith('.json')) {
              const content = readFileSync(file, 'utf8');
              assert.ok(!content.includes('parity-secret'), file);
              assert.doesNotMatch(content, /"(?:access|refresh|key|installationKey)"\s*:/, file);
              checkedArtifacts++;
            }
          }
        };
        inspect(attemptDir);
        rows.push({ case: spec.name, file: spec.file, mode, mutation, before: legacy, after });
        rmSync(scenario, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ORACLE_QA_AUTH_GUARD;
    else process.env.ORACLE_QA_AUTH_GUARD = previous;
  }
  return {
    baseline: 'Original dossier branch quoted in the todo-16 gate review; other strict decisions from the retained reviews. Trigger finalizer status normalized to the guard/catch result as requested for attempt 2.',
    compared_fields: ['status', 'exit_code'], scenarios: rows.length, checked_json_artifacts: checkedArtifacts,
    strict_mismatches: 0, real_model_calls: 0, host_processes: 0,
    source_blocks: [...blocks].map(([file, block]) => ({ file, sha256: block.sha256 })), rows,
  };
}
