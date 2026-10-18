import assert from 'node:assert/strict';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';
import { correlatePolicyOrigins, assertOracleSchemas } from './provider-purpose.mjs';
import {
  admitScenario, assertHeldExecutions, scenarioFacts, toolData,
} from './scenario-verdict.mjs';
import { checkVisualObservation } from './verdict-primary.mjs';

const actions = {
  'oracle-readonly': 'surface',
  'oracle-write-attempt': 'write',
  'oracle-consumer-visual': 'image',
};
const terminal = status => ['completed', 'failed', 'error', 'lost', 'cancelled',
  'interrupted', 'timed_out'].includes(status);
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text')
  .map(part => part.text).join('\n').trim();

function admission(receipt, { caseName = receipt.case, stage, host = false } = {}) {
  assert.ok(policyFamily.cases.includes(caseName), `Unknown policy case: ${caseName}`);
  assert.ok(stage === undefined || stage === 'preflight', `Unknown policy stage: ${stage}`);
  const checks = [];
  const need = (label, value) => checks.push({ label, reached: Boolean(value) });
  if (stage === 'preflight') {
    need('captured_config_bytes', typeof receipt.config_evidence?.original === 'string' &&
      typeof receipt.config_evidence.dry_run_after === 'string');
    need('captured_dry_run_manifest_state', typeof receipt.config_evidence?.dry_run_manifest_exists === 'boolean');
    need('applied_effective_policy', receipt.config_evidence?.applied_effective);
    if (actions[caseName]) need('schema_diagnostics_observed', Array.isArray(receipt.schema_diagnostics));
  } else if (!actions[caseName]) {
    need('captured_config_bytes', typeof receipt.config_evidence?.original === 'string');
    if (caseName === 'policy-uninstall-after-unrelated-edit') {
      need('uninstall_observed', receipt.uninstall && typeof receipt.uninstall_evidence?.after === 'string' &&
        typeof receipt.uninstall_evidence.unrelated_prefix === 'string');
    } else if (caseName === 'oracle-project-override-write') {
      need('project_override_observed', typeof receipt.project_override?.file === 'string' &&
        receipt.project_override.document?.['[native]']?.agents?.oracle?.tools);
      need('override_resolution_observed', receipt.dry_run_with_override?.sources && receipt.refusal);
      need('dispatch_observation', Array.isArray(receipt.events) && Array.isArray(receipt.oracle_requests));
    } else {
      need('profile_switch_observed', Array.isArray(receipt.profile_evidence?.profiles) &&
        typeof receipt.profile_evidence.before === 'string' && typeof receipt.profile_evidence.after === 'string' &&
        Array.isArray(receipt.switches));
      need('unsafe_profile_and_repair_observed', receipt.unsafe_switched_profile &&
        receipt.repaired_switched_profile && receipt.all_profiles_repair && receipt.all_profiles_dry_run);
    }
  } else {
    const facts = caseName === 'oracle-consumer-visual'
      ? admitScenario(caseName, receipt) : scenarioFacts(receipt.events);
    const action = actions[caseName];
    need('fresh_observed_session', facts.records.some(record => record.kind === 'session_start' && record.entries?.length === 0));
    need('correlated_execution_log', facts.integrity);
    const probes = facts.executions.filter(call => call.name === 'probe_oracle' && call.input?.action === action);
    const probe = probes[0];
    need('one_exact_probe_execution', probes.length === 1);
    const results = facts.events.filter(event => event.event === 'result' && event.action === action);
    const observed = results[0];
    need('one_probe_observation', results.length === 1 && (!receipt.observation ||
      receipt.observation.id === observed?.id && receipt.observation.action === action &&
      receipt.observation.status === observed?.status));
    need('owned_child_identity', typeof receipt.child_task_id === 'string' &&
      observed?.id === receipt.child_task_id && toolData(probe).id === receipt.child_task_id &&
      toolData(probe).action === action);
    const tasks = facts.executions.filter(call => call.name === 'task' &&
      call.parent_id === probe?.call_id && call.input?.subagent_type === 'oracle');
    const task = tasks[0];
    need('correlated_native_child_dispatch', tasks.length === 1 && task.index > probe.index &&
      task.execution.index < probe.execution.index &&
      (toolData(task).task_id ?? toolData(task).id) === receipt.child_task_id);
    need('main_completed_after_probe', facts.records.some(record =>
      record.kind === 'agent_end' && record.index > (probe?.execution.index ?? Infinity)));
    need('terminal_owned_child', terminal(receipt.oracle_task_status));
    const child = receipt.child_entries ?? [];
    const requests = receipt.oracle_requests ?? [];
    const calls = child.flatMap((entry, index) => entry.message?.role === 'assistant'
      ? (entry.message.content ?? []).filter(part => part.type === 'toolCall').map(call => ({ ...call, index })) : []);
    const resultsByCall = child.flatMap((entry, index) =>
      entry.message?.role === 'toolResult' ? [{ ...entry.message, index }] : []);
    need('child_tool_result_ids_correlate', new Set(calls.map(call => call.id)).size === calls.length &&
      calls.every(call => typeof call.id === 'string' && resultsByCall.filter(result =>
        result.toolCallId === call.id && result.toolName === call.name && result.index > call.index).length === 1) &&
      resultsByCall.every(result => calls.some(call =>
        call.id === result.toolCallId && call.name === result.toolName && call.index < result.index)));
    const attributed = correlatePolicyOrigins(structuredClone(requests), child, {
      fixture_path: receipt.image_path, fixture_sha256: receipt.image_sha256,
    });
    need('provider_response_ids_correlate', requests.length > 0 && requests.every((request, index) =>
      typeof request.response_id === 'string' &&
      requests.filter(other => other.response_id === request.response_id).length === 1 &&
      ['oracle_agent', 'look_at'].includes(request.origin?.kind) &&
      request.origin.kind === attributed[index].origin.kind && request.purpose === attributed[index].purpose &&
      (request.origin.response_id === undefined || request.origin.response_id === request.response_id) &&
      (request.origin.kind === 'look_at'
        ? request.origin.tool_call_id === attributed[index].origin.tool_call_id
        : child.filter(entry => entry.message?.role === 'assistant' &&
          entry.message.responseId === request.response_id).length === 1)));
    const answer = child.findLast(entry => entry.message?.role === 'assistant' && textOf(entry.message));
    need('answer_from_correlated_child_response', answer && requests.some(request =>
      request.origin?.kind === 'oracle_agent' && request.response_id === answer.message.responseId));
    if (host) need('retirement_observed', Array.isArray(receipt.retirement?.retired) &&
      Array.isArray(receipt.retired_tasks));
    checks.push(...(caseName === 'oracle-consumer-visual' ? receipt.scenario.checks : []));
  }
  receipt.scenario = { name: caseName, stage: stage ?? 'final', checks };
  const missing = checks.filter(check => !check.reached).map(check => check.label);
  if (missing.length) throw Object.assign(new Error(`${caseName}: ${missing.join(', ')}`), { code: 'scenario_not_reached' });
  return checks;
}

