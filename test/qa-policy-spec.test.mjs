import assert from 'node:assert/strict';
import test from 'node:test';
import { policyFamily } from '../qa/verdict-policy.mjs';
import { evaluateVerdict, verdictSpec } from '../qa/verdict-spec.mjs';
import { visualObservation, visualTools } from './helpers/scenario-fixtures.mjs';

const configEvidence = () => ({
  original: '// owner comment\n{}\n', dry_run_after: '// owner comment\n{}\n',
  dry_run_manifest_exists: false, applied_effective: { readonly: true },
});
function staticObservation(caseName) {
  const receipt = { case: caseName, config_evidence: configEvidence(), events: [], oracle_requests: [], real_oracle_runs: 0 };
  if (caseName === 'policy-uninstall-after-unrelated-edit') {
    receipt.uninstall = { status: 'restored' };
    receipt.uninstall_evidence = { unrelated_prefix: '// unrelated\r\n',
      after: '// unrelated\r\n' + receipt.config_evidence.original };
  } else if (caseName === 'oracle-project-override-write') {
    receipt.project_override = { file: 'C:/qa/.omo/omo.jsonc',
      document: { '[native]': { agents: { oracle: { tools: { write: true } } } } } };
    receipt.dry_run_with_override = { sources: [{ file: receipt.project_override.file }] };
    receipt.refusal = { status: 'oracle_not_readonly', unsafe_tools: ['write'] };
  } else {
    receipt.profile_evidence = { profiles: ['one', 'two'], before: '{}\n', after: '{}\n' };
    receipt.switches = ['one', 'two'].map(profile =>
      ({ profile, effective: { readonly: true }, root_still_governs: true, needs_all_profiles: false }));
    receipt.all_profiles_dry_run = { status: 'dry_run' };
    receipt.all_profiles_repair = { status: 'applied' };
    receipt.unsafe_switched_profile = { status: 'oracle_not_readonly' };
    receipt.repaired_switched_profile = { readonly: true };
  }
  return receipt;
}
function runtimeObservation(caseName) {
  const receipt = visualObservation();
  receipt.case = caseName;
  receipt.config_evidence = configEvidence();
  receipt.schema_diagnostics = [];
  receipt.actual_oracle_tools = visualTools;
  receipt.file_exists = false;
  const action = caseName === 'oracle-readonly' ? 'surface' : caseName === 'oracle-write-attempt' ? 'write' : 'image';
  for (const event of receipt.events) {
    if (event.input?.action) event.input.action = action;
    if (event.action) event.action = action;
    if (event.result?.details?.action) event.result.details.action = action;
  }
  receipt.observation = receipt.events.find(event => event.event === 'result');
  return receipt;
}
const run = (receipt, options = {}) => evaluateVerdict(receipt.case, receipt, { expectedTools: visualTools, ...options });

test('policy family assigns all six cases to todo 11 with both predicates and evidence', () => {
  assert.equal(policyFamily.family, 'policy');
  assert.deepEqual(policyFamily.todos, [11]);
  assert.equal(policyFamily.cases.length, 6);
  assert.equal(typeof policyFamily.admission, 'function');
  assert.equal(typeof policyFamily.behavioral, 'function');
  assert.ok(policyFamily.evidence_fields.includes('oracle_requests[].response_id'));
  for (const name of policyFamily.cases) assert.ok(verdictSpec.some(row => row.todo === 11 && row.cases.includes(name)));
});

for (const caseName of policyFamily.cases) {
  const make = () => caseName.startsWith('oracle-') && !['oracle-project-override-write', 'oracle-profile-switch'].includes(caseName)
    ? runtimeObservation(caseName) : staticObservation(caseName);
  test(`${caseName} passes the same table in mock and real mode`, () => {
    for (const real of [false, true]) {
      const receipt = make();
      run(receipt, { real, stage: 'preflight' });
      const rows = run(receipt, { real });
      assert.ok(rows.length && rows.every(row => row.admission && row.behavioral));
    }
  });
  for (const [label, mutate] of [
    ['dry-run changed bytes', receipt => { receipt.config_evidence.dry_run_after += ' '; }],
    ['dry-run wrote manifest', receipt => { receipt.config_evidence.dry_run_manifest_exists = true; }],
    ['installed writable policy', receipt => { receipt.config_evidence.applied_effective.readonly = false; }],
  ]) test(`${caseName} rejects ${label} through a table row`, () => {
    const receipt = make();
    mutate(receipt);
    assert.throws(() => run(receipt, { stage: 'preflight' }), error =>
      error.verdict_phase === 'behavioral' && verdictSpec.some(row => row.id === error.verdict_row && row.todo === 11));
  });
}

