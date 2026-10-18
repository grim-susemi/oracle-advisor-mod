import assert from 'node:assert/strict';
import test from 'node:test';
import { auxFamilies } from '../qa/verdict-aux.mjs';
import { probeConsultCheckpoint } from './helpers/consult-checkpoint-probe.mjs';
import { probeReservedConsult } from './helpers/consult-reservation-probe.mjs';
import { RECEIPT_FIELDS } from '../src/contracts.mjs';

const family = name => auxFamilies.find(row => row.family === name);
const check = observation => {
  const row = auxFamilies.find(row => row.cases.includes(observation.case));
  assert.ok(row, observation.case);
  for (const real of [false, true]) {
    row.admission(observation, { real });
    row.behavioral(observation, { real });
  }
};
const trigger = (name = 'trigger-real') => {
  const shell = name === 'trigger-real-powershell' ? 'powershell' : 'bash';
  const exits = name === 'trigger-success-between' ? [1, 0, 1] : [1, 1];
  const shell_args = exits.map(exit => shell === 'powershell' ? { command: `exit ${exit}`, timeout: 30 }
    : { command: `node -e "process.exit(${exit})"`, description: 'owned trigger QA', timeout: 30, run_in_background: false });
  const records = [{ event: 'session_start', shell_surface: 'unmodified-installed-lead-tools' }];
  for (const [index, exit] of exits.entries()) records.push(
    { event: 'tool_call', tool_name: shell, tool_call_id: String(index), input: structuredClone(shell_args[index]) },
    { event: 'tool_result', tool_name: shell, tool_call_id: String(index), is_error: exit !== 0,
      structured_content: shell === 'powershell' ? { exit_code: exit } : null });
  if (name !== 'trigger-success-between') records.push({ event: 'trigger',
    tool_call_ids: ['0', '1'], error_class: shell === 'powershell' ? 'exit:1' : 'tool_error' });
  return { case: name, shell, shell_args, requested_exit_codes: exits,
    expected_triggers: name === 'trigger-success-between' ? 0 : 1,
    records: records.map(record => ({ ...record, cwd: '/owned', session_id: 'session' })) };
};
const nativeObservation = () => {
  const job = { job_id: 'J1', job_epoch: 1 }, request = { ...job, request_id: 'consult-1' };
  const result = { status: 'answered', verdict: 'CONTINUE' };
  const evidence = [
    { kind: 'session_start', entries: [] },
    { kind: 'ledger', record: { type: 'job_opened', ...job } },
    { kind: 'attempt', call_id: 'wrapper-1', name: 'qa_transport_run', input: {} },
    { kind: 'attempt', call_id: 'consult-1', parent_id: 'wrapper-1', name: 'oracle_consult', input: { kind: 'work' } },
    { kind: 'ledger', record: { type: 'consult_admitted', ...request } },
    { kind: 'attempt', call_id: 'native-1', parent_id: 'consult-1', name: 'task',
      input: { subagent_type: 'oracle', run_in_background: false } },
    { kind: 'executed', call_id: 'native-1', parent_id: 'consult-1', name: 'task', is_error: false,
      result: { details: { task_id: 'task-1', status: 'completed', run_epoch: 0, model_called: true, run_in_background: false } } },
    { kind: 'ledger', record: { type: 'consult_native_result', request_id: request.request_id, native_attempt: '1',
      native_result: { task_id: 'task-1', status: 'completed', run_epoch: 0, model_called: true, isError: false } } },
    { kind: 'ledger', record: { type: 'oracle_retired', ...job, oracle_task_id: 'task-1', confirmed: true } },
    { kind: 'ledger', record: { type: 'consult_finished', ...request, oracle_task_id: 'task-1', status: 'answered' } },
    { kind: 'executed', call_id: 'consult-1', parent_id: 'wrapper-1', name: 'oracle_consult', result: { details: structuredClone(result) } },
    { kind: 'executed', call_id: 'wrapper-1', name: 'qa_transport_run', result: { details: structuredClone(result) } },
  ];
  return {
    case: 'consult-real', events: evidence.map(record => ({ event: 'evidence', ...record })),
    oracle_mode: 'mock', consults: [{ call_id: 'consult-1', result: { details: structuredClone(result) } }],
    receipts: [{ ...Object.fromEntries(RECEIPT_FIELDS.map(field => [field, null])),
      ...request, oracle_task_id: 'task-1', status: 'answered', usage_status: 'unknown' }],
    retired_records: [{ task_id: 'task-1', status: 'completed', residency_state: 'persisted_only' }],
    status_before_end: { native_calls: [{ name: 'task', parent: 'consult-1' }] },
    provider_calls: [{ model: 'oracle' }],
  };
};
const transportObservation = () => {
  const observation = nativeObservation();
  const native = observation.events.find(event => event.kind === 'executed' && event.name === 'task');
  Object.assign(native.result.details, { status: 'running', run_in_background: true });
  observation.events.find(event => event.record?.type === 'consult_native_result').record.native_result.status = 'running';
  const promotion = { event: 'native_task_returned', name: 'task', call_id: native.call_id,
    parent: native.parent_id, details: structuredClone(native.result.details), isError: false };
  observation.events.splice(observation.events.indexOf(native) + 1, 0, promotion);
  const finished = observation.events.find(event => event.record?.type === 'consult_finished').record;
  Object.assign(finished, { main_cache_wait_exceeded: true, engine_delivers_completion: true });
  return Object.assign(observation, {
    case: 'consult-cache-budget', decision: { live_residency: 'disabled' },
    consults: [{ request_id: 'consult-1', toolCallId: 'wrapper-1', oracle_task_id: 'task-1',
      status: 'answered', main_cache_wait_exceeded: true, engine_delivers_completion: true }],
    prompt_cache: { safetyBufferSeconds: 299 }, promotion_events: [structuredClone(promotion)],
    mock_provider_calls: [{ model: 'oracle' }],
  });
};
const lifecycleObservation = () => {
  const job = { job_id: 'J1', job_epoch: 1, status: 'active', retire_pending: false, consults: {} };
  const state = { job }, entries = [{ data: { type: 'job_opened', job_id: 'J1', job_epoch: 1 } }];
  const initial = { session_id: 'session', generation: 1, registered_commands: ['oracle'] };
  const events = [{ event: 'evidence', kind: 'session_start', entries: [] },
    { event: 'session_start', ...initial }];
  const snapshot = (event, extra = {}) => ({ event, ...initial, state: structuredClone(state),
    entries: structuredClone(entries), ...extra });
  let sequence = 0;
  const command = (args, result, ledger) => {
    const command_id = String(++sequence);
    events.push({ event: 'evidence', kind: 'command_start', command_id, name: 'oracle', args });
    if (ledger) events.push({ event: 'evidence', kind: 'ledger', record: ledger });
    events.push(snapshot('command', { command: 'oracle', args, result: structuredClone(result) }));
    events.push({ event: 'evidence', kind: 'command_end', command_id, name: 'oracle', args, result });
  };
  command('on', { status: 'active' }, entries[0].data);
  command('status', { status: 'status' });
  events.push(snapshot('session_start', { generation: 2 }));
  command('status', { status: 'status' });
  for (const args of ['on extra', 'nonsense', 'override missing short']) command(args, { status: 'invalid_arguments' });
  job.consults['qa-interrupted'] = { status: 'running' };
  entries.push({ data: { type: 'consult_started', request_id: 'qa-interrupted', job_id: 'J1', job_epoch: 1 } });
  events.push(snapshot('fixture', { args: 'begin' }));
  job.consults['qa-interrupted'].status = 'interrupted';
  entries.push({ data: { type: 'consult_interrupted', request_id: 'qa-interrupted', job_id: 'J1', job_epoch: 1 } });
  events.push(snapshot('session_start', { generation: 3 }), snapshot('session_start', { generation: 4 }));
  command('cancel', { status: 'no_consult_running' });
  job.status = 'closed';
  entries.push({ data: { type: 'job_ended', job_id: 'J1', job_epoch: 1 } });
  command('end', { status: 'closed' }, entries.at(-1).data);
  return { case: 'lifecycle', initial, events, provider_calls: [{ model: 'main' }], tool_calls: [] };
};

