import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ROOT, OwnedProcess, discoverHost, disposableEnvironment, cleanupDisposableState,
  hostArgs, writeJson, typedError,
} from './harness.mjs';
import { startMockProvider } from './mock-provider.mjs';

const entry = process.env.ORACLE_QA_INSTALLED_ENTRY;
const manifest = process.env.ORACLE_QA_INSTALLED_MANIFEST;
if (!entry || !manifest) throw typedError('installed_artifacts_required',
  'Provide ORACLE_QA_INSTALLED_ENTRY and ORACLE_QA_INSTALLED_MANIFEST for read-only installed QA.');
const evidence = join(ROOT, '.omo/evidence', `installed-atlas-auto-${Date.now()}`);
const receipt = { exit_code: 1, real_consults: 0, installed_entry: entry };
mkdirSync(evidence, { recursive: true });
const host = discoverHost();
const mock = await startMockProvider();
const sandbox = disposableEnvironment(host, evidence, {
  ORACLE_QA_ATTEMPT: 'installed-atlas-auto', ORACLE_QA_MOCK_URL: mock.baseUrl,
  OMO_ORACLE_ADVISOR: '1', OMO_ORACLE_AUTO_ATLAS: '1',
});
let child;
try {
  const timestamp = new Date().toISOString();
  // A persisted Atlas identity makes startup deterministic without a model call.
  writeFileSync(join(sandbox.sessionDir, 'owned.jsonl'), [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: sandbox.workDir },
    { type: 'custom', id: 'atlas-identity', parentId: null, timestamp,
      customType: 'primary-agent/v1', data: { schemaVersion: 1, agentId: 'atlas' } },
  ].map(JSON.stringify).join('\n') + '\n');
  child = new OwnedProcess(process.execPath, hostArgs(host, sandbox, entry, { main: 'mock' }), {
    cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(evidence, 'installed-host'),
    deadlineMs: 120000,
  });
  receipt.process = child.metadata;
  await child.rpc('get_state');
  receipt.surfaces = await child.rpc('get_loaded_surfaces');
  assert.ok(receipt.surfaces.extensions.some(e =>
    resolve(e.path).toLowerCase() === resolve(entry).toLowerCase()));
  const status = child.waitFor(e => e.type === 'message_end' &&
    e.message?.customType === 'oracle-advisor-status', 'installed Atlas job status',
    { from: child.history.length, timeoutMs: 60000 });
  await child.rpc('prompt', { message: '/oracle status' });
  receipt.status = (await status).message;
  assert.equal(receipt.status.details.job.status, 'active');
  assert.equal(receipt.status.details.job.auto.trigger, 'atlas_session_start');
  assert.equal(mock.requests.length, 0);
  receipt.generation = JSON.parse(readFileSync(manifest, 'utf8')).generation;
  assert.equal(receipt.generation, 'generation-000003');
  receipt.exit_code = 0;
} catch (error) {
  receipt.error = { message: error.message, stack: error.stack };
} finally {
  if (child) await child.stop({ force: true });
  receipt.mock_provider_calls = mock.requests.length;
  await mock.close();
  receipt.cleanup = cleanupDisposableState(sandbox);
  writeJson(join(evidence, 'installed-test.json'), receipt);
}
console.log(JSON.stringify({ exit_code: receipt.exit_code, generation: receipt.generation,
  real_consults: 0, job: receipt.status?.details.job, error: receipt.error }));
process.exitCode = receipt.exit_code;
