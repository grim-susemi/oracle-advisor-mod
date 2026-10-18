import test from 'node:test';
import assert from 'node:assert/strict';
import { admitScenario, assertHeldExecutions, oracleDispatches, scenarioFacts } from '../qa/scenario-verdict.mjs';
import { acceptanceObservation, log } from './helpers/scenario-fixtures.mjs';

test('acceptance verification is bound to validated absolute Node, exact arguments and cwd', () => {
  for (const down of [false, true]) {
    const name = down ? 'acceptance-oracle-down' : 'acceptance';
    assert.doesNotThrow(() => admitScenario(name, acceptanceObservation(down)));
    for (const mutant of ['pipeline', 'wrong-cwd', 'wrong-executable', 'wrong-args',
      'pre-consult-success', 'missing-validation', 'late-validation']) {
      const observation = acceptanceObservation(down);
      const verification = observation.events.find(event => event.kind === 'attempt' && event.call_id === 'verified');
      if (mutant === 'pipeline') {
        for (const event of observation.events.filter(event => event.kind === 'attempt' && event.name === 'bash' &&
          event.call_id !== 'node-validation')) event.input.command += ' | head -20';
      } else if (mutant === 'wrong-cwd') verification.cwd = 'C:/elsewhere';
      else if (mutant === 'wrong-executable') verification.input.command = verification.input.command.replace('node.exe', 'other.exe');
      else if (mutant === 'wrong-args') verification.input.command += " '--test-only'";
      else if (mutant === 'pre-consult-success') {
        const span = observation.events.filter(event => event.call_id === 'verified');
        observation.events = observation.events.filter(event => event.call_id !== 'verified');
        observation.events.splice(observation.events.findIndex(event => event.kind === 'attempt' &&
          event.name === 'oracle_consult'), 0, ...span);
      } else if (mutant === 'missing-validation') {
        observation.events = observation.events.filter(event => event.event !== 'fixture_validation');
      } else {
        const marker = observation.events.find(event => event.event === 'fixture_validation');
        observation.events.splice(observation.events.indexOf(marker), 1);
        observation.events.push(marker);
      }
      assert.throws(() => admitScenario(name, observation), { code: 'scenario_not_reached' }, mutant);
    }
  }
});

test('down-oracle admission rejects extra explicit completion and duplicate native dispatches', () => {
  const name = 'acceptance-oracle-down';
  for (const mutant of ['completion', 'duplicate-native']) {
    const observation = acceptanceObservation(true);
    if (mutant === 'completion') {
      const extra = log();
      extra.on();
      extra.consult('completion', { status: 'unavailable' });
      observation.events.splice(observation.events.findIndex(event => event.kind === 'agent_end'), 0,
        ...extra.events.slice(5));
    } else {
      const native = structuredClone(observation.events.filter(event => event.name === 'task' &&
        event.call_id === 'first/task'));
      for (const event of native) event.call_id += '-extra';
      observation.events.splice(observation.events.findIndex(event => event.record?.type === 'consult_native_result'), 0,
        ...native);
    }
    assert.throws(() => admitScenario(name, observation), { code: 'scenario_not_reached' }, mutant);
  }
});

test('a pipeline-masked failing test cannot establish the acceptance repeated-failure challenge', () => {
  const observation = acceptanceObservation();
  for (const event of observation.events.filter(event => ['failure-1', 'failure-2'].includes(event.call_id))) {
    if (event.kind === 'attempt') event.input.command += ' | head -20';
    if (event.kind === 'executed') {
      event.is_error = false;
      event.result = { structuredContent: { exit_code: 0 }, details: { status: 'completed' },
        content: [{ type: 'text', text: 'Fixture assertion failed.' }] };
    }
  }
  assert.throws(() => admitScenario('acceptance', observation), { code: 'scenario_not_reached' });
});

const evidence = (kind, fields = {}) => ({ event: 'evidence', kind, ...fields });
const ledger = record => evidence('ledger', { record });
const attempt = (call_id, name, input = {}) => evidence('attempt', { call_id, name, input });
const executed = (call_id, name, result = {}, is_error = false) =>
  evidence('executed', { call_id, name, result, is_error });

test('inactive admission requires actual serial failures and finish_intent', () => {
  const observation = { events: [
    attempt('finish', 'oracle_advisor', { action: 'finish_intent' }),
    executed('finish', 'oracle_advisor', { details: { status: 'no_nudge' } }),
  ] };
  assert.throws(() => admitScenario('nudge-inactive', observation), { code: 'scenario_not_reached' });
});

