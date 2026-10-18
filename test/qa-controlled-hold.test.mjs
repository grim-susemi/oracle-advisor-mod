import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../qa/harness.mjs';

const controlledCases = [
  'resident-stuck', 'shutdown-inflight', 'consult-cache-budget', 'cancel-after-promotion',
];
const otherCases = ['resident-3', 'resident-dead', 'answered-error-words'];

test('transport hold admission follows the selected oracle route before any host or provider call', async t => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-qa-controlled-hold-'));
  const calls = { discoverHost: 0, authHashes: 0, admitAuth: 0, guardAuth: 0,
    disposableEnvironment: 0, OwnedProcess: 0, startTransportProvider: 0 };
  const key = `oracle-qa-controlled-hold-${root}`;
  globalThis[key] = calls;
  const harnessUrl = new URL('../qa/harness.mjs', import.meta.url).href;
  const driverUrl = new URL('../qa/transport-case.mjs', import.meta.url);
  driverUrl.searchParams.set('controlled-hold-test', root);
  const fakeHarness = 'data:text/javascript,' + encodeURIComponent(`
    export * from ${JSON.stringify(harnessUrl)};
    export const ROOT = ${JSON.stringify(root)};
    export const sourceHash = () => 'controlled-hold-test';
    ${['discoverHost', 'authHashes', 'admitAuth', 'guardAuth', 'disposableEnvironment', 'OwnedProcess']
      .map(name => `export function ${name}() {
        globalThis[${JSON.stringify(key)}].${name}++;
        throw Object.assign(new Error('Admission reached ${name}'), { code: 'test_admission_reached' });
      }`).join('\n')}
  `);
  const fakeProvider = 'data:text/javascript,' + encodeURIComponent(`
    export function startTransportProvider() {
      globalThis[${JSON.stringify(key)}].startTransportProvider++;
      throw new Error('Provider must not start in a preflight test');
    }
  `);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === driverUrl.href) {
      if (specifier === './harness.mjs') return { url: fakeHarness, shortCircuit: true };
      if (specifier === './transport-provider.mjs') return { url: fakeProvider, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const previousExitCode = process.exitCode;
  try {
    const { runTransportCase } = await import(driverUrl.href);
    for (const scenario of [...controlledCases, ...otherCases]) {
      for (const oracle of ['real', 'mock']) {
        for (const main of ['real', 'mock']) {
          await t.test(`${scenario}: oracle=${oracle}, main=${main}`, async () => {
            for (const name of Object.keys(calls)) calls[name] = 0;
            const values = { case: scenario, oracle, main, attempt: 'preflight' };
            await runTransportCase(values);
            const evidenceDir = join(root, '.omo/evidence/preflight/task-6-piomo-oracle-advisor-mod');
            const runDir = readdirSync(evidenceDir, { withFileTypes: true })
              .find(entry => entry.isDirectory() && entry.name.startsWith(`${scenario}-${oracle}-${main}-`));
            assert.ok(runDir);
            const receipt = readJson(join(evidenceDir, runDir.name, 'receipt.json'));
            const requiresControlled = controlledCases.includes(scenario) && oracle === 'real';
            assert.equal(receipt.error.code,
              requiresControlled ? 'scenario_requires_controlled_oracle' : 'test_admission_reached');
            assert.deepEqual(calls, { discoverHost: requiresControlled ? 0 : 1,
              authHashes: 0, admitAuth: 0, guardAuth: 0, disposableEnvironment: 0,
              OwnedProcess: 0, startTransportProvider: 0 });
            assert.deepEqual(values, { case: scenario, oracle, main, attempt: 'preflight' });
            assert.equal(receipt.oracle_mode, oracle);
            assert.equal(receipt.main_mode, main);
            assert.equal(receipt.status, 'failed');
            assert.equal(receipt.exit_code, 1);
            assert.equal(process.exitCode, 1);
            assert.equal(receipt.real_oracle_runs, 0);
            assert.deepEqual(receipt.children, []);
            assert.deepEqual(receipt.blocked_by_auth_guard, []);
            assert.equal(receipt.cleanup.pids_gone, true);
            assert.equal(receipt.cleanup.homes_removed, true);
          });
        }
      }
    }
  } finally {
    process.exitCode = previousExitCode;
    hooks.deregister();
    delete globalThis[key];
    rmSync(root, { recursive: true, force: true });
  }
});
