import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAcceptanceObservation } from '../qa/verdict-primary.mjs';
import { verdictSpec } from '../qa/verdict-spec.mjs';
import { acceptanceObservation } from './helpers/scenario-fixtures.mjs';

test('acceptance rejects any rejected disposition before the recorded STOP', () => {
  const observation = acceptanceObservation();
  const options = { real: true };
  const context = { caseName: 'acceptance', observation, options };
  verdictSpec.find(row => row.cases.includes('acceptance')).admission(context);
  checkAcceptanceObservation(observation, options, context.facts);
  const index = observation.events.findIndex(event =>
    event.event === 'tool' && event.name === 'oracle_record_stop');
  const real = observation.events[index];
  const result = { content: [], details: { status: 'invalid_arguments' },
    structuredContent: { status: 'invalid_arguments' } };
  const call_id = 'forged-failed-stop-attempt';
  observation.events.splice(index, 0, { ...structuredClone(real), call_id, result });
  const template = context.facts.byId.get(real.call_id);
  context.facts.byId.set(call_id, { ...template, call_id,
    input: { stop_id: 'J1-forged', decision: 'redirect', reason: 'short', next_step: 'short' },
    execution: { ...template.execution, result, is_error: false } });
  assert.throws(() => checkAcceptanceObservation(observation, options, context.facts),
    assert.AssertionError);
});

test('mock acceptance requires REDIRECT followed then STOP redirect', () => {
  const observation = acceptanceObservation();
  const options = { real: false };
  const context = { caseName: 'acceptance', observation, options };
  verdictSpec.find(row => row.cases.includes('acceptance')).admission(context);
  checkAcceptanceObservation(observation, options, context.facts);
  observation.events = observation.events.filter(event =>
    !(event.event === 'tool' && event.name === 'oracle_record_stop' && event.args.redirect_id));
  assert.throws(() => checkAcceptanceObservation(observation, options, context.facts),
    assert.AssertionError);
});

test('acceptance rejects a HELD first STOP disposition in real mode', () => {
  const observation = acceptanceObservation();
  const options = { real: true };
  const context = { caseName: 'acceptance', observation, options };
  verdictSpec.find(row => row.cases.includes('acceptance')).admission(context);
  checkAcceptanceObservation(observation, options, context.facts);
  const tools = observation.events.filter(event => event.event === 'tool');
  const first = tools.find(event => event.name === 'oracle_consult');
  const disposition = tools.find(event => event.name === 'oracle_record_stop');
  const firstCall = context.facts.byId.get(first.call_id);
  const dispositionCall = context.facts.byId.get(disposition.call_id);
  const setResult = (event, call, details) => {
    for (const result of [event.result, call.execution.result]) {
      result.details = structuredClone(details);
      result.structuredContent = structuredClone(details);
    }
  };
  const details = { ...first.result.details, verdict: 'STOP', stop_id: 'stop-A' };
  delete details.redirect_id;
  setResult(first, firstCall, details);
  const input = { stop_id: 'stop-A', decision: 'redirect',
    reason: 'Dispose STOP A while STOP B is still open.', next_step: 'Then dispose STOP B.' };
  disposition.args = input;
  context.facts.byId.set(disposition.call_id, { ...dispositionCall, input });
  // A remains open across the second consult (STOP B, AC1). Dispose A before B.
  observation.events.splice(observation.events.indexOf(disposition), 1);
  const stopBDisposition = observation.events.findIndex(event =>
    event.event === 'tool' && event.name === 'oracle_record_stop');
  observation.events.splice(stopBDisposition, 0, disposition);
  setResult(disposition, dispositionCall, { status: 'recorded', stop_id: 'stop-A', gate_state: 'ACTIVE' });
  checkAcceptanceObservation(observation, options, context.facts);
  setResult(disposition, dispositionCall, { status: 'recorded', stop_id: 'stop-A', gate_state: 'HELD' });
  assert.throws(() => checkAcceptanceObservation(observation, options, context.facts),
    assert.AssertionError);
});
