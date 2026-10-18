import assert from 'node:assert/strict';
import { verdictClauses } from './verdict-clauses.mjs';
import { clauseTests, commandAcceptanceClauses } from './verdict-clause-tests.mjs';
import { auxFamilies } from './verdict-aux.mjs';
import { policyFamily } from './verdict-policy.mjs';
import { admitScenario, assertHeldExecutions } from './scenario-verdict.mjs';
import {
  checkStopObservation, checkNudgeObservation, checkSeedObservation,
  checkAcceptanceObservation,
} from './verdict-primary.mjs';

// Drivers collect evidence; this table is the only product verdict boundary.
// A row retains the exact plan quotation rather than a second prose contract.
const primaryFamilies = [
  { family: 'stop', todos: [8], cases: ['stop-real', 'stop-forged'],
    behavioral: checkStopObservation,
    evidence_fields: ['events[].call_id', 'events[].record.stop_id', 'events[].record.job_id',
      'events[].operation_id', 'events[].scope_id', 'events[].evidence_id',
      'events[].snapshot_call_id', 'events[].retirement',
      'blocked', 'state.job', 'fixture_after', 'settle'] },
  { family: 'nudge', todos: [9], cases: ['nudge-real', 'nudge-inactive'],
    behavioral: checkNudgeObservation,
    evidence_fields: ['events[].call_id', 'events[].parent_id', 'events[].result',
      'snapshot.state.job.nudges[].tool_call_ids', 'receipts'] },
  { family: 'seed', todos: [10], cases: ['seed-bind', 'seed-invalid'],
    behavioral: checkSeedObservation,
    evidence_fields: ['events[].call_id', 'events[].input.seed_yaml',
      'proofs.model_tool_call.tool_call_id', 'proofs.supplied_seed_drift.call_id',
      'proofs.model_tool_call.state.job.seed', 'proofs.supplied_seed_drift.state.job.seed'] },
  { family: 'acceptance', todos: [13], cases: ['acceptance', 'acceptance-oracle-down'],
    behavioral: checkAcceptanceObservation,
    evidence_fields: ['events[].command_id', 'events[].record.job_id', 'events[].call_id',
      'events[].parent_id', 'events[].record.stop_id', 'events[].argv', 'fixture_after', 'snapshot'] },
];
const families = [...primaryFamilies, policyFamily, ...auxFamilies];

function clauseCases(clause, owners) {
  const all = [...new Set(owners.flatMap(family => family.cases))];
  const id = clause.id;
  if (commandAcceptanceClauses[id]) return ['command-acceptance'];
  if (clauseTests[id]) return ['unit-acceptance'];
  if (clause.todo === 3) return [clause.section === 'qa-failure' ? 'lifecycle-killswitch' : 'lifecycle'];
  if (clause.todo === 4) return clause.section === 'qa-failure'
    ? ['trigger-success-between'] : ['trigger-real', 'trigger-real-powershell'];
  if (clause.todo === 6) {
    if (id.includes('.qa-happy.end-no-')) return ['resident-3', 'lifecycle-retirement'];
    if (id.includes('.qa-happy.')) return ['resident-3'];
    if (id.includes('.dead-')) return ['resident-dead'];
    if (id.includes('.stuck-')) return ['resident-stuck', 'cancel-after-promotion', 'answered-error-words'];
    if (id.includes('.shutdown-')) return ['shutdown-inflight'];
    if (id.includes('.cache-')) return ['consult-cache-budget'];
  }
  if (clause.todo === 8) return [clause.section === 'qa-failure' ? 'stop-forged' : 'stop-real'];
  if (clause.todo === 9) return [clause.section === 'qa-failure' ? 'nudge-inactive' : 'nudge-real'];
  if (clause.todo === 10) return [clause.section === 'qa-failure' ? 'seed-invalid' : 'seed-bind'];
  if (clause.todo === 11) {
    if (id.includes('.visual-')) return ['oracle-consumer-visual'];
    if (id.includes('.per-range-')) return ['policy-uninstall-after-unrelated-edit'];
    if (id.includes('.project-')) return ['oracle-project-override-write'];
    if (id.includes('.switched-')) return ['oracle-profile-switch'];
    return [clause.section === 'qa-failure' ? 'oracle-write-attempt' : 'oracle-readonly'];
  }
  if (clause.todo === 13) return [clause.section === 'qa-failure' ? 'acceptance-oracle-down' : 'acceptance'];
  if (clause.todo >= 17) {
    if (id.includes('native-rejection')) return ['consult-native-rejection'];
    if (id.includes('admission-replay')) return ['consult-admission-replay'];
    if (id.includes('not-readonly')) return ['consult-not-readonly'];
    if (id.includes('no-job')) return ['consult-no-job'];
    if (id.includes('consult-cap') || id.endsWith('real-cap')) return ['consult-cap'];
    if (id.includes('consult-real') || id.endsWith('real-consult')) return ['consult-real'];
  }
  return all;
}

