import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakePi } from './fake-pi.mjs';

const registrationKey = Symbol.for('omo.oracle-advisor.v1');
const seed = goal => `goal: ${goal}\nacceptance_criteria:\n  - id: IS5-A\n    text: Keep the requested scope.\n`;
const stop = '{"verdict":"STOP","reasons":[{"text":"Verify the change before proceeding.","criterion_id":"IS5-A"}]}';
const flatten = events => events.flatMap(event => [event, ...flatten(event.events ?? [])]);

// Passive loader instrumentation preserves the real protocol filesystem calls.
// The optional checkpoint observer injects actual owner/lifecycle/config actions,
// not desired verdicts or replacement checkpoint decisions.
export async function probeConsultCheckpoint({ reason, stage, hold, followUp = false, mode, replayCount = 0,
  nativeError, nativeText, nativeDetails, nativeIsError = false, gitText = '', answerOverride,
  terminalBranchReplays = 0, restart = false, branchEvent = 'session_tree' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-checkpoint-probe-'));
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
  const priorRegistration = globalThis[registrationKey];
  delete globalThis[registrationKey];
  const id = randomUUID(), observerKey = `checkpoint-${id}`, saveKey = `save-${id}`, writeKey = `write-${id}`,
    policyKey = `policy-${id}`;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const records = new Map(), actions = [], stages = [];
  let fake, runtime, before, branch, pending, output, injected = false, raceFinished = false, admission;
  let prompt, afterActionReserved, beforeLength, analysisWrites = 0, writesAtAbort;
  let armed = mode !== 'replay';
  let dispatches = 0, dispatchesAtAbort, abortIndex, gitReads = 0, analysisAtAbort;
  const act = () => {
    if (injected) return;
    injected = true;
    dispatchesAtAbort = dispatches;
    abortIndex = fake.entries.length;
    analysisAtAbort = existsSync(join(agentDir, 'logs/oracle-advisor/J1/race.md'));
    writesAtAbort = analysisWrites;
    if (reason === 'cancel') actions.push(fake.command('oracle', 'cancel'));
    else if (reason === 'branch') {
      branch = before;
      actions.push(fake.emit('session_tree'));
    } else if (reason === 'reload' || reason === 'reload-other') {
      if (reason === 'reload-other') branch = [{
        type: 'custom', customType: 'oracle-advisor', id: 'other-job',
        data: { type: 'job_opened', job_id: 'J9', job_epoch: 1 },
      }];
      actions.push(fake.emit('session_start'));
    }
    else if (reason === 'seed') actions.push(fake.tools.get('oracle_bind_seed').execute('bind-b', {
      seed_yaml: seed('Second scope'),
    }, undefined, undefined, fake.ctx));
    else if (reason === 'policy') policy(true);
    else throw new Error(`Unknown abort reason ${reason}`);
    // Observe action rejection immediately, including native promise rejection.
    for (let n = 0; n < actions.length; n++) actions[n] = actions[n].catch(error => ({
      status: 'rejected', code: error.code, message: error.message,
    }));
  };
  globalThis[observerKey] = value => {
    if (!armed) return;
    stages.push(value);
    if (reason && stage === value) act();
  };
  globalThis[saveKey] = async () => {
    if (hold !== 'save') return;
    entered.resolve();
    await release.promise;
  };
  globalThis[writeKey] = async phase => {
    if (phase === 'start') { analysisWrites++; return; }
    if (hold !== 'analysis_write_return') return;
    entered.resolve();
    await release.promise;
  };
  globalThis[policyKey] = () => {
    if (hold !== 'policy_return' || !before || injected) return;
    entered.resolve();
    act();
  };
  const actualConsult = new URL('../../src/consult.mjs', import.meta.url);
  actualConsult.search = `probe=${id}`;
  const consultWrapper = 'data:text/javascript,' + encodeURIComponent(`
    import { registerConsultTool as register } from ${JSON.stringify(actualConsult.href)};
    export function registerConsultTool(pi, runtime, options) {
      return register(pi, runtime, { ...options, onCheckpoint: stage => globalThis[${JSON.stringify(observerKey)}]?.(stage) });
    }
  `);
  const fsWrapper = 'data:text/javascript,' + encodeURIComponent(`
    export * from "node:fs/promises";
    import * as fs from "node:fs/promises";
    export async function mkdir(...args) {
      await globalThis[${JSON.stringify(saveKey)}]?.();
      return fs.mkdir(...args);
    }
    export async function writeFile(...args) {
      globalThis[${JSON.stringify(writeKey)}]?.('start');
      const result = await fs.writeFile(...args);
      await globalThis[${JSON.stringify(writeKey)}]?.('return');
      return result;
    }
  `);
  const policyWrapper = 'data:text/javascript,' + encodeURIComponent(`
    import { effectiveOracleTools as resolve } from ${JSON.stringify(new URL('../../scripts/oracle-policy.mjs', import.meta.url).href)};
    export function effectiveOracleTools(...args) {
      const policy = resolve(...args);
      globalThis[${JSON.stringify(policyKey)}]?.();
      return policy;
    }
  `);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/extension.mjs?') && specifier === './consult.mjs') {
      return { url: consultWrapper, shortCircuit: true };
    }
    if (context.parentURL === actualConsult.href && specifier === './protocol.mjs') {
      const resolved = next(specifier, context);
      return { ...resolved, url: `${resolved.url}?probe=${id}` };
    }
    if (context.parentURL === actualConsult.href && specifier === '../scripts/oracle-policy.mjs') {
      return { url: policyWrapper, shortCircuit: true };
    }
    if (context.parentURL?.includes(`/src/protocol.mjs?probe=${id}`) && specifier === 'node:fs/promises') {
      return { url: fsWrapper, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  try {
    const extensionUrl = new URL('../../src/extension.mjs', import.meta.url);
    extensionUrl.search = `probe=${id}`;
    const extension = (await import(extensionUrl.href)).default;
    fake = createFakePi({ cwd, executeTool: async (name, args) => {
      if (name === 'task') {
        prompt = args.prompt;
        dispatches++;
        if (hold === 'native_error_return' || hold === 'native') {
          entered.resolve();
          await release.promise;
        }
        if (nativeError) throw Object.assign(new Error('native execution rejected'), nativeError);
        if (nativeDetails) {
          if (nativeDetails.task_id) records.set(nativeDetails.task_id, {
            task_id: nativeDetails.task_id, status: 'completed', residency_state: 'persisted_only',
          });
          return { toolCall: {}, result: { details: nativeDetails,
            content: nativeText ? [{ type: 'text', text: nativeText }] : [] }, isError: nativeIsError };
        }
        const task = {
          task_id: `owned-${dispatches}`, status: 'completed', residency_state: 'persisted_only',
          final_response: answerOverride ?? (mode === 'replay' ? 'Replay analysis.\n{"verdict":"CONTINUE","reasons":[]}' :
            raceFinished ? '{"verdict":"CONTINUE","reasons":[]}' : stop),
        };
        records.set(task.task_id, task);
        return { toolCall: {}, result: { details: task,
          content: nativeText ? [{ type: 'text', text: nativeText }] : [] }, isError: false };
      }
      if (name === 'task_output') {
        if (hold === 'native_cleanup_read' && !raceFinished && !injected) {
          entered.resolve();
          await release.promise;
        }
        return { toolCall: {}, result: { details: { snapshot: records.get(args.task_id) } }, isError: false };
      }
      throw new Error(`Unexpected native call ${name}`);
    } });
    fake.pi.exec = async () => {
      if (['dossier', 'dossier_second'].includes(hold) && !raceFinished) {
        gitReads++;
        if (hold === 'dossier_second' && gitReads === 1) return { code: 0, stdout: '', stderr: '' };
        if (gitReads === 2) entered.resolve();
        await release.promise;
      }
      return { code: 0, stdout: gitText, stderr: '' };
    };
    const sendMessage = fake.pi.sendMessage;
    fake.pi.sendMessage = (message, options) => {
      sendMessage(message, options);
      if (hold === 'notice' && message.details?.event === 'consult_running' && !injected) {
        entered.resolve();
        act();
      }
    };
    branch = [];
    const appendEntry = fake.pi.appendEntry;
    fake.pi.appendEntry = (type, data) => {
      appendEntry(type, data);
      branch.push(fake.entries.at(-1));
    };
    fake.ctx.sessionManager.getBranch = () => branch;
    runtime = extension(fake.pi);
    await fake.emit('session_start');
    await fake.command('oracle', 'on');
    await fake.tools.get('oracle_bind_seed').execute('bind-a', { seed_yaml: seed('First scope') },
      undefined, undefined, fake.ctx);
    before = structuredClone(branch);
    beforeLength = fake.entries.length;
    const originalBranch = branch;
    const invoke = (request, kind = 'work') => fake.tools.get('oracle_consult').execute(request, {
      kind, question: 'Review the requested change.',
    }, undefined, undefined, fake.ctx);
    if (mode === 'replay') {
      await invoke('race');
      armed = true;
    }
    pending = invoke('race');
    admission = runtime.ledger.state.requests?.race;
    let busy, duplicate;
    if (hold === 'admitted_microtask') act();
    else if (hold) {
      await entered.promise;
      duplicate = invoke('race');
      busy = (await invoke('other')).details.status;
      act();
      // /oracle cancel must return even when a filesystem await is still held.
      if (!['native', 'native_error_return', 'native_cleanup_read'].includes(hold)) {
        await Promise.all(actions);
        afterActionReserved = Object.values(runtime.ledger.state.requests ?? {}).filter(record =>
          ['admitted', 'reserved', 'running'].includes(record.status)).length;
      }
      release.resolve();
    }
    const result = await pending;
    await Promise.all(actions);
    if (duplicate) await duplicate;
    raceFinished = true;
    const job = runtime.ledger.state.job;
    const path = join(agentDir, 'logs/oracle-advisor.jsonl');
    output = {
      reason: reason ?? null, stage: stage ?? hold ?? null, mode: mode ?? 'new', stages, injected,
      admission_before_microtask: admission, job_id: job.job_id, prompt: prompt ?? null,
      after_action_reserved_slots: afterActionReserved ?? null,
      result: result.details, action_results: await Promise.all(actions),
      concurrent_second: busy ?? null, duplicate_result: duplicate ? (await duplicate).details : null,
      native_oracle_dispatches: dispatches, dispatches_at_abort: dispatchesAtAbort ?? null,
      analysis_at_abort: analysisAtAbort ?? null,
      analysis_exists: existsSync(join(agentDir, 'logs/oracle-advisor/J1/race.md')),
      analysis_writes: analysisWrites, analysis_writes_at_abort: writesAtAbort ?? null,
      reserved_slots: Object.values(job.consults).filter(c => ['reserved', 'running'].includes(c.status)).length,
      counters: job.counters, consult: job.consults.race ?? null,
      stops: Object.values(job.stops), verdicts: job.verdicts,
      events: flatten(fake.entries.slice(beforeLength).map(entry => entry.data)),
      events_after_abort: flatten(fake.entries.slice(abortIndex ?? fake.entries.length).map(entry => entry.data)),
      receipts: existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : [],
      real_model_calls: 0,
    };
    if (replayCount) {
      output.replays = [];
      output.rebuilds = [];
      for (let n = 0; n < replayCount; n++) {
        await fake.emit('session_start');
        output.rebuilds.push({
          job_id: runtime.ledger.state.job.job_id,
          reserved_slots: Object.values(runtime.ledger.state.requests).filter(record =>
            ['admitted', 'reserved', 'running'].includes(record.status)).length,
        });
        output.replays.push((await invoke('race')).details);
      }
      output.dispatches_after_replays = dispatches;
      output.requests = runtime.ledger.state.requests;
      if (['branch', 'reload-other'].includes(reason)) {
        const selectedBranch = branch;
        branch = originalBranch;
        await fake.emit('session_tree');
        output.branch_roundtrip = [];
        for (let n = 0; n < replayCount; n++) {
          await fake.emit('session_start');
          output.branch_roundtrip.push((await invoke('race')).details);
        }
        output.original_branch_reserved_slots = Object.values(runtime.ledger.state.requests).filter(record =>
          ['admitted', 'reserved', 'running'].includes(record.status)).length;
        branch = selectedBranch;
        await fake.emit('session_tree');
        output.dispatches_after_replays = dispatches;
      }
    }
    if (followUp) {
      if (reason === 'policy') policy(false);
      output.follow_up = [];
      for (let n = 1; n <= 3; n++) output.follow_up.push((await invoke(`work-${n}`)).details);
      output.follow_up.push((await invoke('completion', 'completion')).details);
      output.follow_up_dispatches = dispatches;
      output.follow_up_counters = runtime.ledger.state.job.counters;
    }
    if (terminalBranchReplays) {
      output.terminal_branch_replays = [];
      for (let n = 0; n < terminalBranchReplays; n++) {
        branch = structuredClone(before);
        await fake.emit(branchEvent);
        if (restart) {
          await fake.emit('session_shutdown');
          runtime = extension(fake.pi);
          await fake.emit('session_start');
        }
        const replay = await invoke('race');
        output.terminal_branch_replays.push({
          result: replay.details, dispatches, job_id: runtime.ledger.state.job.job_id,
          job_epoch: runtime.ledger.state.job.job_epoch,
          reserved_slots: Object.values(runtime.ledger.state.job.consults).filter(record =>
            ['admitted', 'reserved', 'running'].includes(record.status)).length,
        });
      }
      output.dispatches_after_terminal_branch_replays = dispatches;
    }
  } finally {
    release.resolve();
    if (pending) await Promise.allSettled([pending, ...actions]);
    try { if (runtime) await fake.emit('session_shutdown'); }
    finally {
      hooks.deregister();
      delete globalThis[observerKey];
      delete globalThis[saveKey];
      delete globalThis[writeKey];
      delete globalThis[policyKey];
      if (priorRegistration === undefined) delete globalThis[registrationKey];
      else globalThis[registrationKey] = priorRegistration;
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
