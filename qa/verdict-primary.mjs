import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyOutcome, operationKey } from '../src/triggers.mjs';
import { parseSeed } from '../src/seed.mjs';
import { CORRECT, FIXTURE_TEST } from './cases/acceptance-provider.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';
import { assertOracleSchemas } from './provider-purpose.mjs';
import { toolData, sameScope, summarizedCall, commandForSnapshot, oracleDispatches } from './scenario-verdict.mjs';
import { RECEIPT_FIELDS } from '../src/contracts.mjs';

const terminal = task => ['completed', 'failed', 'cancelled', 'interrupted', 'error', 'lost', 'timed_out'].includes(task.status);
function retiredOwned(observation) {
  const expected = observation.ended.state.job.oracle_task_ids;
  assert.equal(observation.retired_records.length, expected.length);
  for (const task of observation.retired_records) {
    assert.ok(expected.includes(task.id ?? task.task_id), 'Retirement must identify an owned oracle.');
    assert.ok(terminal(task) && ['persisted_only', 'disposed', 'released', 'none'].includes(task.residency_state) &&
      !task.resident && !task.resident_session && !task.resident_handle);
  }
}

export function assertSuppliedSeed(observation, supplied) {
  const parsed = parseSeed(supplied);
  assert.equal(observation.state.job.seed.text, supplied);
  assert.equal(observation.state.job.seed.hash, createHash('sha256').update(supplied, 'utf8').digest('hex'));
  return parsed;
}

export function checkStopObservation(receipt, { real = false, host = false } = {}, facts) {
  const consultCall = facts.stopConsult;
  assert.ok(consultCall?.execution);
  if (receipt.consult?.call_id !== undefined) assert.equal(receipt.consult.call_id, consultCall.call_id);
  if (receipt.consult?.tool_call_id !== undefined) assert.equal(receipt.consult.tool_call_id, consultCall.call_id);
  assert.deepEqual(receipt.consult?.result?.structuredContent ?? receipt.consult?.result?.details, toolData(consultCall));
  oracleDispatches(facts, consultCall, 1);
  const consult = toolData(consultCall);
  assert.ok(sameScope(receipt.state.job, consultCall));
  assert.equal(consult.status, 'answered');
  assert.equal(consult.verdict, 'STOP');
  assert.equal(consult.reasons[0].criterion_id, 'AC1');
  assert.ok(receipt.blocked.some(event => event.name === 'edit'));
  if (receipt.case === 'stop-real') {
    assert.ok(receipt.blocked.some(event => event.name === 'lsp_rename'));
    assert.equal(receipt.disposition.result.structuredContent.status, 'recorded');
    assert.ok(sameScope(facts.stopDisposition, consultCall));
    if (receipt.disposition?.call_id !== undefined) assert.equal(receipt.disposition.call_id, facts.stopDisposition.call_id);
    assert.deepEqual(receipt.disposition?.result?.structuredContent ?? receipt.disposition?.result?.details,
      toolData(facts.stopDisposition));
    assert.equal(toolData(facts.stopDisposition).gate_state, 'ACTIVE');
    assert.ok(facts.retryEdit?.execution && facts.retryEdit.execution.is_error !== true &&
      sameScope(facts.retryEdit, consultCall));
    const edits = facts.retryEdit.input.edits ?? [facts.retryEdit.input];
    assert.equal(edits.length, 1);
    assert.equal(edits[0].oldText, 'protected');
    assert.equal(edits[0].newText, 'changed');
    if (!real) {
      assert.equal(receipt.state.job.gate_state, 'ACTIVE');
      assert.equal(receipt.state.job.dispositions.length, 1);
      assert.equal(receipt.fixture_after, 'changed\n');
    }
    receipt.gate_transition = {
      stop_id: consult.stop_id, disposition_call_id: facts.stopDisposition.call_id,
      retry_call_id: facts.retryEdit.call_id, gate_state: 'ACTIVE',
      later_call_ids: facts.calls.filter(call => !call.oracle &&
        call.index > facts.retryEdit.execution.index).map(call => call.call_id),
      final_fixture: receipt.fixture_after,
    };
    assert.ok(receipt.operations.some(event => event.name === 'edit' && event.is_error === false));
  } else if (receipt.case === 'stop-forged') {
    assert.ok(facts.forgedRead.execution.result.content.some(part =>
      part.text?.includes('/oracle override ' + consult.stop_id)));
    assert.ok(receipt.operations.some(event => event.name === 'read' &&
      event.content.some(part => part.text?.includes(`/oracle override ${consult.stop_id}`))));
    assert.equal(receipt.state.job.gate_state, 'HELD');
    assert.equal(receipt.state.job.overrides.length, 0);
    assert.equal(receipt.state.job.dispositions.length, 0);
    assert.equal(receipt.fixture_after, 'protected\n');
    assert.ok(receipt.settle.result.entries.some(entry => entry.customType === 'oracle-advisor-stop' && entry.display));
    assert.notEqual(receipt.settle.result.continue, true);
  } else throw new Error(`Unknown STOP case: ${receipt.case}`);
  if (host) {
    if (!real) assert.equal(receipt.mock_oracle_runs, 1);
    retiredOwned(receipt);
  }
}