test('auxiliary families expose both predicates and evidence contracts', () => {
  for (const row of auxFamilies) {
    assert.equal(typeof row.admission, 'function');
    assert.equal(typeof row.behavioral, 'function');
    assert.ok(row.cases.length);
    assert.ok(row.todos.length);
    assert.ok(row.evidence_fields.length);
  }
});

test('trigger verdict requires serial matching IDs rather than matching counts', () => {
  check(trigger());
  for (const mutate of [
    o => { o.records[2].tool_call_id = 'unrelated'; },
    o => { o.records[3].tool_call_id = '0'; },
    o => { o.records[5].tool_call_ids = ['0', 'unrelated']; },
    o => { [o.records[2], o.records[3]] = [o.records[3], o.records[2]]; },
    o => { o.records[4].session_id = 'other-session'; },
    o => { o.records[3].cwd = '/other'; },
  ]) {
    const observation = trigger();
    mutate(observation);
    assert.throws(() => check(observation));
  }
});

test('checkpoint predicates retain cancellation assertions and reject unrelated admission', async () => {
  const probe = await probeConsultCheckpoint({ reason: 'cancel', hold: 'dossier' });
  const observation = { case: 'consult-cancel-save', probe };
  check(observation);
  const unrelated = structuredClone(observation);
  unrelated.probe.admission_before_microtask.request_id = 'other';
  assert.throws(() => family('consult-checkpoint').admission(unrelated, {}));
  const stale = structuredClone(observation);
  stale.probe.result.verdict = 'STOP';
  assert.throws(() => family('consult-checkpoint').behavioral(stale, {}));
  const reordered = structuredClone(observation);
  const index = reordered.probe.events.findIndex(record => record.request_id ===
    reordered.probe.admission_before_microtask.request_id && ['consult_finished', 'consult_interrupted'].includes(record.type));
  assert.ok(index >= 0);
  reordered.probe.events.unshift(...reordered.probe.events.splice(index, 1));
  assert.throws(() => family('consult-checkpoint').admission(reordered, {}));
});

