import assert from 'node:assert/strict';
import { probeConsultCheckpoint } from './consult-checkpoint-probe.mjs';
import { probeConsultRebuild } from './consult-rebuild-probe.mjs';
import { runAccountingInterleavings } from './consult-accounting-probe.mjs';

const reasons = {
  cancel: 'cancelled', reload: 'interrupted', branch: 'stale_reservation',
  seed: 'stale_reservation', policy: 'oracle_not_readonly', 'reload-other': 'interrupted',
};

export function verifyConsultLifetime(probe) {
  assert.equal(probe.admission_before_microtask.status, 'admitted');
  assert.equal(probe.events[0].type, 'consult_admitted');
  assert.equal(probe.result.status, reasons[probe.reason]);
  assert.equal(probe.result.verdict, undefined);
  assert.equal(probe.native_oracle_dispatches, probe.dispatches_at_abort);
  assert.ok(probe.native_oracle_dispatches <= 1);
  assert.equal(probe.reserved_slots, 0);
  if (probe.after_action_reserved_slots !== null && ['cancel', 'reload', 'branch'].includes(probe.reason)) {
    assert.equal(probe.after_action_reserved_slots, 0);
  }
  assert.equal(probe.stops.length, 0);
  assert.equal(probe.verdicts.length, 0);
  const paid = probe.dispatches_at_abort === 1;
  assert.equal(probe.counters.consults, paid && probe.job_id === 'J1' ? 1 : 0);
  assert.equal(probe.result.calls_remaining, paid ? 3 : 4);
  assert.equal(probe.dispatches_after_replays, probe.native_oracle_dispatches);
  if (probe.branch_roundtrip) {
    assert.equal(probe.original_branch_reserved_slots, 0);
    assert.ok(probe.branch_roundtrip.every(result => ['interrupted', 'cancelled', 'stale_reservation'].includes(result.status) &&
      !result.verdict));
  }
  assert.ok(probe.replays.every(result => result.status === probe.result.status && !result.verdict));
  assert.ok(probe.rebuilds.every(result => result.reserved_slots === 0));
  assert.ok(probe.action_results.every(result => result?.status !== 'rejected'));
  assert.equal(probe.analysis_exists, probe.analysis_at_abort);
  assert.equal(probe.analysis_writes, probe.analysis_writes_at_abort);
  assert.ok(!probe.events_after_abort.some(event => ['verdict_recorded', 'stop_opened'].includes(event.type) ||
    event.status === 'answered'));
  if (probe.consult) assert.equal(probe.consult.status, probe.result.status);
  if (probe.reason === 'reload-other') assert.equal(probe.job_id, 'J9');
  assert.equal(probe.cleanup.homes_removed, true);
}

export function verifyRebuild(probe) {
  assert.equal(probe.injected, true);
  assert.equal(probe.rebuild.resolved, true);
  assert.equal(probe.action_result.resolved, true);
  assert.equal(probe.job_id, probe.expected_job_id);
  assert.equal(probe.reserved_slots, 0);
  assert.equal(probe.native_oracle_dispatches, 0);
  assert.ok(probe.replays.every(result => result.status === 'interrupted' && !result.verdict));
  if (probe.consult) {
    assert.equal(probe.consult.status, 'interrupted');
    assert.equal(probe.consult.counted, true);
    assert.equal(probe.counters.consults, 1);
  }
  assert.equal(probe.cleanup.homes_removed, true);
}

export function verifyTerminalBranchReplay(probe) {
  assert.equal(probe.dispatches_after_terminal_branch_replays, probe.native_oracle_dispatches);
  assert.ok(probe.native_oracle_dispatches <= 1);
  for (const row of probe.terminal_branch_replays) {
    assert.deepEqual(row.result, probe.result);
    assert.equal(row.dispatches, probe.native_oracle_dispatches);
    assert.equal(row.reserved_slots, 0);
    assert.equal(row.job_id, 'J1');
    assert.equal(row.job_epoch, 1);
  }
  assert.equal(probe.cleanup.homes_removed, true);
}

export function verifyNativeEnvelope(probe, modelCalled) {
  assert.equal(probe.action_results[0].status, 'cancelled');
  assert.equal(probe.result.status, 'cancelled');
  assert.equal(probe.consult.model_called, modelCalled);
  assert.equal(probe.consult.counted, modelCalled);
  assert.equal(probe.counters.consults, modelCalled ? 1 : 0);
  assert.equal(probe.result.calls_remaining, modelCalled ? 3 : 4);
  assert.equal(probe.dispatches_after_replays, 1);
  assert.equal(probe.reserved_slots, 0);
  assert.ok(probe.replays.every(result => result.status === 'cancelled' &&
    result.calls_remaining === (modelCalled ? 3 : 4)));
  assert.equal(probe.cleanup.homes_removed, true);
}