for (const caseName of ['oracle-readonly', 'oracle-write-attempt', 'oracle-consumer-visual']) {
  for (const [label, mutate] of [
    ['missing challenge', receipt => { receipt.events = []; }],
    ['unrelated probe result', receipt => {
      receipt.events.find(event => event.kind === 'executed' && event.name === 'probe_oracle').result.details.id = 'other';
    }],
    ['unrelated native child', receipt => {
      receipt.events.find(event => event.kind === 'executed' && event.name === 'task').result.details.task_id = 'other';
    }],
    ['unrelated native parent', receipt => {
      receipt.events.find(event => event.kind === 'attempt' && event.name === 'task').parent_id = null;
    }],
    ['unrelated provider response', receipt => { receipt.oracle_requests[0].response_id = 'other'; }],
    ['duplicate provider response', receipt => { receipt.oracle_requests.push(structuredClone(receipt.oracle_requests[0])); }],
    ['unrelated tool result', receipt => { receipt.child_entries[1].message.toolCallId = 'other'; }],
    ['hidden mutating tool', receipt => { receipt.child_entries[0].message.content[0].name = 'write'; }],
    ['unrelated answer', receipt => { receipt.oracle_response = 'An answer from a different child.'; }],
    ['writable schema', receipt => { receipt.oracle_requests[0].tools = [...visualTools, 'write']; }],
    ['running child', receipt => { receipt.oracle_task_status = 'running'; }],
  ]) test(`${caseName} rejects ${label} through a table row`, () => {
    const receipt = runtimeObservation(caseName);
    mutate(receipt);
    assert.throws(() => run(receipt), error =>
      verdictSpec.some(row => row.id === error.verdict_row && row.todo === 11));
  });
  test(`${caseName} preflight does not substitute for final scenario admission`, () => {
    const receipt = runtimeObservation(caseName);
    receipt.events = [];
    run(receipt, { stage: 'preflight' });
    assert.throws(() => run(receipt), { code: 'scenario_not_reached' });
    receipt.schema_diagnostics = ['unsafe schema'];
    assert.throws(() => run(receipt, { stage: 'preflight' }));
  });
}

for (const [caseName, label, mutate] of [
  ['policy-uninstall-after-unrelated-edit', 'changed owner bytes', receipt => { receipt.uninstall_evidence.after += '\n'; }],
  ['policy-uninstall-after-unrelated-edit', 'drifted restore', receipt => { receipt.uninstall.status = 'drift'; }],
  ['oracle-project-override-write', 'omitted project source', receipt => { receipt.dry_run_with_override.sources = []; }],
  ['oracle-project-override-write', 'accepted write', receipt => { receipt.refusal.status = 'readonly'; }],
  ['oracle-project-override-write', 'dispatched child', receipt => {
    receipt.events.push({ kind: 'attempt', name: 'task', call_id: 'unexpected' });
  }],
  ['oracle-project-override-write', 'provider call', receipt => { receipt.oracle_requests.push({ response_id: 'unexpected' }); }],
  ['oracle-profile-switch', 'unrelated profile', receipt => { receipt.switches[1].profile = 'other'; }],
  ['oracle-profile-switch', 'permissive profile hidden by summary', receipt => { receipt.switches[0].effective.readonly = false; }],
  ['oracle-profile-switch', 'changed config bytes', receipt => { receipt.profile_evidence.after += ' '; }],
  ['oracle-profile-switch', 'unsafe switched profile accepted', receipt => { receipt.unsafe_switched_profile.status = 'readonly'; }],
  ['oracle-profile-switch', 'unsuccessful repair', receipt => { receipt.repaired_switched_profile.readonly = false; }],
]) test(`${caseName} rejects ${label} from its captured operands`, () => {
  const receipt = staticObservation(caseName);
  mutate(receipt);
  assert.throws(() => run(receipt), error =>
    verdictSpec.some(row => row.id === error.verdict_row && row.todo === 11));
});

test('write-attempt verdict rejects a created file even when no write tool was advertised', () => {
  const receipt = runtimeObservation('oracle-write-attempt');
  receipt.file_exists = true;
  assert.throws(() => run(receipt), error => error.verdict_phase === 'behavioral');
});

test('host verdict requires retirement of the actual child and no surviving resident handle', () => {
  const make = () => {
    const receipt = runtimeObservation('oracle-readonly');
    receipt.retired_tasks = [{ status: 'completed', residency_state: 'persisted_only' }];
    receipt.retirement = { retired: [{ id: receipt.child_task_id,
      output: { details: { snapshot: receipt.retired_tasks[0] } } }] };
    return receipt;
  };
  run(make(), { host: true });
  for (const mutate of [
    receipt => { delete receipt.retirement; },
    receipt => { receipt.retirement.retired[0].id = 'other'; },
    receipt => { receipt.retired_tasks[0].status = 'running'; },
    receipt => { receipt.retired_tasks[0].resident_handle = 'still-live'; },
    receipt => { receipt.retired_tasks = [{ status: 'completed', residency_state: 'disposed' }]; },
  ]) {
    const receipt = make();
    mutate(receipt);
    assert.throws(() => run(receipt, { host: true }));
  }
});
