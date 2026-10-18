import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { REGISTRATION_KEY } from '../../src/extension.mjs';
import { createFakePi } from './fake-pi.mjs';

const seed = goal => `goal: ${goal}\nacceptance_criteria:\n  - id: IS5-A\n    text: Keep the requested scope.\n`;

// Suspend actual native cleanup calls, not the rebuild or reducer. Nested
// lifecycle events select a real branch whose subsequent appends stay there.
export async function probeConsultRebuild({ event = 'session_start', boundary = 'read',
  action = 'native', error = { code: 'quota', model_called: true }, replays = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rebuild-probe-'));
  const home = join(root, 'home'), cwd = join(root, 'work'), agentDir = join(home, '.omo/agent');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  const config = join(home, '.omo/omo.jsonc');
  const policy = unsafe => writeFileSync(config, JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true, ...(unsafe ? { write: true } : {}) } } } },
  }));
  policy(false);
  const environment = {
    HOME: home, USERPROFILE: home, SENPI_CODING_AGENT_DIR: agentDir, OMO_CODING_AGENT_DIR: agentDir,
    OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '', OMO_ORACLE_ADVISOR: '1',
  };
  const priorEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const priorRegistration = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const task = { task_id: 'owned-rebuild', status: 'running', residency_state: 'resident' };
  let branch = [], reads = 0, held = false, injected = false, dispatches = 0, output, runtime;
  const fake = createFakePi({ cwd, executeTool: async (name) => {
    if (name === 'task') { dispatches++; throw new Error('rebuild must never dispatch'); }
    const stage = name === 'task_cancel' ? 'cancel' : ++reads === 1 ? 'read' : 'confirm';
    if (!held && boundary === stage) {
      held = true;
      entered.resolve();
      await release.promise;
      if (error) throw Object.assign(new Error('native cleanup rejected'), error);
    }
    if (name === 'task_cancel') {
      Object.assign(task, { status: 'cancelled', residency_state: 'persisted_only' });
      return { result: { details: { kind: 'cancelled', task_id: task.task_id } }, isError: false };
    }
    if (name === 'task_output') return {
      result: { details: { snapshot: structuredClone(task) } }, isError: false,
    };
    throw new Error(`Unexpected native ${name}`);
  } });
  const append = fake.pi.appendEntry;
  fake.pi.appendEntry = (type, data) => {
    append(type, data);
    branch.push(fake.entries.at(-1));
  };
  fake.ctx.sessionManager.getBranch = () => branch;
  fake.pi.exec = async () => ({ code: 0, stdout: '', stderr: '' });
  const settled = promise => promise.then(value => ({ resolved: true, value }), failure => ({
    resolved: false, code: failure.code, message: failure.message,
  }));
  let rebuild, actionResult;
  try {
    runtime = extension(fake.pi);
    await fake.emit('session_start');
    await fake.command('oracle', 'on');
    const bind = goal => fake.tools.get('oracle_bind_seed').execute('bind', { seed_yaml: seed(goal) },
      undefined, undefined, fake.ctx);
    await bind('First scope');
    runtime.ledger.append({ type: 'consult_admitted', job_id: 'J1', job_epoch: 1,
      request_id: 'orphan', kind: 'work', model_called: false });
    runtime.ledger.append({ type: 'consult_reserved', job_id: 'J1', job_epoch: 1,
      request_id: 'orphan', kind: 'work', slot: 'work', model_called: false });
    runtime.ledger.append({ type: 'consult_started', job_id: 'J1', job_epoch: 1, request_id: 'orphan' });
    runtime.ledger.append({ type: 'consult_dispatched', job_id: 'J1', job_epoch: 1, request_id: 'orphan' });
    runtime.ledger.append({ type: 'oracle_assigned', job_id: 'J1', job_epoch: 1, oracle_task_id: task.task_id });
    rebuild = settled(fake.emit(event));
    await entered.promise;
    injected = true;
    if (action === 'cancel') actionResult = settled(fake.command('oracle', 'cancel'));
    else if (action === 'reload') actionResult = settled(fake.emit('session_start'));
    else if (action === 'branch') {
      branch = [{ type: 'custom', customType: 'oracle-advisor', id: 'job-nine',
        data: { type: 'job_opened', job_id: 'J9', job_epoch: 1 } }];
      actionResult = settled(fake.emit('session_tree'));
    } else if (action === 'seed') actionResult = settled(bind('Second scope'));
    else if (action === 'policy') policy(true);
    else if (action !== 'native') throw new Error(`Unknown rebuild action ${action}`);
    release.resolve();
    const result = await rebuild;
    const acted = actionResult ? await actionResult : { resolved: true };
    const selected = runtime.ledger.state;
    const replayResults = [];
    // Only replay ids belonging to this path. A branch that excludes the
    // original admission must not acquire a paid consultation from it.
    if (action !== 'branch') for (let n = 0; n < replays; n++) {
      await fake.emit('session_start');
      replayResults.push((await fake.tools.get('oracle_consult').execute('orphan', {
        kind: 'work', question: 'Replay the interrupted id.',
      }, undefined, undefined, fake.ctx)).details);
    }
    output = {
      event, boundary, action, error, injected, rebuild: result, action_result: acted,
      expected_job_id: action === 'branch' ? 'J9' : 'J1', job_id: selected.job.job_id,
      reserved_slots: Object.values(selected.requests).filter(record =>
        ['admitted', 'reserved', 'running'].includes(record.status)).length,
      consult: selected.job.consults.orphan ?? null, counters: selected.job.counters,
      replays: replayResults, native_oracle_dispatches: dispatches, real_model_calls: 0,
      failures: fake.entries.filter(entry => entry.data.type === 'transport_failed').map(entry => entry.data),
    };
  } finally {
    release.resolve();
    if (rebuild) await rebuild;
    if (actionResult) await actionResult;
    try { if (runtime) await fake.emit('session_shutdown'); }
    finally {
      if (priorRegistration === undefined) delete globalThis[REGISTRATION_KEY];
      else globalThis[REGISTRATION_KEY] = priorRegistration;
      for (const [key, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      if (output) output.cleanup = { homes_removed: !existsSync(root), owned_processes: 0, pids_gone: true };
    }
  }
  return output;
}