function unitAdmission(clause, observation) {
  const requirements = clauseTests[clause.id];
  assert.ok(requirements?.length, `No unit proof for ${clause.id}`);
  const records = observation.events.filter(event => event.event === 'unit_test');
  const proofs = requirements.map(requirement => {
    const completed = records.filter(record => ['passed', 'failed'].includes(record.kind) &&
      record.file === requirement.file &&
      (requirement.pattern ? new RegExp(requirement.name).test(record.name) : record.name === requirement.name));
    assert.ok(completed.length, `${clause.id}: test not reached: ${requirement.file}: ${requirement.name}`);
    return completed.map(record => {
      const attempts = records.filter(attempt => attempt.kind === 'attempt' && attempt.test_id === record.test_id &&
        attempt.file === record.file && attempt.name === record.name);
      assert.equal(attempts.length, 1, `${clause.id}: test identity is ambiguous`);
      assert.ok(records.indexOf(attempts[0]) < records.indexOf(record));
      return record;
    });
  }).flat();
  return proofs;
}

function commandAdmission(observation) {
  const root = observation.events.find(event => event.event === 'check' && event.kind === 'attempt' &&
    event.request_id === observation.run_id);
  assert.ok(root, 'The check command was not observed.');
  return ['test', 'build'].map(stage => {
    const id = `${observation.run_id}/${stage}`;
    const starts = observation.events.filter(event => event.event === 'check_child' &&
      event.kind === 'attempt' && event.request_id === id && event.parent_request_id === root.request_id);
    const ends = observation.events.filter(event => event.event === 'check_child' &&
      event.kind === 'settled' && event.request_id === id && event.parent_request_id === root.request_id);
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].pid, ends[0].pid);
    assert.ok(Number.isInteger(starts[0].pid));
    assert.deepEqual(starts[0].argv, ends[0].argv);
    assert.ok(observation.events.indexOf(starts[0]) < observation.events.indexOf(ends[0]));
    return ends[0];
  });
}