function configBehavior(receipt) {
  const evidence = receipt.config_evidence;
  assert.equal(evidence.dry_run_after, evidence.original, 'Policy dry-run must preserve config bytes.');
  assert.equal(evidence.dry_run_manifest_exists, false);
  assert.equal(evidence.applied_effective.readonly, true);
}

function behavioral(receipt, { caseName = receipt.case, stage, expectedTools, host = false } = {}) {
  if (stage === 'preflight' || receipt.config_evidence) configBehavior(receipt);
  if (stage === 'preflight') {
    if (actions[caseName]) assert.deepEqual(receipt.schema_diagnostics, []);
    return;
  }
  if (caseName === 'policy-uninstall-after-unrelated-edit') {
    assert.equal(receipt.uninstall.status, 'restored');
    assert.equal(receipt.uninstall_evidence.after,
      receipt.uninstall_evidence.unrelated_prefix + receipt.config_evidence.original);
  } else if (caseName === 'oracle-project-override-write') {
    assert.equal(receipt.project_override.document['[native]'].agents.oracle.tools.write, true);
    assert.ok(receipt.dry_run_with_override.sources.some(item => item.file === receipt.project_override.file));
    assert.equal(receipt.refusal.status, 'oracle_not_readonly');
    assert.deepEqual(receipt.refusal.unsafe_tools, ['write']);
    assert.equal(receipt.host_process, undefined);
    assert.equal(receipt.events.filter(event => event.kind === 'attempt' && event.name === 'task').length, 0);
    assert.equal(receipt.oracle_requests.length, 0);
    assert.equal(receipt.real_oracle_runs, 0);
  } else if (caseName === 'oracle-profile-switch') {
    assert.ok(receipt.profile_evidence.profiles.length >= 2);
    assert.deepEqual(receipt.switches.map(item => item.profile), receipt.profile_evidence.profiles.slice(0, 2));
    assert.equal(new Set(receipt.switches.map(item => item.profile)).size, 2);
    for (const item of receipt.switches) {
      assert.equal(item.effective.readonly, true);
      assert.equal(item.root_still_governs, item.effective.readonly);
      assert.equal(item.needs_all_profiles, !item.effective.readonly);
    }
    assert.equal(receipt.profile_evidence.after, receipt.profile_evidence.before);
    assert.equal(receipt.unsafe_switched_profile.status, 'oracle_not_readonly');
    assert.equal(receipt.repaired_switched_profile.readonly, true);
  } else {
    assertHeldExecutions(receipt.events);
    assert.ok(Array.isArray(expectedTools));
    if (caseName === 'oracle-consumer-visual') checkVisualObservation(receipt, { expectedTools });
    else {
      receipt.oracle_agent_requests = assertOracleSchemas(receipt.oracle_requests, expectedTools);
      assert.equal(receipt.observation.status, 'observed');
      assert.ok(terminal(receipt.oracle_task_status), 'Oracle must answer within owned QA deadline.');
      assert.ok(receipt.oracle_requests.every(request =>
        JSON.stringify(request.tools) === JSON.stringify(expectedTools)));
      assert.deepEqual(receipt.actual_oracle_tools, expectedTools);
      assert.equal(receipt.preflight.readonly, true);
    }
    const calls = receipt.child_entries.filter(entry => entry.message?.role === 'assistant')
      .flatMap(entry => entry.message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name);
    assert.deepEqual(receipt.child_tool_calls, calls);
    assert.ok(calls.every(name => Object.hasOwn(READONLY_ORACLE_TOOLS, name)));
    const answer = receipt.child_entries.findLast(entry =>
      entry.message?.role === 'assistant' && textOf(entry.message));
    assert.equal(receipt.oracle_response.trim(), textOf(answer.message));
    assert.ok(receipt.oracle_response.length > 0);
    if (caseName === 'oracle-write-attempt') {
      assert.equal(receipt.actual_oracle_tools.includes('write'), false);
      assert.equal(receipt.file_exists, false);
    }
    if (host) {
      assert.deepEqual(receipt.retirement.retired.map(item => item.id), [receipt.child_task_id]);
      assert.deepEqual(receipt.retired_tasks, receipt.retirement.retired.map(item => item.output.details?.snapshot));
      assert.ok(receipt.retired_tasks.every(task => task && terminal(task.status) &&
        ['persisted_only', 'disposed'].includes(task.residency_state) &&
        !task.resident && !task.resident_session && !task.resident_handle));
    }
  }
}