test('a later disposition cannot hide an executed mutation during STOP', () => {
  const events = [
    ledger({ type: 'job_opened', job_id: 'J1' }),
    ledger({ type: 'stop_opened', job_id: 'J1', stop_id: 'S1' }),
    attempt('edit', 'edit', { path: 'fixture.txt' }),
    executed('edit', 'edit'),
    attempt('dispose', 'oracle_record_stop', { stop_id: 'S1', decision: 'redirect' }),
    ledger({ type: 'stop_disposition', stop_id: 'S1', decision: 'redirect' }),
    executed('dispose', 'oracle_record_stop', { details: { status: 'recorded', stop_id: 'S1' } }),
  ];
  assert.throws(() => assertHeldExecutions(events), assert.AssertionError);
});

test('execution overlapping a hold is rejected even when it finishes after release', () => {
  const events = [
    ledger({ type: 'job_opened', job_id: 'J1' }),
    attempt('edit', 'edit'),
    ledger({ type: 'stop_opened', stop_id: 'S1' }),
    attempt('dispose', 'oracle_record_stop', { stop_id: 'S1', decision: 'redirect' }),
    ledger({ type: 'stop_disposition', stop_id: 'S1', decision: 'redirect' }),
    executed('dispose', 'oracle_record_stop', { details: { status: 'recorded', stop_id: 'S1' } }),
    executed('edit', 'edit'),
  ];
  assert.throws(() => assertHeldExecutions(events), assert.AssertionError);
});

test('only a same-scope live parent span grants the nested STOP exemption', () => {
  const events = [
    ledger({ type: 'job_opened', job_id: 'J1', job_epoch: 1 }),
    attempt('consult', 'oracle_consult'),
    ledger({ type: 'stop_opened', stop_id: 'S1' }),
    { ...attempt('nested', 'write'), parent_id: 'consult' },
    { ...executed('nested', 'write'), parent_id: 'consult' },
    executed('consult', 'oracle_consult'),
  ];
  assert.doesNotThrow(() => assertHeldExecutions(events));
  const stale = structuredClone(events);
  stale.splice(2, 0, ...stale.splice(5, 1));
  assert.throws(() => assertHeldExecutions(stale), assert.AssertionError);
  const wrongExecution = structuredClone(events);
  wrongExecution[4].parent_id = null;
  assert.throws(() => assertHeldExecutions(wrongExecution), assert.AssertionError);
});

test('ending J2 cannot close J1 even when both jobs reuse the STOP label', () => {
  const events = [
    ledger({ type: 'job_opened', job_id: 'J1', job_epoch: 1 }),
    ledger({ type: 'stop_opened', job_id: 'J1', job_epoch: 1, stop_id: 'S1' }),
    ledger({ type: 'job_opened', job_id: 'J2', job_epoch: 1 }),
    ledger({ type: 'stop_opened', job_id: 'J2', job_epoch: 1, stop_id: 'S1' }),
    evidence('command_start', { command_id: 'end-J2', name: 'oracle', args: 'end' }),
    ledger({ type: 'job_ended', job_id: 'J2', job_epoch: 1 }),
    evidence('command_end', { command_id: 'end-J2', name: 'oracle', args: 'end' }),
    ledger({ type: 'job_resumed', job_id: 'J1', job_epoch: 1 }),
    attempt('write-J1', 'write'),
    executed('write-J1', 'write'),
  ];
  const facts = scenarioFacts(events);
  assert.equal(facts.integrity, true);
  assert.equal(facts.windows.find(window => window.job_id === 'J1').end, Infinity);
  assert.notEqual(facts.windows.find(window => window.job_id === 'J2').end, Infinity);
  assert.throws(() => assertHeldExecutions(events), assert.AssertionError);
});

test('abort-time child settlement keeps its admitted live ancestry without allowing stale new children', () => {
  const events = [
    ledger({ type: 'job_opened', job_id: 'J1', job_epoch: 1 }),
    attempt('consult', 'oracle_consult'),
    ledger({ type: 'stop_opened', stop_id: 'S1' }),
    { ...attempt('nested', 'task'), parent_id: 'consult' },
    executed('consult', 'oracle_consult', { details: { status: 'cancelled' } }),
    { ...executed('nested', 'task', { details: { status: 'cancelled' } }), parent_id: 'consult' },
  ];
  assert.doesNotThrow(() => assertHeldExecutions(events));
  const stale = structuredClone(events);
  stale.splice(4, 0, stale.splice(3, 1)[0]);
  assert.throws(() => assertHeldExecutions(stale), assert.AssertionError);
});