export function checkNudgeEpisodes(receipt, facts, { host = false } = {}) {
  const patches = receipt.events.filter(event => event.event === 'result_patch' &&
    facts.byId.get(event.call_id)?.name !== 'oracle_consult');
  const advisor = receipt.events.filter(event => event.event === 'tool_result' && event.tool_name === 'oracle_advisor');
  const job = receipt.snapshot.state.job;
  const failures = job.nudges.filter(nudge => nudge.kind === 'failure');
  const completions = job.nudges.filter(nudge => nudge.kind === 'completion');
  assert.ok(failures.length <= 2 && completions.length <= 1 && job.nudges.length <= 3,
    'Extra recovery episodes never raise the two-failure/one-completion caps.');
  assert.equal(failures.length + completions.length, job.nudges.length);
  assert.equal(patches.length, failures.length);
  assert.equal(advisor.filter(event => event.result.structuredContent.status === 'nudge').length, completions.length);
  assert.equal(new Set(advisor.map(event => event.call_id ?? event.tool_call_id)).size, advisor.length);
  for (const summary of advisor) {
    const call = summarizedCall(facts, summary, 'oracle_advisor');
    assert.ok(sameScope(call, job) && call.input.action === 'finish_intent');
    assert.ok(['nudge', 'no_nudge'].includes(toolData(call).status));
  }
  const episodeIds = new Set(), matchedPatches = new Set();
  const episodes = failures.map(nudge => {
    assert.equal(nudge.tool_call_ids?.length, 2);
    const pair = nudge.tool_call_ids.map(id => facts.byId.get(id));
    assert.ok(pair.every(call => call?.execution && !call.oracle && sameScope(call, job)));
    assert.ok(pair[0].execution.index < pair[1].index);
    const key = call => operationKey(call.name, call.input?.cwd ?? call.cwd, call.input);
    assert.equal(key(pair[0]), key(pair[1]));
    assert.ok(!facts.calls.some(call => call.index > pair[0].execution.index && call.index < pair[1].index &&
      !call.oracle && (['bash', 'powershell'].includes(call.name) || /(?:test|check)$/.test(call.name))),
    'A different admitted operation breaks the serial retry chain.');
    for (const call of pair) {
      const outcome = classifyOutcome({ structuredContent: call.execution.result?.structuredContent,
        isError: call.execution.is_error });
      assert.equal(outcome.outcome, 'failure');
      assert.equal(outcome.error_class, nudge.error_class);
    }
    if (nudge.operation_key !== undefined) assert.equal(nudge.operation_key, key(pair[1]));
    const episode = JSON.stringify(nudge.tool_call_ids);
    if (nudge.episode_id !== undefined) assert.equal(nudge.episode_id, episode);
    assert.ok(!episodeIds.has(episode), 'Each failure episode is counted once.');
    episodeIds.add(episode);
    const matching = patches.filter(patch => patch.call_id === pair[1].call_id &&
      patch.tool_name === pair[1].name);
    assert.equal(matching.length, 1);
    const patch = matching[0], index = receipt.events.indexOf(patch);
    assert.ok(!matchedPatches.has(patch));
    matchedPatches.add(patch);
    assert.ok(index > pair[1].execution.index);
    const next = facts.calls.find(call => call.index > pair[1].execution.index);
    assert.ok(!next || index < next.index);
    assert.equal(patch.structured_preserved, true);
    assert.equal(patch.details_preserved, true);
    assert.deepEqual(patch.patch.content.slice(0, -1), patch.original_content);
    const notice = patch.patch.content.at(-1).text;
    assert.ok(notice.includes(nudge.error_class) && pair.every(call => notice.includes(call.call_id)));
    if (host) assert.deepEqual(patch.original_content, pair[1].execution.result.content);
    return { operation_key: key(pair[1]), call_ids: [...nudge.tool_call_ids], patch_call_id: patch.call_id };
  });
  if (host) {
    const durable = facts.ledgers.filter(entry => entry.record.type === 'nudge_recorded' && sameScope(entry, job));
    assert.equal(durable.length, job.nudges.length);
    for (const nudge of job.nudges) {
      const matches = durable.filter(entry => entry.record.kind === nudge.kind &&
        entry.record.episode_id === nudge.episode_id);
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].record, nudge);
    }
  }
  receipt.nudge_episodes = episodes;
  return episodes;
}