test('reservation predicates join receipt and ledger by request and job IDs', async () => {
  const observation = { case: 'consult-cancel-reserved',
    probe: await probeReservedConsult('consult-cancel-reserved') };
  check(observation);
  const unrelated = structuredClone(observation);
  unrelated.probe.receipts.at(-1).request_id = 'unrelated';
  assert.throws(() => family('consult-reservation').admission(unrelated, {}));
  const paid = structuredClone(observation);
  paid.probe.final_consult_record.counted = true;
  assert.throws(() => family('consult-reservation').behavioral(paid, {}));
});

test('native facts cannot be replaced by a cleanup or a second capture', async () => {
  const probe = await probeConsultCheckpoint({ reason: 'cancel', hold: 'native', replayCount: 2,
    nativeIsError: true, nativeDetails: { kind: 'lane_capacity', model_called: false, task_id: 'owned-refusal' } });
  const observation = { case: 'consult-native-rejection', raw_probes: [{ probe, model_called: false }] };
  const row = family('consult-lifecycle');
  row.admission(observation, {});
  const changed = structuredClone(observation);
  changed.raw_probes[0].probe.consult.model_called = true;
  assert.throws(() => row.admission(changed, {}));
  const duplicated = structuredClone(observation);
  const capture = duplicated.raw_probes[0].probe.events.find(record => record.type === 'consult_native_result');
  duplicated.raw_probes[0].probe.events.push(structuredClone(capture));
  assert.throws(() => row.admission(duplicated, {}));
});

