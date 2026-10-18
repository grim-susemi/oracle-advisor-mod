import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCapabilityProvider } from '../qa/capability-provider.mjs';

test('completion wakeups cannot repeat a previously issued probe action', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-provider-test-'));
  const mock = await startCapabilityProvider(join(directory, 'requests.jsonl'));
  t.after(async () => { await mock.close(); rmSync(directory, { recursive: true, force: true }); });
  const user = { role: 'user', content: 'QA_CAPABILITY:notification QA_RUN_unique' };
  const send = async messages => {
    const response = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'main', messages }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.match(await send([user]), /"name":"probe_oracle"/);
  const wake = await send([user, { role: 'assistant', content: 'QA complete.' }]);
  assert.doesNotMatch(wake, /"name":"probe_oracle"/);
});

test('idle fixture starts the provider stream before holding it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-idle-test-'));
  const mock = await startCapabilityProvider(join(directory, 'requests.jsonl'));
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await mock.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await fetch(`${mock.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'oracle', messages: [{ role: 'user', content: 'QA_HOLD_IDLE' }] }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  const first = await response.body.getReader().read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /QA_STREAM_STARTED/);
});