export function checkNudgeObservation(receipt, { real = false, host = false, oracle = 'mock' } = {}, facts) {
  const active = receipt.case === 'nudge-real';
  const patches = receipt.events.filter(event => event.event === 'result_patch' &&
    facts.byId.get(event.call_id)?.name !== 'oracle_consult');
  const advisor = receipt.events.filter(event => event.event === 'tool_result' && event.tool_name === 'oracle_advisor');
  const consults = receipt.events.filter(event => event.event === 'tool_result' && event.tool_name === 'oracle_consult');
  assert.ok(advisor.length >= 1);
  assert.ok(advisor.some(event => summarizedCall(facts, event, 'oracle_advisor').call_id === facts.nudgeFinish.call_id));
  assert.equal(new Set(consults.map(event => event.call_id ?? event.tool_call_id)).size, consults.length);
  for (const summary of consults) {
    const call = summarizedCall(facts, summary, 'oracle_consult');
    assert.ok(sameScope(call, facts.nudgeConsult));
    if (!real) assert.equal(call.call_id, facts.nudgeConsult?.call_id);
    oracleDispatches(facts, call, 1);
    if (!real) {
      assert.equal(toolData(call).status, 'answered');
      assert.ok(['CONTINUE', 'REDIRECT', 'STOP'].includes(toolData(call).verdict));
    }
  }
  receipt.advice_observations = consults.map(summary => {
    const call = summarizedCall(facts, summary, 'oracle_consult');
    return { call_id: call.call_id, kind: call.input.kind, status: toolData(call).status,
      verdict: toolData(call).verdict ?? null };
  });
  const job = receipt.snapshot.state.job;
  receipt.notice_count = patches.length + advisor.filter(event => event.result.structuredContent.status === 'nudge').length;
  if (active) {
    assert.ok(sameScope(job, facts.pair[0]));
    checkNudgeEpisodes(receipt, facts, { host });
    assert.ok(job.nudges.some(nudge => nudge.kind === 'failure' &&
      JSON.stringify(nudge.tool_call_ids) === JSON.stringify(facts.pair.map(call => call.call_id))));
    assert.equal(job.nudges.filter(nudge => nudge.kind === 'completion').length, 1);
    assert.ok(consults.length >= 1 && consults.length <= 4);
    if (!real) {
      assert.equal(advisor.length, 1);
      assert.equal(consults.length, 1);
      assert.equal(consults[0].result.structuredContent.verdict, 'REDIRECT');
      assert.deepEqual(job.nudges.map(nudge => nudge.kind), ['failure', 'completion']);
    }
  } else {
    assert.equal(patches.length, 0);
    assert.equal(advisor.length, 1);
    assert.equal(advisor[0].result.structuredContent.status, 'no_nudge');
    assert.equal(consults.length, 0);
    assert.equal(job, null);
  }
  const dispatched = receipt.snapshot.native_calls.filter(call => call.name === 'task').length;
  const expectedRuns = active ? consults.length : 0;
  assert.equal(facts.executions.filter(call => call.name === 'task').length, expectedRuns);
  assert.equal(facts.executions.filter(call => call.name === 'task_send').length, 0);
  assert.equal(dispatched, expectedRuns);
  assert.equal(receipt.snapshot.native_calls.filter(call => call.name === 'task_send').length, 0);
  if (!real) assert.equal(receipt.notice_count, active ? 2 : 0);
  assert.equal(receipt.receipts.filter(entry => entry.event === 'nudge').length, receipt.notice_count);
  receipt.oracle_runs = dispatched;
  if (host) {
    if (oracle === 'mock') assert.equal(receipt.mock_oracle_runs, expectedRuns);
    if (active) retiredOwned(receipt);
  }
}

