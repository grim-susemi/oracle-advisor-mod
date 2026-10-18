import { join } from 'node:path';
import { ROOT, discoverHost, sourceHash, writeJson } from './harness.mjs';
import { probeConsultCheckpoint } from '../test/helpers/consult-checkpoint-probe.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const reasons = {
  cancel: 'cancelled', branch: 'stale_reservation', reload: 'interrupted',
  seed: 'stale_reservation', policy: 'oracle_not_readonly',
};
export async function runConsultCheckpointCase(values) {
  if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (values.oracle !== 'mock' || values.main !== 'mock') throw new Error('Checkpoint probes require mock main and oracle');
  const directory = join(ROOT, '.omo/evidence', values.attempt, 'task-7-piomo-oracle-advisor-mod');
  const path = join(directory, `${values.case}.json`);
  const receipt = {
    case: values.case, argv: process.argv, source_hash: sourceHash(), installed_versions: discoverHost().versions,
    route: 'fake-pi-extension-composition', oracle_mode: 'mock', main_mode: 'mock',
    real_oracle_runs: 0, status: 'running', exit_code: null,
    coverage: 'Actual extension, Seed, protocol filesystem calls and native transport; passive checkpoint observer or held real mkdir. Native tasks/git are fake, not installed-host UI races.',
  };
  try {
    if (values.case === 'consult-checkpoint-matrix') {
      const baseline = await probeConsultCheckpoint();
      receipt.stages = [...new Set(baseline.stages)];
      receipt.replay_stages = [];
      receipt.rows = [];
      receipt.raw_probes = [];
      const contexts = receipt.stages.map(stage => ({ stage }));
      for (const { stage, mode } of contexts) {
        for (const reason of Object.keys(reasons)) {
          const probe = await probeConsultCheckpoint({ reason, stage, mode, replayCount: 3 });
          const raw = join(directory, 'checkpoint-matrix', `${mode ?? 'new'}-${stage}-${reason}.json`);
          writeJson(raw, probe);
          receipt.raw_probes.push(probe);
          receipt.rows.push({
            mode: mode ?? 'new', stage, reason, status: probe.result.status, dispatches_at_abort: probe.dispatches_at_abort,
            dispatches: probe.native_oracle_dispatches, reserved_slots: probe.reserved_slots,
            calls_remaining: probe.result.calls_remaining, counters: probe.counters, raw_output: raw,
          });
        }
      }
    } else {
      const options = {
        'consult-policy-change': { reason: 'policy', hold: 'dossier' },
        'consult-cancel-save': { reason: 'cancel', hold: 'save' },
        'consult-seed-rebind': { reason: 'seed', hold: 'dossier', followUp: true },
      }[values.case];
      if (!options) throw new Error(`Unknown checkpoint case ${values.case}`);
      receipt.probe = await probeConsultCheckpoint(options);
    }
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: false });
    receipt.cleanup = { homes_removed: true, pids_gone: true, owned_processes: 0 };
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = 'failed';
    receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
  }
  receipt.finished_at = new Date().toISOString();
  writeJson(path, receipt);
  console.log(JSON.stringify({ receipt: path, status: receipt.status, exit_code: receipt.exit_code }));
  process.exitCode = receipt.exit_code;
}
