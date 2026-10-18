const execution = (value, id) => value.events.find(event => event.kind === 'executed' && event.call_id === id);
const attempt = (value, id) => value.events.find(event => event.kind === 'attempt' && event.call_id === id);
const ownedCancel = (value, resolved = true) => {
  const at = value.events.findIndex(event => event.kind === 'attempt' && event.name === 'oracle_record_stop');
  value.events.splice(at, 0,
    { event: 'evidence', kind: 'ledger', record: {
      type: 'oracle_assigned', job_id: 'J1', oracle_task_id: 'st_consult',
    } },
    { event: 'evidence', kind: 'attempt', name: 'task_cancel', call_id: 'cancel-by-name',
      input: { name: 'owned-advisor' }, cwd: 'C:/qa' },
    { event: 'evidence', kind: 'executed', name: 'task_cancel', call_id: 'cancel-by-name',
      result: { structuredContent: resolved ? { task_id: 'st_consult' } : {} }, is_error: false });
};
export const reviewMutants = [
  ['stop-cancel-by-name-inside-hold', 'stop-real', value => ownedCancel(value, false)],
  ['owned-cancel-resolved-target', 'stop-real', value => ownedCancel(value)],
  ['stop-duplicate-preflight-identity', 'stop-real', value => {
    value.events.splice(1, 0, structuredClone(attempt(value, 'held-edit')));
  }],
  ['nudge-different-error-classes', 'nudge-real', value => {
    execution(value, 'failure-1').result.structuredContent = { exit_code: 1 };
    execution(value, 'failure-2').result.structuredContent = { exit_code: 2 };
    value.snapshot.state.job.nudges[0].error_class = 'exit:2';
  }],
  ['nudge-notice-on-first-failure', 'nudge-real', value => {
    const patch = value.events.find(event => event.event === 'result_patch');
    value.events.splice(value.events.indexOf(patch), 1);
    patch.call_id = 'failure-1';
    value.events.splice(value.events.indexOf(attempt(value, 'failure-2')), 0, patch);
  }],
  ['seed-drift-stored-bytes-and-hash-disagree-with-input', 'seed-bind', value => {
    value.proofs.supplied_seed_drift.state.job.seed.text = 'goal: Wrong stored drift bytes\nacceptance_criteria:\n  - Wrong value\n';
    value.proofs.supplied_seed_drift.state.job.seed.hash = '0'.repeat(64);
  }],
  ['seed-model-execution-error-retains-success-status', 'seed-bind', value => {
    execution(value, 'model-bind').is_error = true;
  }],
  ['acceptance-no-job-open-evidence', 'acceptance', value => {
    value.events = value.events.filter(event => event.record?.type !== 'job_opened' &&
      !(event.name === 'oracle' && event.args === 'on' &&
        ['command_start', 'command_end'].includes(event.kind)));
  }],
  ['acceptance-independent-command-is-a-noop', 'acceptance', value => {
    value.events.find(event => event.kind === 'fixture_verification').argv =
      ['node', '-e', 'process.exit(0)', 'fixture.test.mjs'];
  }],
  ['visual-read-result-has-another-call-id', 'oracle-consumer-visual', value => {
    value.child_entries[1].message.toolCallId = 'unrelated-read';
  }],
  ['visual-consumer-uses-another-image-digest', 'oracle-consumer-visual', value => {
    value.oracle_requests[1].image_sha256s = ['0'.repeat(64)];
  }],
];