export const verdictSpec = verdictClauses.map(clause => {
  const owners = families.filter(family => family.todos.includes(clause.todo));
  assert.ok(owners.length, `No predicate family for ${clause.id}`);
  const cases = clauseCases(clause, owners);
  const familyFor = context => {
    const family = owners.find(candidate => candidate.cases.includes(context.caseName));
    assert.ok(family, `No case predicate for ${clause.id}: ${context.caseName}`);
    return family;
  };
  return Object.freeze({
    ...clause, cases,
    proof_tests: clauseTests[clause.id] ?? [],
    evidence_fields: cases.includes('command-acceptance')
      ? ['events[].request_id', 'events[].parent_request_id', 'events[].pid', 'events[].argv', 'events[].exit_code']
      : cases.includes('unit-acceptance')
      ? ['events[].test_id', 'events[].file', 'events[].name', 'events[].kind', 'test_exit_code']
      : [...new Set(owners.flatMap(family => family.evidence_fields)),
        ...(clause.id === 't13.acceptance.observed-effect-fields'
          ? ['effect_summary.direction_changes', 'receipts[].redirect_id', 'receipts[].verdict_changed_direction'] : [])],
    admission(context) {
      if (context.caseName === 'command-acceptance') {
        context.facts = commandAdmission(context.observation);
        return context.facts;
      }
      if (context.caseName === 'unit-acceptance') {
        context.facts = unitAdmission(clause, context.observation);
        return context.facts;
      }
      const family = familyFor(context);
      context.facts = family.admission
        ? family.admission(context.observation, { ...context.options, caseName: context.caseName })
        : admitScenario(context.caseName, context.observation, context.options);
      return context.facts;
    },
    behavioral(context) {
      if (context.caseName === 'command-acceptance') {
        for (const child of context.facts) assert.equal(child.exit_code, 0);
        assert.ok(context.facts[0].argv.includes('--test'));
        assert.equal(context.facts[1].argv.at(-1), 'scripts/build.mjs');
        return;
      }
      if (context.caseName === 'unit-acceptance') {
        assert.equal(context.observation.test_exit_code, 0);
        for (const proof of context.facts) {
          assert.equal(proof.kind, 'passed', clause.id);
          assert.equal(proof.skipped, false, clause.id);
          assert.equal(proof.todo, false, clause.id);
        }
        return;
      }
      const family = familyFor(context);
      if (!family.admission) assertHeldExecutions(context.observation.events);
      const result = family.behavioral(context.observation,
        { ...context.options, caseName: context.caseName }, context.facts);
      if (clause.id === 't13.acceptance.observed-effect-fields' &&
          context.options.host && !context.options.real) {
        const proof = context.observation;
        const first = context.facts.consults[0];
        const redirect_id = first.execution.result.details.redirect_id;
        assert.equal(typeof redirect_id, 'string');
        const followed = context.facts.executions.find(call => call.name === 'oracle_record_stop' &&
          call.input.redirect_id === redirect_id && call.input.decision === 'followed');
        assert.ok(followed, 'Scripted main must record the REDIRECT as followed.');
        assert.equal(followed.execution.result.details.status, 'recorded');
        const receipts = proof.receipts.filter(entry => entry.request_id === first.call_id);
        assert.equal(receipts.findLast(entry => entry.event === 'consult_effect')?.verdict_changed_direction, true);
        const counts = proof.effect_summary.direction_changes.value;
        assert.deepEqual(counts, { changed: 2, not_changed: 2, unknown: 0 });
        assert.equal(proof.effect_summary.verdict_changed_direction.value, counts.changed);
      }
      return result;
    },
  });
});

export function evaluateRow(row, observation, options = {}) {
  const caseName = options.caseName ?? observation.case;
  const context = { caseName, observation, options };
  let phase = 'admission';
  try {
    row.admission(context);
    phase = 'behavioral';
    row.behavioral(context);
    return { id: row.id, plan_line: row.plan_line, admission: true, behavioral: true };
  } catch (error) {
    error.verdict_row = row.id;
    error.verdict_phase = phase;
    error.plan_line = row.plan_line;
    throw error;
  }
}

export function evaluateVerdict(caseName, observation, options = {}) {
  const rows = verdictSpec.filter(row => row.cases.includes(caseName));
  assert.ok(rows.length, `No verdict specification for ${caseName}`);
  observation.verdict_rows = [];
  for (const row of rows) observation.verdict_rows.push(evaluateRow(row, observation, { ...options, caseName }));
  return observation.verdict_rows;
}

export function observeVerdict(caseName, observation, options = {}) {
  observation.gate_deciding = false;
  try {
    evaluateVerdict(caseName, observation, { ...options, real: true });
    observation.verdict_observation = { scenario_reached: true, matches_scripted_contract: true };
  } catch (error) {
    if (!['scenario_not_reached', 'ERR_ASSERTION'].includes(error.code)) throw error;
    observation.verdict_observation = {
      scenario_reached: error.verdict_phase === 'behavioral', matches_scripted_contract: false,
      code: error.code, row: error.verdict_row, phase: error.verdict_phase, message: error.message,
      admission: error.admission ?? null,
    };
  }
  return observation.verdict_observation;
}
