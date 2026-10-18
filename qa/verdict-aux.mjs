import assert from 'node:assert/strict';
import { classifyOutcome } from '../src/triggers.mjs';
import { RECEIPT_FIELDS } from '../src/contracts.mjs';
import { commandForSnapshot, nativeOutcome, sameScope, scenarioFacts, summarizedCall, toolData } from './scenario-verdict.mjs';
import { verifyConsultLifetime, verifyTerminalBranchReplay,
  verifyNativeEnvelope, verifyRebuild } from '../test/helpers/consult-lifecycle-property.mjs';

const terminal = task => ['completed', 'failed', 'error', 'lost', 'cancelled', 'interrupted', 'timed_out'].includes(task.status);
const gone = task => terminal(task) && ['persisted_only', 'disposed'].includes(task.residency_state) &&
  !task.resident && !task.resident_session && !task.resident_handle;
const events = o => (o.events ?? []).map(event => event.data ?? event);
const facts = o => scenarioFacts(events(o));
const dataEntries = snapshot => (snapshot?.entries ?? []).map(entry => entry.data ?? entry);
const reasonStatus = {
  cancel: 'cancelled', branch: 'stale_reservation', reload: 'interrupted',
  seed: 'stale_reservation', policy: 'oracle_not_readonly', 'reload-other': 'interrupted',
};
function observed(o) {
  const f = facts(o);
  assert.ok(f.records.some(record => record.kind === 'session_start' && record.entries?.length === 0),
    'fresh observed session');
  assert.ok(f.integrity, 'unique call IDs and matching execution/command IDs');
  return f;
}
function opened(f, jobId) {
  const entry = f.ledgers.find(record => record.record.type === 'job_opened' &&
    record.job_id === jobId);
  assert.ok(entry, `observed job_opened ${jobId}`);
  return entry;
}
function requestEvidence(f, id, { noJob = false, answered = false } = {}) {
  const call = f.byId.get(id);
  assert.equal(call?.name, 'oracle_consult', `oracle_consult attempt ${id}`);
  const admissions = f.ledgers.filter(record => record.record.type === 'consult_admitted' &&
    record.record.request_id === id);
  const terminals = f.ledgers.filter(record => ['consult_finished', 'consult_interrupted'].includes(record.record.type) &&
    record.record.request_id === id);
  assert.equal(admissions.length, 1, `single admission ${id}`);
  assert.equal(terminals.length, 1, `single terminal ${id}`);
  const [admitted] = admissions, [finished] = terminals;
  assert.ok(call.index < admitted.index && admitted.index < finished.index, `request order ${id}`);
  assert.ok(sameScope(call, admitted) && sameScope(call, finished), `request job/epoch ${id}`);
  assert.ok(sameScope({ ...call, ...toolData(call) }, call), `execution result job/epoch ${id}`);
  if (answered || finished.record.status === 'answered') {
    assert.ok(call.execution, `completed consult ${id}`);
    assert.ok(finished.index < call.execution.index, `completed consult order ${id}`);
    assert.equal(finished.record.status, toolData(call).status, `executed terminal status ${id}`);
  } else if (toolData(call).status !== undefined) {
    assert.ok(finished.index < call.execution.index, `terminal consult order ${id}`);
    assert.equal(finished.record.status, toolData(call).status, `executed terminal status ${id}`);
  }
  if (noJob) {
    assert.equal(call.job_id, null);
    assert.equal(call.job_epoch, null);
    assert.equal(call.active, false);
  } else {
    assert.equal(call.active, true);
    const opening = opened(f, call.job_id);
    assert.ok(opening.index < call.index);
    let epoch = opening.job_epoch;
    for (const entry of f.ledgers.filter(entry => entry.job_id === call.job_id &&
      opening.index < entry.index && entry.index < call.index &&
      ['seed_bound', 'job_resumed'].includes(entry.record.type))) {
      if (entry.record.job_epoch === undefined) continue;
      assert.ok(entry.job_epoch === epoch || entry.job_epoch === epoch + 1, `ordered epoch transition ${id}`);
      epoch = entry.job_epoch;
    }
    assert.equal(call.job_epoch, epoch, `observed request epoch ${id}`);
  }
  return { call, admitted, finished };
}
function nativeTaskEvidence(f, { call, admitted, finished }) {
  const requestId = call.call_id;
  const native = f.calls.filter(call => call.name === 'task' && call.parent_id === requestId);
  assert.equal(native.length, 1, `single native dispatch ${requestId}`);
  assert.equal(native[0].input?.subagent_type, 'oracle');
  assert.ok(native[0].execution, `executed native dispatch ${requestId}`);
  assert.ok(sameScope(native[0], call), `native dispatch job/epoch ${requestId}`);
  const captures = f.ledgers.filter(record => record.record.type === 'consult_native_result' &&
    record.record.request_id === requestId);
  assert.equal(captures.length, 1, `write-once native capture ${requestId}`);
  const [capture] = captures, execution = native[0].execution;
  assert.equal(String(capture.record.native_attempt), '1');
  assert.ok(sameScope(capture, call), `native capture job/epoch ${requestId}`);
  assert.ok(admitted.index < native[0].index && native[0].index < finished.index &&
    execution.index < capture.index, `native capture follows execution ${requestId}`);
  if (finished.record.status === 'answered') assert.ok(capture.index < finished.index,
    `answered terminal follows native capture ${requestId}`);
  // Captures preserve a defined subset of the raw native envelope, not a
  // cleanup/status read and not the eventual consult result.
  const raw = nativeOutcome(native[0]);
  assert.deepEqual(capture.record.native_result, raw, `canonical native facts ${requestId}`);
  const taskId = raw.task_id;
  assert.equal(toolData(native[0]).task_id, taskId);
  if (finished.record.oracle_task_id != null || finished.record.status === 'answered') {
    assert.equal(taskId ?? null, finished.record.oracle_task_id ?? null, `terminal native task ID ${requestId}`);
  } else if (taskId) {
    const assignments = f.ledgers.filter(entry => entry.record.type === 'oracle_assigned' &&
      entry.record.request_id === requestId && entry.record.oracle_task_id === taskId);
    assert.equal(assignments.length, 1, `inflight native assignment ${requestId}`);
    assert.ok(sameScope(assignments[0], call) && native[0].index < assignments[0].index &&
      assignments[0].index < finished.index, `inflight assignment job/epoch ${requestId}`);
  }
  if (taskId) assert.equal(f.calls.filter(other => other.name === 'task' &&
    toolData(other).task_id === taskId).length, 1, `unique native task ${taskId}`);
  return native[0];
}
function retirementEvidence(o, f, request, native) {
  const taskId = toolData(native).task_id;
  if (request.finished.record.status === 'answered') assert.ok(typeof taskId === 'string' && taskId.length,
    'answered consult has a named native task');
  if (!taskId) return;
  const snapshots = o.retired_records.filter(task => task.task_id === taskId);
  assert.equal(snapshots.length, 1, `unique retired task ${taskId}`);
  assert.ok(gone(snapshots[0]), `retired native task ${taskId}`);
  if (request.finished.record.status === 'answered') assert.equal(snapshots[0].status, 'completed');
  assert.ok(sameScope({ ...request.call, ...snapshots[0] }, request.call), `retired task job/epoch ${taskId}`);
  const retirements = f.ledgers.filter(record => record.record.type === 'oracle_retired' &&
    record.record.oracle_task_id === taskId);
  assert.ok(retirements.length && retirements.every(record => sameScope(record, request.call) &&
    record.record.confirmed === true && record.index > native.index), `confirmed scoped retirement ${taskId}`);
}
function commandSnapshots(o, args) {
  const f = facts(o), snapshots = events(o).filter(event => event.event === 'command');
  const commands = snapshots.map(snapshot => {
    const command = commandForSnapshot(f, snapshot);
    assert.equal(command.name, 'oracle');
    for (const boundary of [command, command.end]) assert.ok(sameScope({
      ...boundary, ...f.events[boundary.index],
    }, boundary), `explicit command job/epoch ${snapshot.args}`);
    assert.deepEqual(snapshot.result, command.end.result, `command result ${snapshot.args}`);
    if (command.args !== 'on') assert.ok(sameScope(command, command.end), `command job/epoch ${snapshot.args}`);
    else assert.ok(f.ledgers.some(entry => entry.record.type === 'job_opened' &&
      sameScope(entry, command.end) && command.index < entry.index && entry.index < command.end.index));
    return command.command_id;
  });
  assert.equal(new Set(commands).size, snapshots.length, 'one snapshot per command span');
  return snapshots.filter(snapshot => snapshot.args === args);
}
function commandSnapshot(o, args) {
  const snapshots = commandSnapshots(o, args);
  assert.equal(snapshots.length, args === 'status' ? 2 : 1, `command snapshots ${args}`);
  return snapshots[0];
}
function lifecycleAdmission(o) {
  const f = observed(o), es = events(o);
  assert.ok(es.some(event => event.event === 'session_start' && event.session_id === o.initial?.session_id));
  if (o.case !== 'lifecycle-killswitch') {
    const on = commandSnapshot(o, 'on');
    opened(f, on.state.job.job_id);
    assert.equal(on.session_id, o.initial.session_id);
    for (const args of ['status', 'on extra', 'nonsense', 'override missing short', 'cancel', 'end']) {
      const snapshot = commandSnapshot(o, args);
      assert.equal(snapshot.state.job.job_id, on.state.job.job_id);
      assert.equal(snapshot.session_id, on.session_id);
    }
    const start = es.find(event => event.event === 'fixture' && event.args === 'begin');
    assert.ok(start?.state.job.consults['qa-interrupted']);
    const admitted = dataEntries(start).find(record => record.type === 'consult_started' &&
      record.request_id === 'qa-interrupted');
    assert.equal(admitted?.job_id, on.state.job.job_id);
    assert.equal(admitted?.job_epoch, on.state.job.job_epoch);
  } else assert.ok(es.some(event => event.event === 'fixture' && event.args === 'snapshot'));
  return true;
}
function lifecycleBehavior(o) {
  const es = events(o), started = o.initial;
  if (o.case === 'lifecycle-killswitch') {
    assert.deepEqual(started.registered_commands, []);
    assert.equal(started.state, null);
    assert.deepEqual(es.find(event => event.event === 'fixture' && event.args === 'snapshot').entries, []);
    assert.equal(o.disabled_receipts.length, 1);
    assert.equal(o.disabled_receipts[0].status, 'disabled-by-env');
  } else {
    assert.deepEqual(started.registered_commands, ['oracle']);
    const on = commandSnapshot(o, 'on');
    assert.equal(dataEntries(on).at(-1).type, 'job_opened');
    assert.equal(on.state.job.job_id, 'J1');
    const statuses = commandSnapshots(o, 'status');
    assert.equal(statuses.length, 2);
    const [before, after] = statuses;
    assert.deepEqual(after.state, before.state);
    assert.equal(after.session_id, before.session_id);
    const reloads = es.filter(event => event.event === 'session_start');
    assert.ok(reloads[1].generation > started.generation);
    for (const input of ['on extra', 'nonsense', 'override missing short']) {
      const result = commandSnapshot(o, input);
      assert.equal(result.result.status, 'invalid_arguments');
      assert.deepEqual(result.state, after.state);
      assert.equal(result.entries.length, after.entries.length);
    }
    const inflight = es.find(event => event.event === 'fixture' && event.args === 'begin');
    assert.equal(inflight.state.job.consults['qa-interrupted'].status, 'running');
    const [resumed, again] = reloads.slice(-2);
    assert.equal(resumed.state.job.consults['qa-interrupted'].status, 'interrupted');
    for (const snapshot of [resumed, again]) assert.equal(dataEntries(snapshot)
      .filter(record => record.type === 'consult_interrupted' && record.request_id === 'qa-interrupted').length, 1);
    assert.deepEqual(again.state, resumed.state);
    const boundary = es.findIndex(event => event === again);
    assert.equal(es.slice(0, boundary).filter(event => event.event === 'provider_request').length, 0);
    assert.equal(commandSnapshot(o, 'cancel').result.status, 'no_consult_running');
    const ended = commandSnapshot(o, 'end');
    assert.equal(dataEntries(ended).at(-1).type, 'job_ended');
    assert.equal(ended.state.job.status, 'closed');
    assert.equal(ended.state.job.retire_pending, false);
  }
  assert.ok(o.provider_calls.length >= 1);
  assert.ok(o.provider_calls.every(call => call.model !== 'oracle'));
  assert.ok(o.tool_calls.every(call => call.name === 'qa_lifecycle_probe'));
  return true;
}
const triggerScenarios = {
  'trigger-real': { shell: 'bash', exits: [1, 1], triggers: 1 },
  'trigger-success-between': { shell: 'bash', exits: [1, 0, 1], triggers: 0 },
  'trigger-real-powershell': { shell: 'powershell', exits: [1, 1], triggers: 1 },
};
function triggerAdmission(o) {
  const expected = triggerScenarios[o.case];
  assert.equal(o.shell, expected.shell);
  assert.deepEqual(o.requested_exit_codes, expected.exits);
  assert.equal(o.expected_triggers, expected.triggers);
  const records = o.records;
  const session = records.find(record => record.event === 'session_start');
  assert.ok(session?.session_id);
  assert.equal(typeof session.cwd, 'string');
  assert.equal(session.shell_surface, 'unmodified-installed-lead-tools');
  const calls = records.filter(record => record.event === 'tool_call' && record.tool_name === o.shell);
  const results = records.filter(record => record.event === 'tool_result' && record.tool_name === o.shell);
  assert.equal(calls.length, expected.exits.length);
  assert.equal(results.length, calls.length);
  assert.equal(new Set(calls.map(call => call.tool_call_id)).size, calls.length);
  for (const [index, call] of calls.entries()) {
    assert.ok(call.tool_call_id);
    assert.equal(call.session_id, session.session_id);
    assert.equal(call.cwd, session.cwd);
    const matches = results.filter(result => result.tool_call_id === call.tool_call_id);
    assert.equal(matches.length, 1, `result ID ${call.tool_call_id}`);
    assert.equal(matches[0].session_id, session.session_id);
    assert.equal(matches[0].cwd, call.cwd);
    assert.ok(records.indexOf(call) < records.indexOf(matches[0]));
    if (index) {
      const prior = results.find(result => result.tool_call_id === calls[index - 1].tool_call_id);
      assert.ok(records.indexOf(prior) < records.indexOf(call), 'serial shell results');
    }
  }
  return true;
}
function triggerBehavior(o) {
  const calls = o.records.filter(record => record.event === 'tool_call' && record.tool_name === o.shell);
  const results = calls.map(call => o.records.find(record => record.event === 'tool_result' &&
    record.tool_call_id === call.tool_call_id));
  const triggers = o.records.filter(record => record.event === 'trigger');
  const { exits, triggers: expectedTriggers } = triggerScenarios[o.case];
  assert.deepEqual(results.map(record => record.is_error), exits.map(exit => exit !== 0));
  assert.deepEqual(calls.map(record => record.input.command), o.shell_args.map(args => args.command));
  assert.deepEqual(calls.map(record => record.input), exits.map(exit => o.shell === 'powershell'
    ? { command: `exit ${exit}`, timeout: 30 }
    : { command: `node -e "process.exit(${exit})"`, description: 'owned trigger QA', timeout: 30, run_in_background: false }));
  assert.deepEqual(calls[0].input, calls.at(-1).input, 'full canonical failure args');
  assert.deepEqual(results.map(record => classifyOutcome({
    structuredContent: record.structured_content, isError: record.is_error,
  }).error_class), exits.map(exit => exit === 0 ? null : o.shell === 'powershell' ? 'exit:1' : 'tool_error'));
  if (o.shell === 'powershell') assert.deepEqual(results.map(record => record.structured_content?.exit_code ?? null), exits);
  else assert.ok(results.every(record => record.structured_content === null));
  assert.equal(triggers.length, expectedTriggers);
  if (expectedTriggers) {
    assert.equal(triggers[0].error_class, o.shell === 'powershell' ? 'exit:1' : 'tool_error');
    assert.equal(triggers[0].session_id, calls[0].session_id);
    assert.deepEqual(triggers[0].tool_call_ids, calls.map(call => call.tool_call_id));
    assert.ok(o.records.indexOf(triggers[0]) > o.records.indexOf(results.at(-1)));
  }
  return true;
}
function controlledHoldEvidence(o, f, call, native) {
  assert.equal(o.oracle_mode, 'mock', 'resident-stuck requires the controlled mock oracle route');
  const taskId = toolData(native).task_id;
  const requests = o.mock_provider_calls ?? [];
  const identities = requests.map(request => request.provider_request_id ?? request.index);
  assert.ok(identities.every(id => typeof id === 'string' && id.length || Number.isSafeInteger(id)));
  assert.equal(new Set(identities).size, requests.length, 'unique raw provider request identities');
  const matching = requests.filter(request => {
    if (request.model !== 'oracle' || typeof request.text !== 'string') return false;
    let text = request.text;
    if (text.startsWith('[')) {
      try { text = JSON.parse(text).map(part => part.text ?? '').join('\n'); }
      catch { return false; }
    }
    return text.match(/(?:^|\n)Task id: ([^\s.]+)\./)?.[1] === taskId &&
      typeof native.input.prompt === 'string' && native.input.prompt.includes('QA_TRANSPORT_HOLD') &&
      text.includes(native.input.prompt);
  });
  assert.equal(matching.length, 1, `raw controlled provider request for ${call.call_id}`);
  const [provider] = matching;
  assert.equal(provider.ended_at, undefined, 'controlled stream did not answer');
  const cancels = f.calls.filter(cancel => cancel.name === 'task_cancel' &&
    cancel.input?.task_id === taskId && sameScope(cancel, call) && native.index < cancel.index);
  assert.ok(cancels.length, 'owned native cancellation after hold');
  const cancelIndex = cancels[0].index;
  const assignments = f.ledgers.filter(entry => entry.record.type === 'oracle_assigned' &&
    entry.record.request_id === call.call_id && entry.record.oracle_task_id === taskId);
  assert.equal(assignments.length, 1, 'unique actual in-flight native assignment');
  assert.ok(sameScope(assignments[0], call) && native.index < assignments[0].index &&
    assignments[0].index < cancelIndex, 'held task assigned to exact request/job/epoch before cancel');
  if (provider.provider_request_id) {
    assert.ok(Number.isFinite(provider.held_at), 'raw provider held event');
    const holds = f.events.filter(event => event.event === 'provider_hold' &&
      event.provider_request_id === provider.provider_request_id);
    assert.equal(holds.length, 1, 'unique trusted provider hold observation');
    const [hold] = holds;
    assert.equal(hold.source, 'qa.transport-provider');
    assert.equal(hold.request_id, call.call_id);
    assert.equal(hold.call_id, native.call_id);
    assert.equal(hold.task_id, taskId);
    assert.ok(sameScope(hold, call), 'provider hold job/epoch');
    assert.ok(native.index < f.events.indexOf(hold) && f.events.indexOf(hold) < cancelIndex,
      'provider hold observed before native cancellation');
  } else {
    // Preserved native receipts predate the provider event schema. Their raw
    // provider request and actual native snapshot still prove the same hold;
    // a mode/fixture label, or a projected consult result, cannot substitute.
    assert.ok(f.calls.some(read => read.name === 'task_output' && read.input?.task_id === taskId &&
      read.execution && sameScope(read, call) && native.index < read.index &&
      read.execution.index < cancelIndex && !read.execution.is_error &&
      toolData(read).snapshot?.task_id === taskId && toolData(read).snapshot.status === 'running' &&
      toolData(read).snapshot.model === 'oracle-qa-mock/oracle'),
    'raw controlled native running snapshot before cancellation');
  }
}
function transportAdmission(o) {
  const f = observed(o);
  commandSnapshots(o);
  assert.equal(o.consults.length, {
    'resident-3': 3, 'resident-dead': 2, 'resident-stuck': 3, 'shutdown-inflight': 1,
    'consult-cache-budget': 1, 'cancel-after-promotion': 3, 'answered-error-words': 4,
  }[o.case]);
  assert.equal(new Set(o.consults.map(result => result.request_id)).size, o.consults.length);
  assert.equal(new Set(o.consults.map(result => result.toolCallId)).size, o.consults.length);
  assert.equal(f.calls.filter(call => call.name === 'oracle_consult').length, o.consults.length);
  assert.ok(f.calls.filter(call => call.name === 'task' && call.input?.subagent_type === 'oracle')
    .every(call => o.consults.some(result => result.request_id === call.parent_id)), 'no orphan oracle dispatch');
  for (const result of o.consults) {
    const request = requestEvidence(f, result.request_id, { answered: result.status === 'answered' });
    const { call, finished } = request;
    const wrapper = f.byId.get(call.parent_id);
    assert.equal(wrapper?.name, 'qa_transport_run');
    assert.equal(wrapper.call_id, result.toolCallId);
    assert.ok(sameScope(wrapper, call) && sameScope({ ...call, ...result }, call), `transport job/epoch ${call.call_id}`);
    const native = nativeTaskEvidence(f, request);
    assert.equal(result.oracle_task_id ?? null, toolData(native).task_id ?? null);
    if (o.case === 'resident-stuck' && result !== o.consults[0]) controlledHoldEvidence(o, f, call, native);
    if (result.status === 'cancelled' && finished.record.status === 'interrupted') {
      // Shutdown durably interrupts the request before the transport finishes
      // cancelling its native child. These are separate terminal outcomes.
      const shutdowns = f.events.filter(event => event.event === 'shutdown_complete' &&
        event.running === null && sameScope(event.state?.job, call));
      assert.equal(shutdowns.length, 1, 'observed shutdown for interrupted cancellation');
      assert.ok(f.ledgers.some(entry => entry.record.type === 'consult_lifecycle_result' &&
        entry.record.request_id === call.call_id && sameScope(entry, call) &&
        entry.record.lifecycle_result?.operation === 'dispose' && entry.record.lifecycle_result.status === 'fulfilled' &&
        finished.index < entry.index && entry.index < f.events.indexOf(shutdowns[0])), 'completed shutdown disposal');
      assert.equal(o.retired_records.find(task => task.task_id === result.oracle_task_id)?.status, 'cancelled');
    } else assert.equal(result.status, finished.record.status, `transport terminal status ${call.call_id}`);
    if (result.status === 'answered') {
      for (const key of ['path', 'oracle_run_epoch', 'main_cache_wait_exceeded', 'engine_delivers_completion']) {
        if (Object.hasOwn(finished.record, key)) assert.deepEqual(result[key], finished.record[key], `transport ${key}`);
      }
    }
    assert.ok(native.index < finished.index);
    retirementEvidence(o, f, request, native);
  }
  if (['consult-cache-budget', 'cancel-after-promotion'].includes(o.case)) {
    assert.equal(o.prompt_cache?.safetyBufferSeconds, 299, 'forced small prompt-cache wait configuration');
    assert.equal(o.promotion_events?.length, o.consults.length, 'actual native promotions');
    assert.equal(new Set(o.promotion_events.map(event => event.call_id)).size, o.consults.length);
    for (const promotion of o.promotion_events) {
      assert.equal(promotion.event, 'native_task_returned');
      const native = f.byId.get(promotion.call_id);
      assert.equal(native?.name, 'task');
      const result = o.consults.find(result => result.request_id === native.parent_id);
      assert.ok(result, 'promotion belongs to an admitted consult');
      assert.equal(promotion.parent, native.parent_id);
      assert.equal(promotion.details.task_id, result.oracle_task_id);
      assert.deepEqual(promotion.details, native.execution.result.details);
      assert.equal(promotion.isError, native.execution.is_error);
      assert.equal(native.input.run_in_background, false, 'foreground dispatch was promoted');
      assert.equal(promotion.details.run_in_background, true);
      assert.equal(promotion.details.status, 'running');
      const raw = f.events.filter(event => event.event === 'native_task_returned' && event.call_id === native.call_id);
      assert.equal(raw.length, 1, 'unique raw promotion event');
      assert.deepEqual(raw[0], promotion);
      const capture = f.ledgers.find(record => record.record.type === 'consult_native_result' &&
        record.record.request_id === native.parent_id);
      assert.ok(native.execution.index < f.events.indexOf(raw[0]) &&
        f.events.indexOf(raw[0]) < capture.index, 'promotion follows actual native execution');
    }
  }
  return true;
}
function transportBehavior(o) {
  assert.equal(o.decision.live_residency, 'disabled');
  if (o.case === 'resident-3') {
    assert.deepEqual(o.consults.map(result => result.path), ['spawn', 'spawn', 'spawn']);
    assert.deepEqual(o.consults.map(result => result.dossier_prior_ids),
      [[], [o.consults[0].request_id], o.consults.slice(0, 2).map(result => result.request_id)]);
  } else if (o.case === 'resident-dead') {
    assert.equal(o.consults[1].path, 'spawn');
    assert.equal(o.dead_target.oracle_task_id, o.consults[0].oracle_task_id);
    assert.equal(o.dead_target.result.oracle_task_id, o.dead_target.oracle_task_id);
    assert.equal(o.dead_target.result.confirmed, true);
    assert.ok(gone(o.dead_target.result.task));
    assert.ok(facts(o).ledgers.some(entry => entry.record.type === 'oracle_retired' &&
      entry.record.reason === 'qa_dead_target' && entry.record.confirmed === true &&
      entry.record.oracle_task_id === o.dead_target.oracle_task_id));
  } else if (o.case === 'resident-stuck') {
    assert.deepEqual(o.consults.map(result => result.status), ['answered', 'cancelled', 'cancelled']);
  } else if (o.case === 'shutdown-inflight') {
    assert.equal(o.consults[0].status, 'cancelled');
    assert.equal(o.shutdown_event.running, null);
  } else if (o.case === 'consult-cache-budget') {
    assert.equal(o.consults[0].status, 'answered');
    assert.equal(o.consults[0].main_cache_wait_exceeded, true);
    assert.equal(o.consults[0].engine_delivers_completion, true);
  } else if (o.case === 'cancel-after-promotion') {
    assert.equal(o.after_cancel.running, null);
    assert.equal(o.after_cancel.nativeCalls.filter(call => call.name === 'task_cancel').length, 1);
    assert.ok(o.consults.every(result => result.status === 'cancelled' &&
      result.model_called && result.engine_delivers_completion && result.main_cache_wait_exceeded));
    assert.equal(o.shutdown_event.running, null);
    assert.equal(o.fixture_releases ?? 0, 0);
  } else if (o.case === 'answered-error-words') {
    for (const [index, result] of o.consults.entries()) {
      assert.equal(result.status, 'answered');
      assert.equal(result.answer, o.oracle_answers[index]);
      assert.equal(result.model_called, true);
    }
  }
  for (const promotion of o.promotion_events ?? []) assert.equal(promotion.details.run_in_background, true);
  if (o.shutdown_event) {
    assert.ok(o.shutdown_consult_result, 'durable cancelled consult result');
    assert.equal(o.shutdown_consult_result.request_id, o.consults.at(-1).request_id);
  }
  if (o.cancel_command) assert.equal(o.cancel_command.result.status, 'cancelled');
  if (o.before_end) {
    assert.ok(o.status_message.content.includes('live residency unavailable on this build'));
    assert.equal(o.before_end.nativeCalls.filter(call => call.name === 'task_send').length, 0);
    assert.equal(o.before_end.state.job.revival_failures?.length ?? 0, 0);
    assert.equal(o.before_end.state.job.residency, 'unavailable');
    assert.equal(o.ended.state.job.retire_pending, false);
  }
  assert.ok(o.retired_records.every(gone));
  if (o.oracle_mode === 'mock') assert.equal(o.mock_provider_calls.filter(request => request.model === 'oracle').length, o.consults.length);
  return true;
}
function consultAdmission(o) {
  const f = observed(o);
  const count = o.case === 'consult-cap' ? 5 : 1;
  assert.equal(o.consults.length, count);
  assert.equal(new Set(o.consults.map(item => item.call_id)).size, count);
  assert.equal(f.calls.filter(call => call.name === 'oracle_consult').length, count);
  assert.ok(f.calls.filter(call => call.name === 'task' && call.input?.subagent_type === 'oracle')
    .every(call => o.consults.some(item => item.call_id === call.parent_id)), 'no orphan oracle dispatch');
  for (const item of o.consults) {
    const request = requestEvidence(f, item.call_id, { noJob: o.case === 'consult-no-job' });
    const { call, finished } = request;
    assert.equal(summarizedCall(f, item, 'oracle_consult'), call);
    assert.deepEqual(toolData(call), item.result.details);
    assert.equal(finished.record.status, item.result.details.status);
    assert.ok(sameScope({ ...call, ...item }, call), `consult summary job/epoch ${item.call_id}`);
    const receipts = o.receipts.filter(record => record.request_id === item.call_id);
    assert.equal(receipts.length, 1, `receipt request ${item.call_id}`);
    const [receipt] = receipts;
    assert.ok(sameScope(receipt, finished), `receipt job/epoch ${item.call_id}`);
    assert.equal(receipt.status, finished.record.status);
    assert.equal(receipt.oracle_task_id ?? null, finished.record.oracle_task_id ?? null);
    const native = f.calls.filter(native => native.name === 'task' && native.parent_id === call.call_id);
    if (['no_active_job', 'oracle_not_readonly', 'cap_exhausted'].includes(item.result.details.status)) assert.equal(native.length, 0);
    else {
      const dispatch = nativeTaskEvidence(f, request);
      retirementEvidence(o, f, request, dispatch);
    }
  }
  return true;
}
function consultBehavior(o) {
  const results = o.consults.map(item => item.result.details);
  if (o.case === 'consult-real') {
    // Oracle semantics are not a transport verdict. Main mode does not relax
    // the deterministic mock-oracle requirement.
    if (o.oracle_mode === 'mock') assert.equal(results[0].status, 'answered');
    assert.ok(['answered', 'invalid', 'quota', 'unavailable', 'timed_out', 'oracle_dead'].includes(results[0].status));
    if (results[0].status === 'answered') assert.ok(['CONTINUE', 'REDIRECT', 'STOP'].includes(results[0].verdict));
  } else if (o.case === 'consult-cap') {
    assert.ok(results.slice(0, 4).every(item => item.status === 'answered'));
    assert.equal(results[4].status, 'cap_exhausted');
    assert.equal(results[4].calls_remaining, 0);
  } else if (o.case === 'consult-not-readonly') {
    assert.equal(results[0].status, 'oracle_not_readonly');
    assert.equal(results[0].calls_remaining, 4);
  } else assert.equal(results[0].status, 'no_active_job');
  assert.ok(o.retired_records.every(gone));
  for (const entry of o.receipts) {
    for (const field of RECEIPT_FIELDS) assert.ok(Object.hasOwn(entry, field), field);
    assert.ok(['actual', 'estimated', 'unknown'].includes(entry.usage_status));
  }
  assert.equal(o.receipts.length, o.consults.length);
  const expected = o.case === 'consult-cap' ? 4 : ['consult-no-job', 'consult-not-readonly'].includes(o.case) ? 0 : 1;
  assert.equal(o.status_before_end.native_calls.filter(call => call.name === 'task').length, expected);
  assert.equal(o.status_before_end.native_calls.filter(call => call.name === 'task_send').length, 0);
  if (o.oracle_mode === 'mock') assert.equal(o.provider_calls.filter(item => item.model === 'oracle').length, expected);
  return true;
}
function probeAdmission(probe) {
  const admission = probe.admission_before_microtask;
  const records = probe.events ?? probe.ledger_events;
  const first = records.find(record => record.type === 'consult_admitted');
  assert.ok(first?.request_id && first.job_id, 'durable request and job identity');
  assert.equal(first.request_id, admission?.request_id ?? probe.final_consult_record?.request_id);
  assert.equal(first.job_id, admission?.job_id ?? probe.final_consult_record?.job_id);
  const matching = records.filter(record => record.request_id === first.request_id);
  const terminals = matching.filter(record => ['consult_finished', 'consult_interrupted'].includes(record.type));
  assert.ok(terminals.length, 'terminal record for admitted request');
  for (const terminal of terminals) {
    assert.ok(records.indexOf(first) < records.indexOf(terminal), 'admission precedes terminal record');
    assert.equal(terminal.job_id, first.job_id);
  }
  assert.ok(probe.receipts.some(receipt => receipt.request_id === first.request_id && receipt.job_id === first.job_id),
    'receipt for admitted request/job');
  if (probe.consult) assert.equal(probe.consult.request_id, first.request_id);
  if (probe.final_consult_record) assert.equal(probe.final_consult_record.request_id, first.request_id);
  const captures = matching.filter(record => record.type === 'consult_native_result');
  assert.equal(new Set(captures.map(record => record.native_attempt)).size, captures.length,
    'write-once native attempt facts');
  for (const capture of captures) {
    const canonical = probe.consult ?? probe.final_consult_record ?? probe.requests?.[first.request_id];
    if (canonical) {
      assert.deepEqual(canonical.native_attempts?.[capture.native_attempt], capture.native_result);
      if (typeof capture.native_result.model_called === 'boolean') {
        assert.equal(canonical.model_called, capture.native_result.model_called);
        assert.equal(canonical.counted, capture.native_result.model_called);
      }
    }
  }
  return true;
}
function checkpointVerify(probe) {
  const called = probe.dispatches_at_abort === 1;
  assert.equal(probe.injected, true);
  assert.equal(probe.result.status, reasonStatus[probe.reason]);
  assert.equal(probe.result.verdict, undefined);
  assert.equal(probe.native_oracle_dispatches, probe.dispatches_at_abort);
  assert.equal(probe.reserved_slots, 0);
  assert.equal(probe.counters.consults, called ? 1 : 0);
  assert.equal(probe.result.calls_remaining, called ? 3 : 4);
  assert.equal(probe.stops.length, 0);
  assert.equal(probe.verdicts.length, probe.mode === 'replay' && probe.reason !== 'branch' ? 1 : 0);
  assert.equal(probe.analysis_exists, probe.analysis_at_abort);
  if (probe.consult) {
    assert.equal(probe.consult.status, probe.mode === 'replay' ? 'answered' : reasonStatus[probe.reason]);
    assert.equal(probe.consult.counted, called);
    assert.equal(probe.consult.model_called, called);
  }
  assert.ok(!probe.events_after_abort.some(event => event.type === 'consult_released' ||
    event.type === 'verdict_recorded' || event.type === 'stop_opened' || event.status === 'answered'));
  assert.equal(probe.cleanup.homes_removed, true);
}
function checkpointAdmission(o) {
  for (const probe of o.raw_probes ?? [o.probe]) probeAdmission(probe);
  return true;
}
function checkpointBehavior(o) {
  for (const probe of o.raw_probes ?? [o.probe]) {
    checkpointVerify(probe);
    if (o.case === 'consult-checkpoint-matrix') {
      assert.equal(probe.dispatches_after_replays, probe.native_oracle_dispatches);
      assert.ok(probe.replays.every(result => result.status === probe.result.status && !result.verdict));
    } else {
      assert.equal(probe.concurrent_second, 'busy');
      assert.deepEqual(probe.duplicate_result, probe.result);
      if (probe.reason === 'cancel') assert.equal(probe.action_results[0].status, 'cancelled');
      if (o.case === 'consult-seed-rebind') {
        assert.ok(probe.follow_up.every(item => item.status === 'answered'));
        assert.equal(probe.follow_up_dispatches, 4);
        assert.equal(probe.follow_up_counters.consults, 4);
      }
    }
  }
  if (o.case === 'consult-checkpoint-matrix') {
    assert.equal(o.stages.length, 18);
    assert.equal(o.rows.length, 90);
  }
  return true;
}
function reservationBehavior(o) {
  const probe = o.probe;
  const expected = {
    'consult-branch-switch-reserved': 'stale_reservation', 'consult-reload-reserved': 'interrupted',
    'consult-cancel-reserved': 'cancelled',
  }[o.case];
  assert.equal(probe.reserved_before_action, 1);
  assert.equal(probe.git_reads, 2);
  assert.equal(probe.concurrent_second, 'busy');
  assert.equal(probe.result.status, expected);
  assert.equal(probe.result.calls_remaining, 4);
  assert.equal(probe.native_oracle_dispatches, 0);
  assert.equal(probe.final_counters.consults, 0);
  assert.equal(probe.final_counters.work, 0);
  assert.deepEqual(probe.duplicate_result, probe.result);
  assert.ok(!probe.ledger_events.some(entry => ['consult_started', 'verdict_recorded'].includes(entry.type)));
  assert.equal(probe.receipts.at(-1).status, expected);
  assert.equal(probe.receipts.at(-1).model_called, false);
  assert.equal(probe.final_consult_record.status, expected);
  assert.equal(probe.final_consult_record.counted, false);
  if (o.case !== 'consult-branch-switch-reserved') assert.deepEqual(probe.replay, probe.result);
  if (o.case === 'consult-cancel-reserved') assert.equal(probe.action_result.status, 'cancelled');
  if (o.case === 'consult-reload-reserved') assert.equal(probe.after_action_consult.status, 'interrupted');
  assert.equal(probe.cleanup.homes_removed, true);
  return true;
}
function lifecycleProbeAdmission(o) {
  if (o.terminal_probe) probeAdmission(o.terminal_probe);
  for (const row of o.raw_probes ?? []) probeAdmission(row.probe);
  assert.ok(o.terminal_probe || o.raw_probes?.length);
  if (o.property) {
    assert.deepEqual(o.property_probes.map(row => row.name), o.property.rows.map(row => row.name));
    assert.equal(new Set(o.property_probes.map(row => row.name)).size, o.property_probes.length);
    for (const { probe } of o.property_probes) {
      if (probe.canonical_after_return) {
        assert.ok(probe.canonical_after_return.request_id && probe.canonical_after_return.job_id);
        assert.equal(probe.local_after_return.request_id, probe.canonical_after_return.request_id);
        assert.equal(probe.local_after_return.job_id, probe.canonical_after_return.job_id);
      } else if (probe.rebuild) {
        if (probe.consult) assert.ok(probe.consult.request_id && probe.consult.job_id);
        else assert.equal(probe.action, 'branch');
      } else probeAdmission(probe);
    }
  }
  return true;
}
function lifecycleProbeBehavior(o) {
  if (o.terminal_probe) verifyTerminalBranchReplay(o.terminal_probe);
  for (const { probe, model_called } of o.raw_probes ?? []) {
    if (model_called !== undefined) verifyNativeEnvelope(probe, model_called);
    else {
      verifyConsultLifetime(probe);
      if (o.case === 'consult-admission-replay') assert.equal(probe.native_oracle_dispatches, 0);
    }
  }
  if (o.case === 'consult-native-rejection') {
    assert.equal(o.property.status, 'passed');
    for (const { name, probe } of o.property_probes) {
      if (probe.canonical_after_return) {
        const record = probe.canonical_after_return;
        assert.deepEqual(probe.local_after_return, record);
        assert.equal(probe.dispatches[record.request_id], 1);
        assert.equal(probe.native_captures.length, 1);
        assert.deepEqual(Object.values(record.native_attempts), probe.native_captures);
        assert.equal(record.counted, probe.expected_paid);
        for (const step of probe.steps) {
          assert.ok(step.remaining >= 0 && step.remaining <= 4);
          assert.equal(step.used, step.expected_used);
          assert.equal(step.canonical_used, step.expected_used);
          assert.equal(step.remaining, 4 - step.canonical_used);
          assert.ok(step.original_dispatches <= 1);
        }
      } else if (probe.rebuild) verifyRebuild(probe);
      else if (probe.terminal_branch_replays) verifyTerminalBranchReplay(probe);
      else if (name.startsWith('native-envelope-')) {
        verifyNativeEnvelope(probe, probe.consult.native_attempts['1'].model_called);
      } else verifyConsultLifetime(probe);
    }
  }
  return true;
}
function retirementAdmission(o) {
  const f = observed(o);
  commandSnapshots(o);
  assert.equal(o.scenarios.length, 3);
  for (const scenario of o.scenarios) {
    const id = scenario.seeded.id;
    assert.equal(scenario.seeded.task.task_id, id);
    assert.ok(f.executions.some(native => native.name === 'task' &&
      native.input?.subagent_type === 'oracle' && toolData(native).task_id === id &&
      f.byId.get(native.parent_id)?.name === 'qa_transport_run'), `seeded native task ${id}`);
    const callId = scenario.model_cancel.toolCallId;
    const call = f.byId.get(callId);
    assert.equal(call?.name, 'task_cancel');
    assert.equal(call.input?.task_id, id);
    assert.ok(!call.execution, 'denied main cancellation has no tool_result');
    const assigned = f.ledgers.find(record => record.record.type === 'oracle_assigned' &&
      record.record.oracle_task_id === id);
    assert.ok(assigned && assigned.index < call.index);
    const jobId = scenario.command.state.job.job_id;
    assert.ok(opened(f, jobId).index < assigned.index);
    assert.ok(scenario.after_model_cancel.tasks.some(task => task.task_id === id));
    assert.ok(scenario.after_owner.tasks.some(task => task.task_id === id));
    const owner = f.commands.find(command => command.name === 'oracle' && command.args === scenario.action &&
      command.end && command.index > call.index && events(o).slice(command.index, command.end.index + 1)
        .some(event => event.event === 'command' && event.state?.job?.job_id === jobId));
    assert.ok(owner, `owner command for ${id}`);
    assert.ok(f.executions.some(native => native.name === 'task_cancel' && native.input?.task_id === id &&
      native.owner_command?.id === owner.command_id && native.index > owner.index &&
      native.execution.index < owner.end.index), `owner-authorized retirement ${id}`);
  }
  return true;
}
function retirementBehavior(o) {
  for (const scenario of o.scenarios) {
    assert.equal(scenario.denied.length, 1);
    assert.equal(scenario.seeded.task.status, 'completed');
    assert.equal(scenario.seeded.task.residency_state, 'resident');
    assert.equal(scenario.model_cancel.isError, true);
    assert.equal(scenario.after_model_cancel.tasks.find(task => task.task_id === scenario.seeded.id).residency_state, 'resident');
    assert.equal(scenario.command.event, 'command', scenario.command.message);
    assert.equal(scenario.command.context_executeTool, 'undefined');
    assert.equal(scenario.command.command_context, 'function');
    assert.equal(scenario.command.state.job.status, scenario.action === 'end' ? 'closed' : 'active');
    assert.ok(scenario.after_owner.tasks.every(gone));
  }
  return true;
}