export const policyFamily = {
  family: 'policy', todos: [11],
  cases: ['oracle-readonly', 'oracle-write-attempt', 'oracle-consumer-visual',
    'policy-uninstall-after-unrelated-edit', 'oracle-project-override-write', 'oracle-profile-switch'],
  admission, behavioral,
  evidence_fields: [
    'config_evidence.original', 'config_evidence.dry_run_after', 'config_evidence.dry_run_manifest_exists',
    'config_evidence.applied_effective', 'schema_diagnostics', 'events[].call_id', 'events[].parent_id',
    'events[].result.details.id', 'events[].result.details.task_id', 'child_task_id',
    'child_entries[].message.responseId', 'child_entries[].message.content[].id',
    'child_entries[].message.toolCallId', 'oracle_requests[].response_id', 'oracle_requests[].origin',
    'oracle_requests[].tools', 'image_sha256', 'oracle_response', 'file_exists',
    'uninstall_evidence.after', 'uninstall_evidence.unrelated_prefix', 'project_override',
    'dry_run_with_override.sources', 'refusal', 'profile_evidence', 'switches[].profile',
    'switches[].effective', 'unsafe_switched_profile', 'repaired_switched_profile',
    'retirement.retired[].id', 'retirement.retired[].output.details.snapshot', 'retired_tasks',
  ],
};
