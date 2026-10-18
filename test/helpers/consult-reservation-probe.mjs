import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { REGISTRATION_KEY } from '../../src/extension.mjs';
import { createFakePi } from './fake-pi.mjs';

// Verifier probes: suspend both dossier reads at the actual extension seam.
// Only git and the native task boundary are faked; no provider is contacted.
export async function probeReservedConsult(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-reservation-probe-'));
  const home = join(root, 'home'), cwd = join(root, 'work'), agentDir = join(home, '.omo/agent');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, '.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { read: true } } } },
  }));
  const environment = {
    HOME: home, USERPROFILE: home, SENPI_CODING_AGENT_DIR: agentDir, OMO_CODING_AGENT_DIR: agentDir,
    OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '', OMO_ORACLE_ADVISOR: '1',
  };
  const priorEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const priorRegistration = globalThis[REGISTRATION_KEY];
  delete globalThis[REGISTRATION_KEY];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const records = new Map();
  let dispatches = 0, gitReads = 0, branch, output;
  const fake = createFakePi({ cwd, executeTool: async (name, args) => {
    if (name === 'task') {
      const task = {
        task_id: `owned-${++dispatches}`, status: 'completed', residency_state: 'persisted_only',
        final_response: '{"verdict":"CONTINUE","reasons":[]}',
      };
      records.set(task.task_id, task);
      return { toolCall: {}, result: { details: task }, isError: false };
    }
    if (name === 'task_output') return {
      toolCall: {}, result: { details: { snapshot: records.get(args.task_id) } }, isError: false,
    };
    throw new Error(`Unexpected native call: ${name}`);
  } });
  fake.pi.exec = async () => {
    if (++gitReads === 2) entered.resolve();
    await release.promise;
    return { code: 0, stdout: '', stderr: '' };
  };
  fake.ctx.sessionManager.getBranch = () => branch ?? fake.entries;
  const runtime = extension(fake.pi);
  const invoke = id => fake.tools.get('oracle_consult').execute(id, {
    kind: 'work', question: 'Review the original branch.',
  }, undefined, undefined, fake.ctx);
  let pending, duplicate;
  try {
    await fake.emit('session_start');
    await fake.command('oracle', 'on');
    const before = structuredClone(fake.entries);
    pending = invoke('race');
    await entered.promise;
    duplicate = invoke('race');
    const busy = await invoke('other');
    const reserved = runtime.ledger.state.job.counters.consults;
    let action;
    if (scenario === 'consult-cancel-reserved') action = await fake.command('oracle', 'cancel');
    else if (scenario === 'consult-reload-reserved') await fake.emit('session_start');
    else if (scenario === 'consult-branch-switch-reserved') {
      branch = before;
      await fake.emit('session_tree');
    } else throw new Error(`Unknown reservation probe: ${scenario}`);
    const afterAction = runtime.ledger.state;
    release.resolve();
    const result = await pending;
    const duplicateResult = await duplicate;
    const replay = scenario === 'consult-branch-switch-reserved' ? null : await invoke('race');
    output = {
      scenario, reserved_before_action: reserved, git_reads: gitReads, action_result: action ?? null,
      concurrent_second: busy.details.status, duplicate_result: duplicateResult.details,
      after_action_consult: afterAction.job.consults.race ?? null,
      result: result.details, replay: replay?.details ?? null, native_oracle_dispatches: dispatches,
      final_counters: runtime.ledger.state.job.counters,
      final_consult_record: runtime.ledger.state.job.consults.race ?? null,
      ledger_events: fake.entries.slice(before.length).map(entry => entry.data),
      receipts: readFileSync(join(agentDir, 'logs/oracle-advisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
      real_oracle_runs: 0,
    };
  } finally {
    release.resolve();
    await Promise.allSettled([pending, duplicate]);
    try { await fake.emit('session_shutdown'); }
    finally {
      if (priorRegistration === undefined) delete globalThis[REGISTRATION_KEY];
      else globalThis[REGISTRATION_KEY] = priorRegistration;
      for (const [key, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      if (output) output.cleanup = { homes_removed: !existsSync(root), pids_gone: true, owned_processes: 0 };
    }
  }
  return output;
}