test('consult verdict rejects cross-request receipts and cross-parent native calls', () => {
  check(nativeObservation());
  for (const mutate of [
    o => { o.receipts[0].request_id = 'other-request'; },
    o => { o.receipts[0].job_id = 'other-job'; },
    o => { o.events.find(event => event.call_id === 'native-1').parent_id = 'wrapper-1'; },
    o => { o.retired_records[0].task_id = 'other-task'; },
    o => { o.events = o.events.filter(event => event.record?.type !== 'job_opened'); },
    o => { o.events.find(event => event.kind === 'executed' && event.name === 'task').result.details.task_id = 'other-task'; },
    o => { o.events.find(event => event.record?.type === 'consult_admitted').record.job_epoch = 2; },
    o => { o.events.find(event => event.record?.type === 'consult_native_result').record.job_id = 'other-job'; },
    o => { o.events.find(event => event.record?.type === 'consult_native_result').record.job_epoch = 2; },
    o => { o.events.find(event => event.record?.type === 'oracle_retired').record.job_id = 'other-job'; },
    o => { o.events.find(event => event.record?.type === 'oracle_retired').record.job_epoch = 2; },
    o => { o.events = o.events.filter(event => event.record?.type !== 'oracle_retired'); },
    o => { o.receipts.push(structuredClone(o.receipts[0])); },
    o => { o.events.push(structuredClone(o.events.find(event => event.record?.type === 'consult_admitted'))); },
    o => { o.events.push(structuredClone(o.events.find(event => event.record?.type === 'consult_finished'))); },
    o => { o.events.push(structuredClone(o.events.find(event => event.record?.type === 'consult_native_result'))); },
    o => { o.retired_records.push(structuredClone(o.retired_records[0])); },
    o => { o.events = o.events.filter(event => !(event.kind === 'executed' && event.name === 'task')); },
    o => { o.events.find(event => event.record?.type === 'consult_native_result').record.native_result.status = 'failed'; },
    o => { o.events.find(event => event.kind === 'executed' && event.name === 'task').result.details.model_called = false; },
    o => { o.events.push({ event: 'evidence', kind: 'attempt', call_id: 'other-consult', name: 'oracle_consult', input: {} }); },
    o => { o.events.push({ event: 'evidence', kind: 'attempt', call_id: 'orphan-native', name: 'task', input: { subagent_type: 'oracle' } }); },
    o => {
      o.events.find(event => event.kind === 'executed' && event.name === 'task').result.details.task_id = null;
      o.events.find(event => event.record?.type === 'consult_native_result').record.native_result.task_id = null;
      o.events.find(event => event.record?.type === 'consult_finished').record.oracle_task_id = null;
      o.receipts[0].oracle_task_id = null;
      o.retired_records = [];
    },
    o => { o.retired_records[0].status = 'cancelled'; },
    o => {
      o.consults[0].result.structuredContent = structuredClone(o.consults[0].result.details);
      o.consults[0].result.details.status = 'timed_out';
    },
    o => {
      const native = o.events.find(event => event.kind === 'executed' && event.name === 'task');
      o.events.push({ event: 'evidence', kind: 'attempt', call_id: 'other-native', name: 'task',
        input: { subagent_type: 'oracle' } }, { ...structuredClone(native), call_id: 'other-native', parent_id: null });
    },
    o => {
      const admitted = o.events.find(event => event.record?.type === 'consult_admitted');
      o.events.splice(o.events.indexOf(admitted), 0, { event: 'evidence', kind: 'ledger',
        record: { type: 'job_opened', job_id: 'J2', job_epoch: 1 } });
      for (const event of o.events) if (event.record?.job_id === 'J1' && event.record.type !== 'job_opened') event.record.job_id = 'J2';
      o.receipts[0].job_id = 'J2';
    },
  ]) {
    const observation = nativeObservation();
    mutate(observation);
    assert.throws(() => check(observation));
  }
});

test('transport verdict joins the wrapper, consult, native task, and retirement IDs', () => {
  const observation = transportObservation();
  check(observation);
  for (const mutate of [
    o => { o.consults[0].toolCallId = 'other-wrapper'; },
    o => { o.consults[0].request_id = 'other-request'; },
    o => { o.consults[0].oracle_task_id = 'other-task'; },
    o => { o.consults[0].status = 'timed_out'; },
    o => { o.events = o.events.filter(event => !(event.kind === 'executed' && event.name === 'oracle_consult')); },
    o => {
      o.events.find(event => event.record?.type === 'consult_finished').record.status = 'timed_out';
      o.events.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details.status = 'timed_out';
    },
    o => { o.consults[0].job_epoch = 2; },
    o => { o.events.find(event => event.record?.type === 'consult_finished').record.oracle_task_id = 'other-task'; },
  ]) {
    const changed = structuredClone(observation);
    mutate(changed);
    assert.throws(() => check(changed));
  }
});

test('cancelled transport retains native running facts and requires agreed consult status', () => {
  const observation = transportObservation();
  observation.case = 'shutdown-inflight';
  observation.consults[0].status = 'cancelled';
  observation.events.find(event => event.record?.type === 'consult_finished').record.status = 'cancelled';
  observation.events.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details.status = 'cancelled';
  observation.retired_records[0].status = 'cancelled';
  observation.shutdown_event = { running: null };
  observation.shutdown_consult_result = structuredClone(observation.consults[0]);
  check(observation);
  observation.events.find(event => event.record?.type === 'consult_finished').record.status = 'interrupted';
  observation.events.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details.status = 'interrupted';
  assert.throws(() => check(observation));
});

