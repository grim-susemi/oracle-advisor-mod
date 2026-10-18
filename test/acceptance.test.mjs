import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEffects } from '../qa/cases/acceptance.mjs';
import { startAcceptanceProvider } from '../qa/cases/acceptance-provider.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureShellCommand } from '../qa/fixture-executable.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('acceptance fixture closes each SSE connection instead of reusing it after native work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-acceptance-provider-'));
  const testCommand = { command: fixtureShellCommand(process.execPath, ['--test', 'fixture.test.mjs']),
    description: 'owned acceptance fixture', timeout: 30, run_in_background: false };
  const provider = await startAcceptanceProvider(join(directory, 'provider.jsonl'), { down: true, testCommand });
  t.after(async () => {
    await provider.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const tool of ['oracle_bind_seed', 'oracle_consult', 'edit', 'eval']) {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'main', messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.headers.get('connection'), 'close');
    const records = (await response.text()).split('\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)));
    const call = records.flatMap(record => record.choices[0].delta.tool_calls ?? [])[0].function;
    assert.equal(call.name, tool);
    if (tool === 'eval') assert.equal(JSON.parse(call.arguments).code,
      `display(await tool.bash(${JSON.stringify(testCommand)}));`);
  }
  assert.equal(provider.requests.length, 4);
});

test('acceptance effects use final receipts and keep missing usage unknown', () => {
  const summary = summarizeEffects([{
    name: 'without-coordination', evidence: 'run/receipt.json',
    receipts: [
      { event: 'consult', request_id: 'one', kind: 'work', status: 'answered', verdict: 'STOP',
        path: 'spawn', verdict_changed_direction: false, same_failure_recurred_after: null,
        input_tokens: null, output_tokens: null, reasoning_tokens: null, main_cache_wait_exceeded: true },
      { event: 'consult_effect', request_id: 'one', verdict_changed_direction: true,
        same_failure_recurred_after: false },
      { event: 'consult', request_id: 'two', status: 'cap_exhausted', model_called: false },
    ],
    main_usage: [], provider_calls: [{ model: 'main' }, { model: 'oracle' }],
    coordination: { present: false, calls: [] },
  }], { main: 'mock', oracle: 'mock' });
  assert.equal(summary.consults.value.length, 1);
  assert.equal(summary.paths.value.spawn, 1);
  assert.equal(summary.verdicts.value.STOP, 1);
  assert.equal(summary.verdict_changed_direction.value, 1);
  assert.equal(summary.repeated_failures_after_consult.value.not_recurred, 1);
  assert.equal(summary.oracle_tokens_vs_main_tokens.value.oracle.input_tokens, null);
  assert.equal(summary.oracle_tokens_vs_main_tokens.value.main.input_tokens, null);
  assert.equal(summary.main_cache_wait_exceeded.value, 1);
  assert.equal(summary.oracle_to_main_coordination_asks.value, null);
  assert.equal(summary.token_savings.value, null);
  for (const field of Object.values(summary)) {
    assert.equal(field.source.mode, 'mock');
    assert.ok(field.source.observation.length);
  }
});

test('acceptance effects count broker asks only from broker receipts', () => {
  const summary = summarizeEffects([{
    name: 'with-coordination', evidence: 'run/receipt.json',
    receipts: [{ event: 'consult', request_id: 'one', path: 'revival', status: 'answered',
      kind: 'completion', verdict: 'CONTINUE', input_tokens: 13, output_tokens: 9, reasoning_tokens: 0 }],
    main_usage: [{ input: 7, output: 4, cacheRead: 0, cacheWrite: 0 }],
    provider_calls: [], coordination: { present: true, calls: [
      { method: 'peers' }, { method: 'ask', from: 'oracle', to: 'main' },
      { method: 'ask', from: 'another-peer', to: 'oracle' },
    ] },
  }], { main: 'mock', oracle: 'mock' });
  assert.equal(summary.oracle_to_main_coordination_asks.value, 1);
  assert.equal(summary.oracle_tokens_vs_main_tokens.value.oracle.input_tokens, 13);
  assert.equal(summary.oracle_tokens_vs_main_tokens.value.main.input_tokens, 7);
});

test('direction summary separates changed, not_changed and unknown final facts', () => {
  const summary = summarizeEffects([{
    name: 'direction-facts', evidence: 'run/receipt.json',
    receipts: [
      { event: 'consult', request_id: 'followed', path: 'spawn', verdict: 'REDIRECT',
        verdict_changed_direction: null },
      { event: 'consult_effect', request_id: 'followed', verdict_changed_direction: true },
      { event: 'consult_effect', request_id: 'followed', verdict_changed_direction: true },
      { event: 'consult', request_id: 'declined', path: 'spawn', verdict: 'REDIRECT',
        verdict_changed_direction: null },
      { event: 'consult_effect', request_id: 'declined', verdict_changed_direction: false },
      { event: 'consult', request_id: 'continue', path: 'spawn', verdict: 'CONTINUE',
        verdict_changed_direction: false },
      { event: 'consult', request_id: 'unrecorded', path: 'spawn', verdict: 'REDIRECT',
        verdict_changed_direction: null },
      { event: 'consult', request_id: 'invalid', path: 'spawn', verdict_changed_direction: null },
    ], main_usage: [], provider_calls: [], coordination: { present: false, calls: [] },
  }], { main: 'mock', oracle: 'mock' });
  assert.equal(summary.verdict_changed_direction.value, 1);
  assert.deepEqual(summary.direction_changes.value, { changed: 1, not_changed: 2, unknown: 2 });
});

for (const name of ['acceptance', 'acceptance-oracle-down']) {
  test(`${name} real route reaches the admitted host spawn boundary without model calls`, () => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('./helpers/acceptance-launch.mjs', import.meta.url)),
      name, '--main', 'real', '--oracle', 'real',
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.host_launch.policy, 'real-authorized');
    assert.equal(result.host_launch.admission, 'real-authorized-v1');
    assert.equal(result.hosts.length, 1, JSON.stringify(result.fixture_setup));
    const [host] = result.hosts;
    assert.equal(host.policy, 'real-authorized');
    assert.equal(host.admission, 'real-authorized-v1');
    assert.equal(host.args[host.args.indexOf('--thinking') + 1], 'off');
    assert.equal(result.fixture_setup.reason, 'host_spawn_observed');
    assert.equal(result.real_provider_calls, 0);
    assert.equal(result.real_oracle_runs, 0);
    assert.equal(result.cleanup.all_owned_pids_gone, true);
    assert.equal(result.cleanup.all_temporary_homes_removed, true);
  });
}