// Deterministic finite-state property: all checkpoint boundaries plus physical
// promise boundaries independently enumerated from the native/I/O contracts.
// Every aborted id is rebuilt and replayed repeatedly, not just inspected once.
export async function runConsultLifecycleProperty(onRow = () => {}) {
  const rows = [];
  const baseline = await probeConsultCheckpoint();
  const stages = [...new Set(baseline.stages)];
  const keep = (name, probe) => {
    onRow(name, probe);
    rows.push({ name, status: probe.result?.status ?? 'interrupted',
      dispatches: probe.native_oracle_dispatches, reserved_slots: probe.reserved_slots,
      replay_count: probe.replays?.length ?? probe.terminal_branch_replays?.length ?? 0, cleanup: probe.cleanup });
  };
  for (const stage of stages) for (const reason of Object.keys(reasons).filter(reason => reason !== 'reload-other')) {
    const probe = await probeConsultCheckpoint({ stage, reason, replayCount: 3 });
    verifyConsultLifetime(probe);
    keep(`checkpoint-${stage}-${reason}`, probe);
  }
  const physical = ['admitted_microtask', 'policy_return', 'notice', 'dossier', 'dossier_second', 'native',
    'native_cleanup_read', 'save', 'analysis_write_return'];
  for (const hold of physical) for (const reason of Object.keys(reasons).filter(reason => reason !== 'reload-other')) {
    const probe = await probeConsultCheckpoint({ hold, reason, replayCount: 3 });
    verifyConsultLifetime(probe);
    keep(`physical-${hold}-${reason}`, probe);
  }
  for (const reason of Object.keys(reasons)) {
    const probe = await probeConsultCheckpoint({ hold: 'native_error_return', reason, replayCount: 3,
      nativeError: { code: 'quota', model_called: true } });
    verifyConsultLifetime(probe);
    keep(`native-rejection-${reason}`, probe);
  }
  for (const event of ['session_start', 'session_tree']) {
    for (const boundary of ['read', 'cancel', 'confirm']) for (const action of [
      'cancel', 'reload', 'branch', 'seed', 'policy', 'native',
    ]) {
      for (const error of [null, { code: 'quota', model_called: true }]) {
        const probe = await probeConsultRebuild({ event, boundary, action, error });
        verifyRebuild(probe);
        keep(`rebuild-${event}-${boundary}-${action}-${error ? 'reject' : 'fulfill'}`, probe);
      }
    }
  }
  const terminalCases = [
    ['answered', { answerOverride: '{"verdict":"CONTINUE","reasons":[]}' }],
    ['stop', { answerOverride: '{"verdict":"STOP","reasons":[{"text":"Verify the bound scope.","criterion_id":"IS5-A"}]}' }],
    ['invalid', { answerOverride: 'Unparsed oracle advice.' }],
    ['unavailable', { nativeDetails: { kind: 'lane_capacity', model_called: false } }],
    ['cancelled', { reason: 'cancel', hold: 'admitted_microtask' }],
    ['interrupted', { reason: 'reload', hold: 'admitted_microtask' }],
  ];
  for (const [name, options] of terminalCases) for (const branchEvent of ['session_start', 'session_tree']) {
    for (const restart of [false, true]) {
      const probe = await probeConsultCheckpoint({ ...options, branchEvent, restart, terminalBranchReplays: 5 });
      verifyTerminalBranchReplay(probe);
      keep(`terminal-branch-${name}-${branchEvent}-${restart ? 'restart' : 'reload'}`, probe);
    }
  }
  for (const kind of ['quota', 'lane_capacity', 'error']) for (const model_called of [true, false]) {
    for (const withId of [true, false]) {
      const probe = await probeConsultCheckpoint({ reason: 'cancel', hold: 'native', replayCount: 3,
        nativeIsError: true, nativeDetails: { kind, model_called, ...(withId ? { task_id: 'owned-refusal' } : {}) } });
      verifyNativeEnvelope(probe, model_called);
      keep(`native-envelope-${kind}-${model_called}-${withId}`, probe);
    }
  }
  const interleavings = await runAccountingInterleavings(onRow);
  rows.push(...interleavings);
  return { status: 'passed', stages, physical_boundaries: physical,
    rebuild_boundaries: ['read', 'cancel', 'confirm'], terminal_branch_rows: 24, native_envelope_rows: 12,
    accounting_interleaving_rows: interleavings.length,
    native_teardown_rows: interleavings.filter(row => row.name.startsWith('native-teardown-')).length,
    rows, real_model_calls: 0 };
}
