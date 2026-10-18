import { join } from 'node:path';
import { ROOT, discoverHost, sourceHash, writeJson } from './harness.mjs';
import { probeReservedConsult } from '../test/helpers/consult-reservation-probe.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

export async function runConsultReservationCase(values) {
  if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (values.oracle !== 'mock' || values.main !== 'mock') throw new Error('Reservation probes require mock main and oracle');
  const path = join(ROOT, '.omo/evidence', values.attempt, 'task-7-piomo-oracle-advisor-mod', `${values.case}.json`);
  const receipt = {
    case: values.case, argv: process.argv, source_hash: sourceHash(),
    installed_versions: discoverHost().versions,
    route: 'fake-pi-extension-composition', oracle_mode: 'mock', main_mode: 'mock',
    real_oracle_runs: 0, status: 'running', exit_code: null,
    coverage: 'Actual lifecycle, commands, consult, ledger, protocol and transport; fake git/native task boundary, no host UI race.',
  };
  try {
    receipt.probe = await probeReservedConsult(values.case);
    const probe = receipt.probe;
    receipt.verdict = evaluateVerdict(values.case, receipt, { real: false });
    receipt.cleanup = probe.cleanup;
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