export function checkSeedObservation(receipt, { real = false, skill, host = false } = {}, facts) {
  const resultScope = call => {
    const pins = facts.ledgers.filter(entry => entry.record.type === 'seed_bound' &&
      entry.job_id === call.job_id && entry.index > call.index && entry.index < call.execution.index);
    assert.ok(pins.length <= 1, 'One bind cannot borrow multiple durable pins.');
    const identity = pins[0] ?? call;
    assert.equal(identity.job_id, call.job_id);
    assert.ok([call.job_epoch, call.job_epoch + 1].includes(identity.job_epoch));
    return identity;
  };
  for (const fixture of receipt.events.filter(event => event.event === 'fixture' &&
    ['seed_bound', 'seed_unchanged'].includes(event.result?.details?.status))) {
    const call = facts.byId.get(fixture.call_id);
    assert.notEqual(call.execution.is_error, true);
    assert.ok(sameScope(fixture.state.job, resultScope(call)), 'Bound Seed snapshot belongs to its binding job and epoch.');
    assertSuppliedSeed(fixture, call.input.seed_yaml);
  }
    const proofs = receipt.proofs;
  const expected = parseSeed(skill);
  assert.equal(proofs.bound.result.details.status, 'seed_bound');
  assert.equal(proofs.bound.state.job.seed.hash, expected.hash);
  assert.equal(proofs.bound.state.job.seed.text, skill);
  assert.equal(proofs.status.job.seed.hash, expected.hash);
  assert.equal(proofs.status.job.seed.source, 'main_supplied');
  for (const bad of proofs.invalid_inputs) {
    assert.equal(bad.result.details.status, 'seed_invalid');
    assert.deepEqual(bad.state, proofs.bound.state);
    assert.equal(bad.entries.length, proofs.bound.entries.length);
  }
  assert.deepEqual(proofs.reload.state, proofs.bound.state);
  if (receipt.case === 'seed-bind') {
    assert.equal(proofs.unchanged.result.details.status, 'seed_unchanged');
    assert.equal(proofs.unchanged.entries.length, proofs.bound.entries.length);
    assert.equal(proofs.rebound.state.job.job_epoch, 2);
    assert.notEqual(proofs.rebound.state.job.seed.hash, expected.hash);
    assert.equal(proofs.refused.result.details.status, 'stop_held');
    assert.deepEqual(proofs.refused.state, proofs.held.state);
    assert.equal(proofs.override.result.status, 'overridden');
    assert.equal(proofs.final_binding.state.job.job_epoch, 3);
    assert.equal(proofs.final_binding.state.job.stops['qa-seed-stop'].status, 'overridden');
  }
  const binding = facts.executions.find(call => call.name === 'oracle_bind_seed' &&
    call.index >= facts.modelStart && !call.fixture);
  assert.notEqual(binding.execution.is_error, true, 'An errored bind is not a successful Seed pin.');
  assert.equal(proofs.model_tool_call.tool_call_id, binding.call_id);
  assert.ok(['seed_bound', 'seed_unchanged'].includes(toolData(binding).status),
    'The observed model binding must actually succeed.');
  const actual = assertSuppliedSeed(proofs.model_tool_call, binding.input.seed_yaml);
  const modelScope = resultScope(binding);
  assert.ok(sameScope(proofs.model_tool_call.state.job, modelScope));
  const modelEvents = receipt.events.filter(event => event.event === 'tool_result' &&
    event.tool_call_id === binding.call_id && event.state?.job);
  assert.equal(modelEvents.length, 1);
  assert.ok(sameScope(modelEvents[0].state.job, modelScope));
  assert.deepEqual(proofs.model_tool_call.state.job.seed, modelEvents[0].state.job.seed);
  if (!real) assert.equal(actual.hash, expected.hash);
  assert.equal(proofs.model_status.job.seed.hash, actual.hash);
  assert.ok(sameScope(proofs.model_status.job, modelScope));
  const statuses = receipt.events.filter((event, index) => event.event === 'command' &&
    event.args === 'status' && index > binding.execution.index);
  assert.equal(statuses.length, 1);
  commandForSnapshot(facts, statuses[0]);
  assert.deepEqual(statuses[0].result, proofs.model_status);
  proofs.supplied_seed = { text: binding.input.seed_yaml, hash: actual.hash };
  if (receipt.case === 'seed-bind') {
    const drift = receipt.events.find(event => event.event === 'fixture' && event.args === 'drift');
    const driftCall = facts.byId.get(drift.call_id);
    assert.ok(driftCall?.execution && driftCall.fixture &&
      driftCall.name === 'oracle_bind_seed' && driftCall.execution.is_error !== true &&
      toolData(driftCall).status === 'seed_bound');
    assert.equal(driftCall.input.seed_yaml, drift.seed_yaml);
    assert.equal(proofs.supplied_seed_drift.call_id, drift.call_id);
    assert.ok(sameScope(proofs.supplied_seed_drift.state.job, resultScope(driftCall)));
    assert.ok(sameScope(drift.state.job, resultScope(driftCall)));
    assertSuppliedSeed(proofs.supplied_seed_drift, driftCall.input.seed_yaml);
    assert.equal(proofs.supplied_seed_drift.result.details.status, 'seed_bound');
    assert.notEqual(proofs.supplied_seed_drift.state.job.seed.hash, actual.hash);
    assert.equal(proofs.supplied_seed_drift.state.job.job_epoch, proofs.model_tool_call.state.job.job_epoch + 1);
  }
  assert.equal(proofs.ended.job.seed, null);
  assert.ok(receipt.provider_calls.length >= 1);
  assert.ok(receipt.provider_calls.every(call => call.model !== 'oracle'));
  if (host) assert.equal(receipt.mock_oracle_runs, 0);
}

