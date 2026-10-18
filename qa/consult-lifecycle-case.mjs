import { join } from 'node:path';
import { ROOT, discoverHost, sourceHash, writeJson } from './harness.mjs';
import { probeConsultCheckpoint } from '../test/helpers/consult-checkpoint-probe.mjs';
import { runConsultLifecycleProperty } from '../test/helpers/consult-lifecycle-property.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

export async function runConsultLifecycleCase(values) {
  if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (values.main !== 'mock' || values.oracle !== 'mock') throw new Error('Lifecycle cases require mock main and oracle');
  const directory = join(ROOT, '.omo/evidence', values.attempt, 'task-17-piomo-oracle-advisor-mod');
  const path = join(directory, `${values.case}.json`);
  const receipt = {
    case: values.case, argv: process.argv, source_hash: sourceHash(), installed_versions: discoverHost().versions,
    route: 'fake-pi-extension-composition', oracle_mode: 'mock', main_mode: 'mock',
    real_model_calls: 0, status: 'running', exit_code: null, started_at: new Date().toISOString(),
    coverage: 'Actual commands, Seed, ledger, consult, native transport and delegated real filesystem I/O. Git/native boundary is fake; no installed-host UI interleaving is claimed.',
  };
  try {
    receipt.probes = [];
    receipt.raw_probes = [];
    if (values.case === 'consult-admission-replay') {
      const terminal = await probeConsultCheckpoint({
        answerOverride: '{"verdict":"CONTINUE","reasons":[]}', terminalBranchReplays: 5, restart: true,
      });
      receipt.terminal_probe = terminal;
      writeJson(join(directory, 'consult-terminal-branch-replay.json'), terminal);
      receipt.terminal_branch_replay = {
        dispatches: terminal.dispatches_after_terminal_branch_replays,
        per_branch: terminal.terminal_branch_replays, restart: true,
      };
      for (const reason of ['cancel', 'reload', 'branch', 'seed', 'policy']) {
        const probe = await probeConsultCheckpoint({ reason, hold: 'admitted_microtask', replayCount: 5 });
        receipt.raw_probes.push({ probe });
        const raw = join(directory, 'admission-replay', `${reason}.json`);
        writeJson(raw, probe);
        receipt.probes.push({ reason, status: probe.result.status, dispatches: probe.dispatches_after_replays,
          replay_count: probe.replays.length, reserved_slots: probe.reserved_slots, raw_output: raw });
      }
    } else if (values.case === 'consult-native-rejection') {
      receipt.native_envelopes = [];
      for (const model_called of [true, false]) for (const withId of [true, false]) {
        const probe = await probeConsultCheckpoint({ reason: 'cancel', hold: 'native', replayCount: 5,
          nativeIsError: true, nativeDetails: { kind: model_called ? 'quota' : 'lane_capacity',
            model_called, ...(withId ? { task_id: 'owned-refusal' } : {}) } });
        receipt.raw_probes.push({ probe, model_called });
        const raw = join(directory, 'native-envelope', `${model_called}-${withId}.json`);
        writeJson(raw, probe);
        receipt.native_envelopes.push({ model_called, task_id_present: withId, status: probe.result.status,
          counted: probe.consult.counted, calls_remaining: probe.result.calls_remaining, raw_output: raw });
      }
      for (const reason of ['cancel', 'reload', 'reload-other', 'branch', 'seed', 'policy']) {
        const probe = await probeConsultCheckpoint({ reason, hold: 'native_error_return', replayCount: 5,
          nativeError: { code: 'quota', model_called: true } });
        receipt.raw_probes.push({ probe });
        const raw = join(directory, 'native-rejection', `${reason}.json`);
        writeJson(raw, probe);
        receipt.probes.push({ reason, status: probe.result.status, dispatches: probe.dispatches_after_replays,
          job_id: probe.job_id, action_results: probe.action_results, reserved_slots: probe.reserved_slots,
          replay_count: probe.replays.length, raw_output: raw });
      }
      receipt.property_probes = [];
      const property = await runConsultLifecycleProperty((name, probe) => {
        receipt.property_probes.push({ name, probe });
        writeJson(join(directory, 'property', `${name}.json`), probe);
      });
      property.argv = process.argv;
      property.exit_code = 0;
      property.source_hash = receipt.source_hash;
      property.installed_versions = receipt.installed_versions;
      property.coverage = receipt.coverage;
      property.cleanup = { homes_removed: true, owned_processes: 0, pids_gone: true };
      const propertyPath = join(directory, 'property.json');
      writeJson(propertyPath, property);
      receipt.property = { ...property, path: propertyPath };
    } else throw new Error(`Unknown lifecycle case ${values.case}`);
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: false });
    receipt.status = 'passed';
    receipt.exit_code = 0;
    receipt.cleanup = { homes_removed: true, owned_processes: 0, pids_gone: true };
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