test('an empty native refusal identity denotes no task but cannot prove answered advice', () => {
  const trace = log();
  trace.on();
  trace.consult('refused', { status: 'unavailable' });
  const execution = trace.events.find(event => event.kind === 'executed' && event.name === 'task');
  const capture = trace.events.find(event => event.record?.type === 'consult_native_result');
  execution.result.details.task_id = '';
  capture.record.native_result.task_id = '';
  const facts = scenarioFacts(trace.events);
  assert.doesNotThrow(() => oracleDispatches(facts, facts.byId.get('refused'), 1));
  const answered = structuredClone(trace.events);
  answered.find(event => event.kind === 'executed' && event.name === 'oracle_consult').result.details.status = 'answered';
  answered.find(event => event.record?.type === 'consult_finished').record.status = 'answered';
  const answeredFacts = scenarioFacts(answered);
  assert.throws(() => oracleDispatches(answeredFacts, answeredFacts.byId.get('refused'), 1), assert.AssertionError);
  execution.result.details.task_id = 'different-task';
  const wrong = scenarioFacts(trace.events);
  assert.throws(() => oracleDispatches(wrong, wrong.byId.get('refused'), 1), assert.AssertionError);
});

function privateRelease() {
  const trace = log();
  trace.on();
  const request = trace.begin('oracle_consult', {}, 'request');
  const scope = { job_id: 'J1', job_epoch: 1, request_id: 'request' };
  const identity = { ...scope, operation_id: 'release-1', scope_id: 'scope-1',
    call_id: 'factory', task_id: 'owned', reason: 'oracle-advisor: answered', owner_command_id: null };
  trace.evidence('retirement_scope_start', { scope_id: 'scope-1',
    entry: 'tool', name: 'oracle_consult', call_id: 'request' });
  trace.ledger({ type: 'consult_admitted', ...scope });
  const native = trace.begin('task', { subagent_type: 'oracle' }, 'native', 'request');
  trace.end(native, { details: { task_id: 'owned', status: 'completed' } });
  trace.ledger({ type: 'consult_native_result', ...scope,
    native_result: { task_id: 'owned', status: 'completed', isError: false } });
  trace.ledger({ type: 'stop_opened', stop_id: 'S1' });
  const cancel = trace.begin('task_cancel', { task_id: 'owned', reason: 'oracle-advisor: answered' }, 'factory');
  trace.evidence('retirement_authority', { ...identity,
    source: 'runtime.transport.isRetirementCall' });
  trace.end(cancel, { details: { kind: 'released', task_id: 'owned' } });
  trace.run('task_output', { task_id: 'owned' }, { details: { snapshot: {
    task_id: 'owned', status: 'completed', residency_state: 'persisted_only',
  } } }, false, false, 'confirmed');
  trace.evidence('retirement_snapshot', { ...identity, evidence_id: 'snapshot-1', snapshot_call_id: 'confirmed' });
  trace.evidence('ledger', { evidence_id: 'retired-1',
    retirement: { ...identity, snapshot_event_id: 'snapshot-1', snapshot_call_id: 'confirmed' },
    record: { type: 'oracle_retired', oracle_task_id: 'owned', confirmed: true, reason: 'answered' } });
  trace.evidence('ledger', { evidence_id: 'settled-1',
    retirement: { ...identity, snapshot_event_id: 'snapshot-1', snapshot_call_id: 'confirmed',
      retired_event_id: 'retired-1' },
    record: { type: 'consult_lifecycle_result', ...scope,
      lifecycle_result: { operation: 'retire', status: 'fulfilled' } } });
  trace.evidence('retirement_scope_end', { scope_id: 'scope-1',
    entry: 'tool', name: 'oracle_consult', call_id: 'request' });
  trace.end(request);
  return trace.events;
}