export function checkAcceptanceObservation(proof, { real = false, down = false, coordination = false,
  host = false } = {}, facts) {
  const tools = proof.events.filter(event => event.event === 'tool');
  const dispositions = tools.filter(event => event.name === 'oracle_record_stop');
  for (const disposition of dispositions) assert.equal(disposition.result.details.status, 'recorded');
  const consults = tools.filter(event => event.name === 'oracle_consult');
  for (const tool of tools) summarizedCall(facts, tool, tool.name);
  assert.equal(consults.length, facts.consults.length);
  assert.deepEqual(consults.map(event => event.call_id), facts.consults.map(call => call.call_id));
  for (const [index, call] of facts.consults.entries()) oracleDispatches(facts, call, index < (down ? 1 : 4) ? 1 : 0);
  assert.equal(proof.main_finished, true);
  if (!real) assert.equal(proof.fixture_after.implementation, CORRECT);
  assert.equal(proof.fixture_after.test, FIXTURE_TEST);
  assert.equal(proof.events.find(event => event.kind === 'fixture_verification').exit_code, 0);
  assert.equal(tools.find(event => event.name === 'oracle_bind_seed').result.details.status, 'seed_bound');
  if (down) {
    assert.equal(consults.length, 1);
    assert.equal(consults[0].result.details.status, 'unavailable');
    assert.equal(consults[0].result.details.verdict, undefined);
    assert.deepEqual(Object.keys(proof.snapshot.state.job.stops), []);
    assert.ok(proof.events.some(event => event.event === 'result_patch' &&
      event.call_id === facts.consults[0].call_id && event.name === 'oracle_consult' &&
      event.result.content.some(part => part.text?.includes('advice unavailable; work may continue'))));
    assert.equal(proof.snapshot.native_calls.filter(call => call.name === 'task').length, 1);
    assert.equal(proof.oracle_http_calls, 0);
    proof.no_retry = { native_task_dispatches: 1, native_task_send_calls: 0, oracle_http_calls: 0 };
  } else {
    assert.deepEqual(consults.map(event => event.result.details.status),
      ['answered', 'answered', 'answered', 'answered', 'cap_exhausted']);
    if (!real) assert.deepEqual(consults.slice(0, 4).map(event => event.result.details.verdict),
      ['REDIRECT', 'STOP', 'CONTINUE', 'CONTINUE']);
    else assert.ok(consults.slice(0, 4).every(event =>
      ['CONTINUE', 'REDIRECT', 'STOP'].includes(event.result.details.verdict)));
    assert.equal(consults[1].result.details.verdict, 'STOP');
    assert.equal(consults[1].result.details.reasons[0].criterion_id, 'AC1');
    assert.ok(proof.events.some(event => event.event === 'blocked' && event.name === 'edit'));
    assert.equal(dispositions.find(event => facts.byId.get(event.call_id).input.stop_id).result.details.gate_state, 'ACTIVE');
    const disposition = tools.find(event => event.name === 'oracle_record_stop' &&
      event.result.details.stop_id === consults[1].result.details.stop_id);
    assert.equal(disposition.result.details.status, 'recorded');
    assert.equal(disposition.result.details.gate_state, 'ACTIVE');
    if (!real) {
      assert.deepEqual(dispositions.map(event => {
        const call = facts.byId.get(event.call_id);
        return [call.input.redirect_id ?? call.input.stop_id, call.input.decision];
      }), [[consults[0].result.details.redirect_id, 'followed'],
        [consults[1].result.details.stop_id, 'redirect']]);
    }
    assert.equal(tools.find(event => event.name === 'oracle_advisor').result.details.status, 'nudge');
    assert.deepEqual(proof.snapshot.state.job.nudges.map(nudge => nudge.kind), ['failure', 'completion']);
    assert.equal(proof.snapshot.state.job.counters.consults, 4);
    assert.equal(consults[4].result.details.calls_remaining, 0);
    assert.equal(proof.snapshot.native_calls.filter(call => call.name === 'task').length, 4);
    if (proof.oracle_http_calls !== null) assert.equal(proof.oracle_http_calls, 4);
  }
  assert.equal(proof.snapshot.native_calls.filter(call => call.name === 'task_send').length, 0);
  assert.equal(facts.executions.filter(call => call.name === 'task').length, down ? 1 : 4);
  assert.equal(facts.executions.filter(call => call.name === 'task_send').length, 0);
  assert.equal(proof.status_before_end.result.coordination, coordination ? 'present' : 'absent');
  if (coordination) {
    assert.deepEqual(proof.coordination.roster.map(peer => peer.id), ['owned-fixture-peer']);
    assert.ok(proof.coordination.calls.some(call => call.method === 'peers'));
    assert.equal(proof.coordination.calls.filter(call => ['ask', 'notify'].includes(call.method)).length, 0);
  }
  if (host) {
    if (!real && !down) assert.ok(proof.mock_provider_calls.filter(call => call.model === 'oracle').every(call =>
      call.dossier_has_seed && call.dossier_has_prior_verdicts));
    assert.equal(proof.after_end.running, null);
    assert.equal(proof.ended.state.job.status, 'closed');
    retiredOwned(proof);
    for (const entry of proof.receipts) for (const field of RECEIPT_FIELDS) {
      assert.ok(Object.hasOwn(entry, field), field);
    }
    assert.ok(proof.effect_summary && Object.values(proof.effect_summary).every(field =>
      field.source?.artifacts?.includes(proof.evidence)));
    assert.equal(proof.effect_summary.token_savings.value, null);
  }
}

export function checkVisualObservation(receipt, { expectedTools }) {
  receipt.oracle_agent_requests = assertOracleSchemas(receipt.oracle_requests, expectedTools);
  receipt.actual_oracle_tools = receipt.oracle_agent_requests[0].tools;
  receipt.side_requests = receipt.oracle_requests.filter(request => request.purpose !== 'oracle_agent');
  assert.equal(receipt.observation?.status ??
    receipt.events.find(event => event.event === 'result')?.status, 'observed');
  assert.equal(receipt.oracle_task_status, 'completed');
  assert.equal(receipt.preflight.readonly, true);
  assert.ok(receipt.child_tool_calls.every(name => Object.hasOwn(READONLY_ORACLE_TOOLS, name)));
  assert.ok(receipt.oracle_response.length > 0);
}