export const auxFamilies = [
  { family: 'lifecycle', cases: ['lifecycle', 'lifecycle-killswitch'], todos: [3],
    admission: lifecycleAdmission, behavioral: lifecycleBehavior,
    evidence_fields: ['events.command_id', 'events.session_id', 'events.state.job.job_id', 'events.entries', 'disabled_receipts'] },
  { family: 'triggers', cases: ['trigger-real', 'trigger-success-between', 'trigger-real-powershell'], todos: [4],
    admission: triggerAdmission, behavioral: triggerBehavior,
    evidence_fields: ['records.tool_call_id', 'records.session_id', 'records.structured_content', 'records.tool_call_ids'] },
  { family: 'transport', cases: ['resident-3', 'resident-dead', 'resident-stuck', 'shutdown-inflight',
    'consult-cache-budget', 'cancel-after-promotion', 'answered-error-words'], todos: [6],
    admission: transportAdmission, behavioral: transportBehavior,
     evidence_fields: ['events', 'consults.request_id', 'consults.oracle_task_id', 'retired_records.task_id',
       'mock_provider_calls', 'mock_provider_calls.provider_request_id', 'mock_provider_calls.held_at', 'events.provider_hold'] },
  { family: 'consult', cases: ['consult-real', 'consult-cap', 'consult-not-readonly', 'consult-no-job'], todos: [17, 18],
    admission: consultAdmission, behavioral: consultBehavior,
    evidence_fields: ['events', 'consults.call_id', 'receipts.request_id', 'receipts.job_id', 'retired_records.task_id'] },
  { family: 'consult-checkpoint', cases: ['consult-checkpoint-matrix', 'consult-policy-change',
    'consult-cancel-save', 'consult-seed-rebind'], todos: [17, 18],
    admission: checkpointAdmission, behavioral: checkpointBehavior,
    evidence_fields: ['probe.events', 'probe.admission_before_microtask', 'probe.receipts', 'raw_probes'] },
  { family: 'consult-reservation', cases: ['consult-branch-switch-reserved', 'consult-reload-reserved',
    'consult-cancel-reserved'], todos: [17, 18],
    admission: o => probeAdmission(o.probe), behavioral: reservationBehavior,
    evidence_fields: ['probe.ledger_events', 'probe.final_consult_record', 'probe.receipts'] },
  { family: 'consult-lifecycle', cases: ['consult-admission-replay', 'consult-native-rejection'], todos: [17, 18],
    admission: lifecycleProbeAdmission, behavioral: lifecycleProbeBehavior,
    evidence_fields: ['terminal_probe', 'raw_probes.probe.events', 'raw_probes.probe.receipts', 'property'] },
  { family: 'lifecycle-retirement', cases: ['lifecycle-retirement'], todos: [6],
    admission: retirementAdmission, behavioral: retirementBehavior,
    evidence_fields: ['events', 'scenarios.seeded.id', 'scenarios.model_cancel.toolCallId', 'scenarios.after_owner.tasks'] },
];
