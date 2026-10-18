import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptA8Evidence, replayCase, replayBatch } from '../qa/replay-t19a3.mjs';
import { fileURLToPath } from 'node:url';

const encode = value => JSON.stringify(value) + '\n';
function fixture() {
  const path = 'C:/retained/probe.jsonl';
  return {
    batch: 'a8', caseName: 'resident-stuck',
    orderedText: encode({ sequence: 1, timestamp: '2026-10-17T00:00:00Z',
      observer_pid: 10, child_pid: 11, stream: 'stdout', text: '{}\n' }),
    driverText: encode({ sequence: 1, timestamp: '2026-10-17T00:00:00Z',
      stream: 'stdout', text: encode({ receipt: 'C:/retained/native.json' }) }),
    receipt: { native_receipt_path: 'C:/retained/native.json',
      native_receipt: { case: 'resident-stuck', oracle_mode: 'mock',
        events: [{ event: 'forged_cached_event' }], status: 'passed' },
      raw_logs: { retained_host_event_logs: [path] } },
    sources: [{ path, text: encode({ event: 'ready', decision: 'resident' }) }],
  };
}

test('a8 uses raw probe authority and separate driver pointer, not historical admission', () => {
  const input = fixture();
  const before = structuredClone(input);
  const adapted = adaptA8Evidence(input);
  assert.deepEqual(input, before);
  assert.equal(adapted.schema.authority, 'probe-jsonl');
  assert.equal(adapted.schema.child_capture_records, 1);
  assert.deepEqual(adapted.observation.events, [{ event: 'ready', decision: 'resident' }]);
  assert.equal(adapted.observation.status, undefined);
  assert.equal(adapted.observation.events.some(event => event.kind === 'retirement_authority'), false);
  assert.notEqual(replayCase(input).verdict, 'accepted');
});

test('a8 rejects unknown capture envelope and missing driver pointer explicitly', () => {
  const input = fixture();
  input.orderedText = encode({ sequence: 1, event: 'ready' });
  const result = replayCase(input);
  assert.equal(result.verdict, 'reject');
  assert.ok(result.diagnostics.some(item => item.code === 'a8_capture_shape'));
  const missing = replayCase({ ...fixture(), driverText: '' });
  assert.equal(missing.verdict, 'reject');
  assert.ok(missing.diagnostics.some(item => item.code === 'driver_pointer_missing'));
});

test('a8 rejects malformed raw authority instead of using cached events', () => {
  const input = fixture();
  input.sources[0].text = '{broken';
  const result = replayCase(input);
  assert.equal(result.verdict, 'reject');
  assert.ok(result.diagnostics.some(item => item.code === 'raw_json_malformed'));
});

test('a8 preserves controlled provider operands without inventing hold evidence', () => {
  const input = fixture();
  input.sources[0].text = [
    { event: 'provider_request', request_id: 'request-1', mode: 'hold', job_id: 'job-1' },
    { event: 'ready' },
  ].map(encode).join('');
  const adapted = adaptA8Evidence(input);
  assert.deepEqual(adapted.observation.provider_calls, [
    { event: 'provider_request', request_id: 'request-1', mode: 'hold', job_id: 'job-1' },
  ]);
  input.sources[0].text = encode({ event: 'ready' });
  assert.deepEqual(adaptA8Evidence(input).observation.provider_calls, []);
});

test('unknown case rejects through the final table rather than being omitted', () => {
  const result = replayCase({ ...fixture(), caseName: 'unrecognized' });
  assert.equal(result.verdict, 'reject');
  assert.deepEqual(result.clause_ids, []);
  assert.match(result.reason, /No verdict specification/);
});

test('retained a8 inventory includes every driver, child capture, rerun and interrupted log', () => {
  const directory = fileURLToPath(new URL('../.omo/evidence/a8', import.meta.url));
  const result = replayBatch(directory, { batch: 'a8' });
  assert.equal(result.coverage.summary_cases, 7);
  assert.equal(result.coverage.discovered_ordered_logs, 15);
  assert.equal(result.entries.length, 15);
  assert.equal(new Set(result.entries.map(entry => entry.raw_log)).size, 15);
  assert.equal(result.entries.filter(entry => entry.raw_log.endsWith('.driver.ordered.jsonl')).length, 7);
  const interrupted = result.entries.find(entry => entry.raw_log.endsWith('.interrupted'));
  assert.equal(interrupted.verdict, 'reject');
  assert.ok(interrupted.diagnostics.some(item => item.code === 'interrupted_capture'));
  assert.deepEqual(result.raw_manifest_after, result.raw_manifest_before);
  assert.equal(result.model_runs, 0);
  assert.equal(result.native_runs, 0);
});

test('static policy captures do not require an oracle provider stream that never existed', () => {
  const directory = fileURLToPath(new URL('../.omo/evidence/a7', import.meta.url));
  const result = replayBatch(directory, { batch: 'a7' });
  for (const name of ['oracle-profile-switch', 'oracle-project-override-write']) {
    const entry = result.entries.find(entry => entry.case === name);
    assert.equal(entry.verdict, 'accepted');
    assert.ok(!entry.diagnostics.some(item => item.code === 'raw_source_missing'));
  }
});