test('only trusted exact-call private retirement with owned request and successful release crosses STOP', () => {
  const events = privateRelease();
  assert.doesNotThrow(() => assertHeldExecutions(events));
  for (const mutate of [
    records => records.splice(records.findIndex(event => event.kind === 'retirement_authority'), 1),
    records => { records.find(event => event.kind === 'retirement_authority').call_id = 'other-call'; },
    records => { records.find(event => event.kind === 'retirement_authority').job_epoch = 2; },
    records => { records.find(event => event.kind === 'retirement_authority').request_id = 'other-request'; },
    records => { records.find(event => event.kind === 'retirement_authority').source = 'oracle-advisor: answered'; },
    records => { records.find(event => event.record?.type === 'oracle_retired').record.confirmed = false; },
    records => { records.find(event => event.record?.type === 'consult_lifecycle_result')
      .record.lifecycle_result.status = 'rejected'; },
    records => { records.find(event => event.kind === 'executed' && event.call_id === 'native')
      .result.details.task_id = 'foreign-task'; },
    records => { records.find(event => event.kind === 'executed' && event.call_id === 'confirmed')
      .result.details.snapshot.task_id = 'foreign-task'; },
    records => { records.find(event => event.kind === 'executed' && event.call_id === 'confirmed')
      .result.details.snapshot.resident = true; },
    records => records.push(structuredClone(records.find(event => event.kind === 'retirement_authority'))),
  ]) {
    const counterexample = structuredClone(events);
    mutate(counterexample);
    assert.throws(() => assertHeldExecutions(counterexample), assert.AssertionError);
  }
});

test('private provenance cannot be reused by a concurrent or deferred main cancellation', () => {
  const events = privateRelease();
  const end = events.findIndex(event => event.kind === 'executed' && event.call_id === 'factory');
  const injected = [
    attempt('codemode-forged', 'task_cancel', { task_id: 'owned', reason: 'oracle-advisor: answered' }),
    executed('codemode-forged', 'task_cancel', { details: { task_id: 'owned', kind: 'released' } }),
  ];
  for (const index of [end, events.length]) {
    const counterexample = structuredClone(events);
    counterexample.splice(index, 0, ...structuredClone(injected));
    assert.throws(() => assertHeldExecutions(counterexample), assert.AssertionError);
  }
});

test('copied private authority cannot reuse another call settlement or owner end evidence', () => {
  for (const operation_id of ['release-1', 'another-release']) {
    const events = privateRelease();
    const marker = events.find(event => event.kind === 'retirement_authority');
    const original = events.find(event => event.kind === 'executed' && event.call_id === 'factory');
    const end = events.findIndex(event => event.kind === 'executed' && event.call_id === 'request');
    events.splice(end + 1, 0,
      attempt('replay-cancel', 'task_cancel', { task_id: 'owned', reason: marker.reason }),
      { ...structuredClone(marker), operation_id, call_id: 'replay-cancel' },
      { ...structuredClone(original), call_id: 'replay-cancel' });
    assert.throws(() => assertHeldExecutions(events), assert.AssertionError);
  }
});

test('a genuine post-request retirement requires its own proof instead of later owner end', () => {
  const events = privateRelease();
  const completed = events.splice(events.findIndex(event => event.kind === 'executed' &&
    event.call_id === 'request'), 1)[0];
  const started = events.splice(events.findIndex(event => event.kind === 'retirement_scope_start'), 1)[0];
  events.splice(events.findIndex(event => event.record?.type === 'consult_native_result') + 1, 0, completed, started);
  for (const event of events.filter(event => /^retirement_scope_/.test(event.kind))) {
    Object.assign(event, { entry: 'hook', name: 'session_tree', call_id: null });
  }
  assert.doesNotThrow(() => assertHeldExecutions(events), 'actual post-request retirement is supported');
  for (const event of events.filter(event => event.retirement)) {
    event.retirement.call_id = 'end-cancel';
    event.retirement.operation_id = 'end-release';
  }
  events.push(evidence('command_start', { command_id: 'owner-end', name: 'oracle', args: 'end' }));
  const later = events.filter(event => event.retirement);
  for (const event of later) {
    events.splice(events.indexOf(event), 1);
    events.push(event);
  }
  events.push(evidence('command_end', { command_id: 'owner-end', name: 'oracle', args: 'end' }));
  assert.throws(() => assertHeldExecutions(events), assert.AssertionError);
});

test('a canonical capture cannot launder a conflicting raw native outcome with the same task id', () => {
  const trace = log();
  trace.on();
  trace.consult('request', { status: 'answered', verdict: 'CONTINUE' });
  const native = trace.events.find(event => event.kind === 'executed' && event.name === 'task');
  native.result.details.status = 'cancelled';
  const facts = scenarioFacts(trace.events);
  assert.throws(() => oracleDispatches(facts, facts.byId.get('request'), 1), assert.AssertionError);
});