test('shutdown cancellation admits a durable interrupted request without a completed consult hook', () => {
  const observation = transportObservation(), job = { job_id: 'J1', job_epoch: 1 };
  observation.case = 'shutdown-inflight';
  observation.consults[0].status = 'cancelled';
  const finished = observation.events.find(event => event.record?.type === 'consult_finished');
  Object.assign(finished.record, { status: 'interrupted', oracle_task_id: null,
    main_cache_wait_exceeded: false, engine_delivers_completion: false });
  observation.events = observation.events.filter(event => event !== finished &&
    !(event.kind === 'executed' && event.name === 'oracle_consult'));
  const native = observation.events.find(event => event.kind === 'attempt' && event.name === 'task');
  observation.events.splice(observation.events.indexOf(native) + 1, 0,
    { event: 'evidence', kind: 'ledger', record: { type: 'oracle_assigned', ...job,
      request_id: 'consult-1', oracle_task_id: 'task-1' } }, finished);
  observation.retired_records[0].status = 'cancelled';
  observation.shutdown_event = { event: 'shutdown_complete', running: null, state: { job } };
  observation.shutdown_consult_result = structuredClone(observation.consults[0]);
  observation.events.push({ event: 'evidence', kind: 'ledger', record: {
    type: 'consult_lifecycle_result', request_id: 'consult-1',
    lifecycle_result: { operation: 'dispose', status: 'fulfilled' } } }, structuredClone(observation.shutdown_event));
  check(observation);
  const missingDisposal = structuredClone(observation);
  missingDisposal.events = missingDisposal.events.filter(event => event.record?.type !== 'consult_lifecycle_result');
  assert.throws(() => check(missingDisposal));
  observation.consults[0].status = 'answered';
  assert.throws(() => check(observation));
});

test('a native refusal without a task ID supports only a non-answered consult', () => {
  const observation = nativeObservation();
  observation.oracle_mode = 'real';
  const native = observation.events.find(event => event.kind === 'executed' && event.name === 'task');
  native.result.details = { kind: 'lane_capacity', model_called: false };
  observation.events.find(event => event.record?.type === 'consult_native_result').record.native_result =
    { kind: 'lane_capacity', model_called: false, isError: false };
  const finished = observation.events.find(event => event.record?.type === 'consult_finished').record;
  Object.assign(finished, { status: 'unavailable', oracle_task_id: null });
  observation.events.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details = { status: 'unavailable' };
  observation.consults[0].result.details = { status: 'unavailable' };
  Object.assign(observation.receipts[0], { status: 'unavailable', oracle_task_id: null });
  observation.retired_records = [];
  observation.events = observation.events.filter(event => event.record?.type !== 'oracle_retired');
  check(observation);
  finished.status = 'answered';
  observation.events.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details = { status: 'answered', verdict: 'CONTINUE' };
  observation.consults[0].result.details = { status: 'answered', verdict: 'CONTINUE' };
  observation.receipts[0].status = 'answered';
  assert.throws(() => check(observation));
});

test('transport command snapshots cannot borrow a status span', () => {
  const observation = transportObservation();
  observation.events.push(
    { event: 'evidence', kind: 'command_start', command_id: 'status-1', name: 'oracle', args: 'status' },
    { event: 'command', args: 'status', state: { job: { job_id: 'J1', job_epoch: 1 } }, result: { status: 'status' } },
    { event: 'evidence', kind: 'command_end', command_id: 'status-1', name: 'oracle', args: 'status', result: { status: 'status' } });
  check(observation);
  observation.events = observation.events.filter(event => event.command_id !== 'status-1');
  assert.throws(() => check(observation));
});

test('trigger scenario expectations come from the case, not supplied summaries', () => {
  for (const name of ['trigger-real', 'trigger-success-between', 'trigger-real-powershell']) check(trigger(name));
  for (const mutate of [
    o => {
      o.requested_exit_codes = [0, 0];
      o.expected_triggers = 0;
      o.shell_args.forEach(args => { args.command = 'node -e "process.exit(0)"'; });
      o.records = o.records.filter(record => record.event !== 'trigger');
      for (const record of o.records) {
        if (record.event === 'tool_call') record.input.command = 'node -e "process.exit(0)"';
        if (record.event === 'tool_result') record.is_error = false;
      }
    },
    o => { o.case = 'trigger-success-between'; },
    o => { o.shell = 'powershell'; },
    o => {
      o.shell_args.forEach(args => { args.command = 'unrelated failing command'; });
      o.records.filter(record => record.event === 'tool_call').forEach(record => { record.input.command = 'unrelated failing command'; });
    },
  ]) {
    const observation = trigger();
    mutate(observation);
    assert.throws(() => check(observation));
  }
});

