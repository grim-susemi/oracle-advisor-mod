import { assertStopObservation } from '../../qa/stop-case.mjs';
import { assertNudgeObservation } from '../../qa/nudger-case.mjs';
import { assertSeedObservation } from '../../qa/cases/seed.mjs';
import { assertAcceptanceObservation } from '../../qa/cases/acceptance.mjs';
import { assertVisualObservation } from '../../qa/oracle-policy-case.mjs';
import { acceptanceObservation, detail, nudgeObservation, seedObservation, skill, stopObservation, visualObservation, visualTools } from './scenario-fixtures.mjs';
export const drivers = {
  'stop-real': { make: () => stopObservation(), verdict: value => assertStopObservation(value, { real: true }) },
  'stop-forged': { make: () => stopObservation('stop-forged'), verdict: value => assertStopObservation(value, { real: true }) },
  'nudge-real': { make: () => nudgeObservation(), verdict: value => assertNudgeObservation(value, { real: true }) },
  'nudge-inactive': { make: () => nudgeObservation(false), verdict: value => assertNudgeObservation(value, { real: true }) },
  'seed-bind': { make: () => seedObservation(), verdict: value => assertSeedObservation(value, { real: true, skill }) },
  'seed-invalid': { make: () => seedObservation('seed-invalid'), verdict: value => assertSeedObservation(value, { real: true, skill }) },
  acceptance: { make: () => acceptanceObservation(), verdict: value => assertAcceptanceObservation(value, { real: true }) },
  'acceptance-oracle-down': { make: () => acceptanceObservation(true),
    verdict: value => assertAcceptanceObservation(value, { real: true, down: true }) },
  'oracle-consumer-visual': { make: () => visualObservation(), verdict: value => assertVisualObservation(value, visualTools) },
};
const removeCall = (value, id) => {
  value.events = value.events.filter(event => event.call_id !== id && event.tool_call_id !== id &&
    event.parent_id !== id);
};
const escapedEdit = (value, id = 'escape') => {
  const at = value.events.findIndex(event => event.kind === 'attempt' && event.name === 'oracle_record_stop' &&
    event.input?.stop_id);
  const end = value.events.findIndex(event => event.kind === 'agent_end');
  const index = at < 0 ? end < 0 ? value.events.length : end : at;
  value.events.splice(index, 0,
    { event: 'evidence', kind: 'attempt', name: 'edit', call_id: id, input: {
      path: 'fixture.txt', oldText: id === 'restore' ? 'changed' : 'protected',
      newText: id === 'restore' ? 'protected' : 'changed',
    }, cwd: 'C:/qa' },
    { event: 'evidence', kind: 'executed', name: 'edit', call_id: id, is_error: false, result: detail({}) });
};
export const matrix = [
  ['old-stop-bypass', 'stop-real', value => { value.blocked = []; }],
  ['old-forged-override', 'stop-forged', value => { value.state.job.gate_state = 'ACTIVE'; value.state.job.overrides.push({ actor: 'owner' }); }],
  ['old-nudge-missing', 'nudge-real', value => { value.events = value.events.filter(event => event.event !== 'result_patch'); }],
  ['old-nudge-extra', 'nudge-inactive', value => { value.events.push({ event: 'result_patch' }); }],
  ['stop-partial-escape', 'stop-real', escapedEdit],
  ['stop-missing-rename', 'stop-real', value => removeCall(value, 'held-rename')],
  ['forged-write-restore', 'stop-forged', value => { escapedEdit(value); escapedEdit(value, 'restore'); value.fixture_after = 'protected\n'; }],
  ['forged-missing-read', 'stop-forged', value => {
    const read = value.events.find(event => event.kind === 'attempt' && event.name === 'read');
    removeCall(value, read.call_id);
  }],
  ['nudge-corrupt-patch', 'nudge-real', value => { value.events.find(event => event.event === 'result_patch').structured_preserved = false; }],
  ['nudge-missing-finish', 'nudge-real', value => removeCall(value, 'finish')],
  ['inactive-missing-failures', 'nudge-inactive', value => { removeCall(value, 'failure-1'); removeCall(value, 'failure-2'); }],
  ['inactive-missing-finish', 'nudge-inactive', value => removeCall(value, 'finish')],
  ['violation-then-disposition', 'stop-real', escapedEdit],
  ['violation-then-restore', 'stop-forged', value => { escapedEdit(value); escapedEdit(value, 'restore'); }],
  ['guarded-executed-error', 'stop-real', value => {
    escapedEdit(value);
    value.events.find(event => event.kind === 'executed' && event.call_id === 'escape').is_error = true;
  }],
  ['challenge-before-hold', 'stop-real', value => {
    const attempt = value.events.find(event => event.kind === 'attempt' && event.call_id === 'held-edit');
    value.events.splice(value.events.indexOf(attempt), 1);
    value.events.splice(value.events.findIndex(event => event.kind === 'ledger' &&
      event.record.type === 'stop_opened'), 0, attempt);
  }],
  ...['write', 'lsp_rename', 'delete', 'bash', 'apply_patch', 'new_mutator'].map(name =>
    [`guarded-${name}-execution`, 'stop-real', value => {
      escapedEdit(value);
      for (const event of value.events.filter(event => event.call_id === 'escape')) event.name = name;
    }]),
  ['seed-stale-model-result', 'seed-bind', value => removeCall(value, 'model-bind')],
  ['seed-unsuccessful-bind', 'seed-bind', value => {
    value.events.find(event => event.kind === 'executed' && event.call_id === 'model-bind').result = detail({ status: 'seed_invalid' });
  }],
  ['seed-missing-drift', 'seed-bind', value => { value.events = value.events.filter(event => event.args !== 'drift'); }],
  ['seed-missing-invalid-challenge', 'seed-invalid', value => { value.events = value.events.filter(event => event.args !== 'ambiguous'); }],
  ['acceptance-missing-completion-consult', 'acceptance', value => removeCall(value, 'completion')],
  ['acceptance-escaped-held-write', 'acceptance', escapedEdit],
  ['acceptance-no-independent-test', 'acceptance', value => { value.events = value.events.filter(event => event.kind !== 'fixture_verification'); }],
  ['down-no-consult', 'acceptance-oracle-down', value => removeCall(value, 'first')],
  ['down-failed-final-test', 'acceptance-oracle-down', value => { value.events.find(event => event.kind === 'fixture_verification').exit_code = 1; }],
  ['visual-unrelated-child-read', 'oracle-consumer-visual', value => { value.child_task_id = 'st_other'; }],
  ['visual-unrelated-fixture-read', 'oracle-consumer-visual', value => { value.child_entries[0].message.content[0].arguments.path = 'C:/qa/other.png'; }],
  ['visual-missing-image-result', 'oracle-consumer-visual', value => { value.child_entries.splice(1, 1); }],
  ['visual-unknown-wire-origin', 'oracle-consumer-visual', value => { value.oracle_requests[1].origin = { kind: 'unknown' }; }],
  ['visual-write-tool', 'oracle-consumer-visual', value => { value.oracle_requests[1].tools = [...visualTools, 'write']; }],
];
for (const [name, driver] of Object.entries(drivers)) {
  matrix.push([`${name}-no-op`, name, value => { value.events = []; }]);
  matrix.push([`${name}-partial`, name, value => { value.events = value.events.slice(0, 3); }]);
}

