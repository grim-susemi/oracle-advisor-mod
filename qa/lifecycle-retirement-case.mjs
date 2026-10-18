import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ROOT, OwnedProcess, authHashes, cleanupDisposableState, discoverHost, disposableEnvironment,
  hostArgs, sourceHash, writeJson,
} from './harness.mjs';
import { startTransportProvider } from './transport-provider.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const { values } = parseArgs({ options: { attempt: { type: 'string', default: 'a2t6r' } } });
if (!/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name.');
const evidenceDir = join(ROOT, '.omo/evidence', values.attempt, 'task-6r-piomo-oracle-advisor-mod');
mkdirSync(evidenceDir, { recursive: true });
const runDir = mkdtempSync(join(evidenceDir, 'lifecycle-retirement-'));
const host = discoverHost();
const before = authHashes();
const provider = await startTransportProvider(join(runDir, 'provider.jsonl'), [], {
  mainToolCall(text) {
    const target = text.match(/CANCEL_TASK (st_[a-zA-Z0-9_-]+)/)?.[1];
    return target ? { name: 'task_cancel', arguments: { task_id: target, reason: 'oracle-advisor: job_end' } } : undefined;
  },
});
const sandbox = disposableEnvironment(host, runDir, {
  ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_MOCK_URL: provider.baseUrl,
  ORACLE_QA_REAL_ORACLE: '0', OMO_ORACLE_ADVISOR: '1',
  OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
});
writeJson(join(sandbox.home, '.omo/omo.jsonc'), { '[native]': {
  task: { state_dir: join(runDir, 'task-state'), default_execution_mode: 'in-process' },
  agents: { oracle: { model: 'oracle-qa-mock/oracle', tools: { read: true } } },
} });
const args = [...hostArgs(host, sandbox, join(ROOT, 'qa/lifecycle-retirement-extension.mjs'), { main: 'mock' }),
  '--tools', 'qa_transport_run,oracle_consult,task,task_cancel,task_output,read',
  '--system-prompt', 'Call exactly the requested tool once, then report the observation.'];
const child = new OwnedProcess(process.execPath, args, { cwd: sandbox.workDir, env: sandbox.env,
  rawPrefix: join(runDir, 'host'), deadlineMs: 180000 });
const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.lifecycle-retirement' && event.data.event === name;
const receipt = { case: 'lifecycle-retirement', status: 'running', exit_code: null,
  argv: process.argv, host_argv: args, source_hash: sourceHash(), installed_versions: host.versions,
  real_model_calls: 0, run_dir: runDir, scenarios: [], cleanup: {} };
const request = name => child.rpc('extension_request', { name: `oracle.lifecycle.${name}`, data: {} });
async function command(args) {
  const done = child.waitFor(event => (isEvent('command')(event) || isEvent('command_error')(event)) &&
    event.data.args === args, `/oracle ${args}`, { from: child.history.length });
  await child.rpc('prompt', { message: `/oracle ${args}` });
  const result = (await done).data;
  return result;
}
const gone = task => ['completed', 'failed', 'cancelled', 'error', 'lost', 'interrupted', 'timed_out'].includes(task.status) &&
  ['persisted_only', 'disposed'].includes(task.residency_state) &&
  !task.resident && !task.resident_session && !task.resident_handle;
try {
  await child.rpc('get_state');
  await child.waitFor(isEvent('ready'), 'lifecycle fixture ready');
  for (const [index, { action, held }] of [
    { action: 'end', held: false }, { action: 'end', held: true }, { action: 'cancel', held: true },
  ].entries()) {
    await command('on');
    const seeded = child.waitFor(isEvent('seeded'), 'retained owned oracle', { from: child.history.length });
    await child.prompt(`QA_TRANSPORT_RUN_${sandbox.env.ORACLE_QA_NONCE}_${index}_seed`);
    const scenario = { action, held, seeded: (await seeded).data };
    receipt.scenarios.push(scenario);
    if (held) await request('hold');
    const from = child.history.length;
    await child.prompt(`QA_TRANSPORT_RUN_${sandbox.env.ORACLE_QA_NONCE}_${index}_forged CANCEL_TASK ${scenario.seeded.id}`);
    const denied = child.history.slice(from).filter(event =>
      event.type === 'tool_execution_end' && event.toolName === 'task_cancel');
    scenario.denied = denied;
    scenario.model_cancel = denied[0];
    scenario.after_model_cancel = await request('state');
    scenario.command = await command(action);
    scenario.after_owner = await request('state');
    if (action === 'cancel') await command('end');
  }
  receipt.events = child.history.filter(event => event.type === 'extension_event' &&
    event.name === 'oracle-qa.lifecycle-retirement').map(event => event.data);
  receipt.verdict = evaluateVerdict(receipt.case, receipt, { real: false });
  receipt.status = 'passed';
  receipt.exit_code = 0;
} catch (error) {
  receipt.status = 'failed';
  receipt.exit_code = 1;
  receipt.error = { code: error.code, message: error.message, stack: error.stack };
  if (!child.closed) {
    try { receipt.failure_cleanup = await request('cleanup'); }
    catch (cleanupError) { receipt.cleanup.error = cleanupError.message; }
  }
} finally {
  await child.stop({ force: true });
  receipt.process = child.metadata;
  receipt.cleanup.pids_gone = child.metadata.pid_gone;
  await provider.close();
  receipt.provider_calls = provider.requests;
  receipt.cleanup.listener_closed = true;
  receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
  receipt.cleanup.running_oracle_records = receipt.scenarios.flatMap(item => item.after_owner?.tasks ?? []).filter(task => !gone(task)).length;
  receipt.auth_before = before;
  receipt.auth_after = authHashes();
  receipt.auth_unchanged = JSON.stringify(receipt.auth_before) === JSON.stringify(receipt.auth_after);
  if (!receipt.auth_unchanged) { receipt.status = 'auth_changed'; receipt.exit_code = 1; }
  writeJson(join(runDir, 'receipt.json'), receipt);
  writeJson(join(evidenceDir, 'lifecycle-retirement.json'), receipt);
  console.log(JSON.stringify({ status: receipt.status, exit_code: receipt.exit_code,
    receipt: join(evidenceDir, 'lifecycle-retirement.json'), error: receipt.error ?? null }));
  process.exitCode = receipt.exit_code;
}