test('cache-budget admission needs the actual forced promotion and configuration', () => {
  check(transportObservation());
  for (const mutate of [
    o => { delete o.prompt_cache; },
    o => { o.prompt_cache.safetyBufferSeconds = 0; },
    o => { delete o.promotion_events; },
    o => { o.promotion_events[0].call_id = 'other-native'; },
    o => { o.promotion_events[0].parent = 'other-consult'; },
    o => { o.promotion_events[0].details.task_id = 'other-task'; },
    o => { o.promotion_events.push(structuredClone(o.promotion_events[0])); },
    o => { o.events = o.events.filter(event => event.event !== 'native_task_returned'); },
    o => { o.events.find(event => event.event === 'native_task_returned').details.status = 'failed'; },
    o => { o.events.find(event => event.kind === 'attempt' && event.name === 'task').input.run_in_background = true; },
    o => { o.events.find(event => event.kind === 'executed' && event.name === 'task').result.details.run_in_background = false; },
  ]) {
    const observation = transportObservation();
    mutate(observation);
    assert.throws(() => check(observation));
  }
});

test('lifecycle snapshots each require their own command span and job epoch', () => {
  check(lifecycleObservation());
  for (const mutate of [
    o => {
      const starts = o.events.filter(event => event.kind === 'command_start' && event.args === 'status');
      o.events = o.events.filter(event => event.command_id !== starts[1].command_id);
    },
    o => { o.events.find(event => event.event === 'command' && event.args === 'status').state.job.job_id = 'J2'; },
    o => { o.events.find(event => event.event === 'command' && event.args === 'status').state.job.job_epoch = 2; },
    o => { o.events.find(event => event.kind === 'command_start' && event.args === 'status').job_id = 'J2'; },
    o => { o.events.find(event => event.kind === 'command_end' && event.args === 'status').job_epoch = 2; },
    o => {
      const snapshot = o.events.find(event => event.event === 'command' && event.args === 'status');
      o.events.splice(o.events.indexOf(snapshot), 0, structuredClone(snapshot));
    },
    o => { o.events.find(event => event.event === 'command' && event.args === 'status').result.status = 'other'; },
  ]) {
    const observation = lifecycleObservation();
    mutate(observation);
    assert.throws(() => check(observation));
  }
});

test('absent job_opened epoch means one without relaxing explicit proof epochs', () => {
  const observation = nativeObservation();
  delete observation.events.find(event => event.record?.type === 'job_opened').record.job_epoch;
  check(observation);
  observation.events.find(event => event.record?.type === 'consult_finished').record.job_epoch = 2;
  assert.throws(() => check(observation));
});

test('a recorded epoch advancement scopes the complete consult proof', () => {
  const observation = nativeObservation();
  observation.events.splice(2, 0, { event: 'evidence', kind: 'ledger',
    record: { type: 'seed_bound', job_id: 'J1', job_epoch: 2 } });
  for (const event of observation.events) {
    if (event.record?.job_epoch === 1 && event.record.type !== 'job_opened') event.record.job_epoch = 2;
  }
  observation.receipts[0].job_epoch = 2;
  check(observation);
  const skipped = structuredClone(observation);
  for (const event of skipped.events) if (event.record?.job_epoch === 2) event.record.job_epoch = 3;
  skipped.receipts[0].job_epoch = 3;
  assert.throws(() => check(skipped));
  observation.events.find(event => event.record?.type === 'consult_native_result').record.job_epoch = 1;
  assert.throws(() => check(observation));
});

test('physical native reload is not mistaken for the cancellation-envelope contract', async () => {
  const probe = await probeConsultCheckpoint({ reason: 'reload', hold: 'native', replayCount: 2 });
  check({ case: 'consult-native-rejection', raw_probes: [{ probe }],
    property: { status: 'passed', rows: [{ name: 'physical-native-reload' }] },
    property_probes: [{ name: 'physical-native-reload', probe }] });
});
