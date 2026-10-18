import { AsyncLocalStorage } from 'node:async_hooks';

// Measured by todo 2 on Senpi 2026.10.16 / omo-ai 5.1.34. Snapshot
// availability does not qualify live residency: branch on live_residency.
export const TRANSPORT_DECISION = Object.freeze({
  await_mechanism: 'omo.task.updated', live_residency: 'disabled', abort_propagates: true,
});

const CHANNEL = 'senpi:extension-rpc-event';
const terminal = task => ['completed', 'failed', 'error', 'lost', 'cancelled', 'interrupted', 'timed_out'].includes(task?.status);
const retained = task => task?.residency_state === 'resident' || task?.resident === true ||
  !!task?.resident_session || !!task?.resident_handle;
const epoch = task => task?.notification?.run_epoch ?? task?.run_epoch;
const retired = task => terminal(task) && !retained(task) &&
  (task.absent || ['persisted_only', 'disposed', 'released', 'none'].includes(task.residency_state));
const textOf = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
export function nativeResult(outcome) {
  return { ...(outcome?.result ?? outcome), isError: outcome?.isError ?? outcome?.result?.isError ?? false };
}
function failure(result) {
  const fields = [result, result.details, result.structuredContent];
  const typed = (status, reason, extra) => ({ status, reason, ...extra });
  const codes = fields.flatMap(value => [value?.kind, value?.status, value?.code, value?.error?.code]);
  const has = (...values) => values.some(value => codes.includes(value));
  const reason = codes.find(value => value !== undefined);
  if (has('lane_capacity')) return typed('unavailable', 'lane_capacity');
  if (has('not_continuable', 'not_found', 'no_resident_session')) {
    return typed('oracle_dead', textOf(result) || reason, { revival_failure: true });
  }
  if (has('timed_out')) {
    return typed('timed_out', textOf(result) || reason);
  }
  if (has('quota', 'rate_limit', 429, '429')) {
    return typed('quota', textOf(result) || reason);
  }
  if (has('cancelled', 'oracle_dead')) {
    return typed(has('cancelled') ? 'cancelled' : 'oracle_dead', reason);
  }
  if (result.isError || has('denied', 'error', 'refused', 'unavailable', 'blocked')) {
    return typed('unavailable', textOf(result) || reason);
  }
  return null;
}

/**
 * Native task transport only. The caller supplies a newly built full dossier
 * in prompt and owns consult caps, verdict parsing, and consult receipts.
 * consult() returns answer (oracle final response only), model_called and
 * accounting fields. No timer, provider call, retry, or SDK dependency.
 */
export function createTransport(pi, { ledger, decision = TRANSPORT_DECISION, now = Date.now,
  getSessionStatus = () => 'lead' } = {}) {
  const live = decision.live_residency === 'enabled';
  const snapshots = new Map();
  const owned = new Set();
  const snapshotListeners = new Set();
  const cleanupSignal = new AbortController().signal;
  const retirement = new AsyncLocalStorage();
  let active;
  let forceFresh = false;
  const adopt = job => { for (const id of job?.oracle_task_ids ?? []) owned.add(id); };
  const append = (type, data, job = ledger.state.job) => {
    if (job) ledger.append({ type, job_id: job.job_id, job_epoch: job.job_epoch, ...data });
  };
  const lifecycle = (request_id, operation, status, code) => {
    if (ledger.request(request_id)) ledger.append({
      type: 'consult_lifecycle_result', request_id,
      lifecycle_result: { operation, status, ...(code ? { code } : {}) },
    });
  };
  const visible = (event, content, details = {}) => pi.sendMessage({
    customType: 'oracle-advisor-transport', content, display: true, details: { event, ...details },
  }, { triggerTurn: false });
  const wake = () => { active?.wake?.(); if (active) active.wake = undefined; };
  const assign = (id, run) => {
    if (!id || run.id === id) return;
    owned.add(id);
    run.id = id;
    append('oracle_assigned', {
      oracle_task_id: id, residency: live ? 'resident' : 'unavailable', request_id: run.request_id,
    }, run.job);
    run.inspectPeers?.();
    retireStopped(run);
  };
  const onSnapshot = event => {
    if (getSessionStatus() !== 'lead' || event?.name !== 'omo.task.updated') return;
    const parent = event.data?.parent_session_id;
    if (active && parent && parent !== active.ctx.sessionManager.getSessionId()) return;
    for (const task of event.data?.tasks ?? []) {
      // Only the exact owned dispatch label can establish ownership before the
      // foreground task returns its id (needed for owner cancel and shutdown).
      const admitted = active && !active.id && task.description === active.description &&
        (!task.agent_type || task.agent_type === 'oracle');
      if (admitted || owned.has(task.task_id) || ledger.ownsTask(task.task_id)) {
        snapshots.set(task.task_id, structuredClone(task));
      }
      if (admitted) assign(task.task_id, active);
    }
    if (active) retireStopped(active);
    wake();
    for (const listener of snapshotListeners) listener();
  };
  const subscription = pi.events?.on?.(CHANNEL, onSnapshot);
  async function call(ctx, name, args, signal, capture) {
    let outcome;
    try {
      outcome = await (ctx.executeTool ?? pi.executeTool).call(ctx.executeTool ? ctx : pi,
        // The host otherwise inherits the original caller's aborted Esc signal.
        // Factory cleanup must keep its own control signal alive after that abort.
        name, args, { signal: signal ?? cleanupSignal, activateInactiveTool: true });
    } catch (error) {
      capture?.(nativeResult(error), true);
      throw error;
    }
    const result = nativeResult(outcome);
    capture?.(result);
    return result;
  }
  async function readTask(ctx, id) {
    let result;
    try { result = await call(ctx, 'task_output', { task_id: id, mode: 'status' }); }
    catch (cause) {
      throw Object.assign(new Error(`oracle_status_unconfirmed: ${id}: ${cause.message}`, { cause }),
        { code: 'oracle_status_unconfirmed' });
    }
    const task = result.details?.snapshot;
    if (task) snapshots.set(id, task);
    if (result.details?.kind === 'not_found') return { task_id: id, status: 'completed', residency_state: 'persisted_only', absent: true };
    if (!task) throw Object.assign(new Error(`oracle_status_unconfirmed: ${id}: ${textOf(result)}`),
      { code: 'oracle_status_unconfirmed' });
    return task;
  }
  async function retire(_ctx, reason = 'end', ids = ledger.state.job?.oracle_task_ids ?? []) {
    adopt(ledger.state.job);
    for (const id of ids) if (!owned.has(id)) throw Object.assign(new Error(`unowned oracle task: ${id}`),
      { code: 'unowned_oracle_task' });
    const results = [];
    for (const id of [...new Set(ids)]) {
      const requests = Object.values(ledger.state.requests).filter(record =>
        Object.values(record.native_attempts ?? {}).some(fact => fact.task_id === id) ||
        record.oracle_task_id === id ||
        active?.request_id === record.request_id && active.id === id);
      try {
        // Use the factory control plane, not the queued foreground executor.
        // These lifecycle calls never receive the native dispatch capture.
        let task = await readTask(pi, id);
        let cancelled;
        if (!terminal(task) || retained(task)) {
          // Propagated abort marks cancelled before the host's deferred resident
          // destruction finishes. Subscribe before release, then confirm the
          // eventual disposed snapshot instead of mistaking that race for a leak.
          let inspect;
          const gone = new Promise(resolve => {
            inspect = () => {
              const latest = snapshots.get(id);
              if (retired(latest)) resolve(latest);
            };
            snapshotListeners.add(inspect);
          });
          try {
            // This authority exists only along this owned native call's async
            // chain, not in tool arguments or a shared in-progress flag.
            const permit = { task_id: id, active: true };
            try {
              cancelled = await retirement.run(permit, () =>
                call(pi, 'task_cancel', { task_id: id, reason: `oracle-advisor: ${reason}` }));
            } finally { permit.active = false; }
            task = await readTask(pi, id);
            inspect();
            if (!retired(task)) {
              if (decision.await_mechanism !== 'omo.task.updated') {
                throw Object.assign(new Error(`oracle_retirement_unconfirmed: ${id}: ${task.status}/${task.residency_state}`),
                  { code: 'oracle_retirement_unconfirmed' });
              }
              task = await gone;
            }
          } finally { snapshotListeners.delete(inspect); }
        }
        if (!retired(task)) {
          throw Object.assign(new Error(`oracle_retirement_unconfirmed: ${id}: ${task.status}/${task.residency_state}`),
            { code: 'oracle_retirement_unconfirmed' });
        }
        append('oracle_retired', { oracle_task_id: id, reason, confirmed: true,
          residency: live ? 'retired' : 'unavailable' });
        results.push({ oracle_task_id: id, reason, confirmed: true, task, cancelled });
        for (const record of requests) lifecycle(record.request_id, 'retire', 'fulfilled');
      } catch (error) {
        error.code ??= 'oracle_retirement_unconfirmed';
        for (const record of requests) lifecycle(record.request_id, 'retire', 'rejected',
          error.code);
        throw error;
      }
    }
    return results;
  }
  function retireStopped(run) {
    if (!run.stopStatus || !run.id || run.retirement || terminal(snapshots.get(run.id))) return;
    // A terminal snapshot can precede native promise settlement. Let dispatch
    // capture that result before ordinary cleanup reads or releases the task.
    // Native terminal parking refuses cancelled records. Retire the running
    // task first; only then abort its foreground wait. This also handles an id
    // learned from a snapshot after owner cancellation has already arrived.
    run.retirement = retire(run.ctx, run.stopStatus, [run.id])
      .catch(error => { run.retirementError = error; })
      .finally(() => run.controller.abort());
  }
  function stop(status = 'cancelled') {
    if (!active) return false;
    if (!active.stopStatus) {
      active.stopStatus = status;
      retireStopped(active);
      wake();
    }
    return true;
  }
  function watchPeers(run) {
    try {
      const api = globalThis[Symbol.for('omo.agent-coordination.api.v1')];
      if (api?.version !== 1 || typeof api.getClient !== 'function') return;
      const client = api.getClient(run.ctx);
      if (typeof client?.peers !== 'function' || typeof client.onPeersChanged !== 'function') return;
      let seen = false;
      const inspect = roster => {
        try {
          const peers = Array.isArray(roster) ? roster : client.peers();
          if (!Array.isArray(peers) || !run.id) return;
          const peer = peers.find(peer => [peer.task_id, peer.id, peer.agent_id].includes(run.id));
          if (peer && !['dead', 'cancelled', 'closed', 'failed'].includes(peer.status)) seen = true;
          else if (seen && active === run) stop('oracle_dead');
        } catch { /* Optional coordination errors mean absent. */ }
      };
      const off = client.onPeersChanged(inspect);
      run.inspectPeers = () => inspect(client.peers());
      run.offPeers = typeof off === 'function' ? off : undefined;
      run.inspectPeers();
    } catch { /* Optional coordination errors mean absent. */ }
  }
  async function waitAnswer(run, minimumEpoch) {
    for (;;) {
      if (run.stopStatus) return { status: run.stopStatus };
      const task = snapshots.get(run.id);
      const currentEpoch = epoch(task);
      const current = minimumEpoch === undefined || (currentEpoch !== undefined && currentEpoch >= minimumEpoch);
      if (current && task?.final_response) return { status: 'answered', answer: task.final_response, task };
      if (current && terminal(task)) return {
        status: task.status === 'timed_out' ? 'timed_out' : 'oracle_dead', task,
        reason: task.error?.message ?? task.error ?? 'terminal_without_answer',
      };
      // A subscription signal, not a timed retry or periodic task_output read.
      await new Promise(resolve => { run.wake = resolve; });
    }
  }
  async function dispatch(run, path, previous) {
    if (run.stopStatus) return { status: run.stopStatus };
    run.path = path;
    run.id = path === 'revival' ? previous.task_id : undefined;
    run.description = `oracle-advisor ${run.job.job_id}#${run.request_id}`;
    let result;
    let minimumEpoch;
    run.beforeDispatch?.();
    run.dispatched = true;
    const attempt = String(++run.nativeAttempt);
    // This synchronous write precedes assignment, status reads, answer waits and
    // retirement. Each real native dispatch has one immutable fact; a revival's
    // fresh fallback is a distinct attempt, never a replacement of its refusal.
    const capture = (value, rejected) => ledger.captureNativeResult(run.request_id, attempt, value, rejected);
    if (path === 'revival') {
      minimumEpoch = (epoch(previous) ?? 0) + 1;
      result = await call(run.ctx, 'task_send', { to: run.id, message: run.prompt }, run.controller.signal, capture);
      minimumEpoch = result.details?.run_epoch ?? minimumEpoch;
    } else {
      result = await call(run.ctx, 'task', {
        subagent_type: 'oracle', description: run.description, prompt: run.prompt, run_in_background: false,
      }, run.controller.signal, capture);
    }
    const details = result.details ?? {};
    const promoted = path !== 'revival' && (details.run_in_background === true || details.status === 'running');
    run.engineDelivers = path === 'revival' || promoted;
    run.runEpoch = details.run_epoch ?? (path === 'revival' ? minimumEpoch : 0);
    assign(details.task_id, run);
    run.inspectPeers?.();
    const failed = failure(result);
    if (run.stopStatus) return { ...failed, status: run.stopStatus };
    if (failed) return failed;
    if (!run.id) return { status: 'unavailable', reason: 'task_id_missing' };
    if (details.final_response && !snapshots.get(run.id)?.final_response) {
      snapshots.set(run.id, { ...details, final_response: details.final_response });
    } else if (!snapshots.has(run.id)) {
      // One status read closes the admission gap; waiting afterwards uses events.
      await readTask(run.ctx, run.id);
    }
    const current = snapshots.get(run.id);
    if (path !== 'revival' && !current?.final_response && details.status === 'completed') {
      const answer = textOf(result).replace(/\n\n\[task_id: [^\n]*\]\s*$/, '');
      if (answer) snapshots.set(run.id, { ...current, ...details, final_response: answer });
    }
    const answered = await waitAnswer(run, minimumEpoch);
    if (answered.status === 'answered' && path === 'revival') {
      // The proven arrival signal precedes this one non-blocking output read.
      const task = await readTask(run.ctx, run.id);
      if (task.final_response) answered.answer = task.final_response;
      answered.task = task;
    }
    return path === 'revival' && answered.status === 'oracle_dead'
      ? { ...answered, revival_failure: true, reason: answered.reason ?? 'oracle_dead_before_answer' } : answered;
  }
  async function execute(run) {
    const outerAbort = () => { if (active === run) stop('cancelled'); };
    run.signal?.addEventListener('abort', outerAbort, { once: true });
    watchPeers(run);
    let result;
    try {
      visible('consult_running', `oracle consult running; started ${new Date(run.started).toISOString()}`, {
        request_id: run.request_id, started_at: new Date(run.started).toISOString(),
      });
      if (run.signal?.aborted) stop('cancelled');
      if (run.stopStatus) return { status: run.stopStatus, path: 'spawn', model_called: false };
      adopt(run.job);
      let previous;
      if (live && !forceFresh && run.job.oracle_task_id) previous = await readTask(run.ctx, run.job.oracle_task_id);
      forceFresh = false;
      if (previous && (!retained(previous) || ['failed', 'cancelled', 'interrupted'].includes(previous.status))) {
        result = { revival_failure: true, reason: 'oracle_dead_before_answer' };
      } else result = await dispatch(run, previous ? 'revival' : 'spawn', previous);
      if (result.revival_failure && previous) {
        append('revival_failed', { oracle_task_id: previous.task_id, request_id: run.request_id, reason: result.reason }, run.job);
        await retire(run.ctx, 'revival_failed', [previous.task_id]);
        visible('revival_failed', `oracle revival failed (${result.reason}); using one fresh oracle with the full prior record.`, {
          oracle_task_id: previous.task_id, request_id: run.request_id,
        });
        if (run.stopStatus === 'oracle_dead') {
          run.stopStatus = undefined;
          run.controller = new AbortController();
        }
        if (!run.stopStatus) result = await dispatch(run, 'fresh_fallback');
      }
      if (run.stopStatus) result = { ...result, status: run.stopStatus, answer: undefined };
      if (run.stopStatus && run.id && decision.abort_propagates && !run.engineDelivers &&
          !terminal(snapshots.get(run.id))) {
        // Foreground abort propagation may finish asynchronously. After native
        // background promotion (or revival), the returned call no longer owns
        // cancellation: retire() must cancel the still-running child instead.
        let inspect;
        const ended = new Promise(resolve => {
          inspect = () => { if (terminal(snapshots.get(run.id))) resolve(); };
          snapshotListeners.add(inspect);
        });
        try {
          await readTask(run.ctx, run.id);
          inspect();
          await ended;
        } finally { snapshotListeners.delete(inspect); }
      }
      const task = run.id ? snapshots.get(run.id) : undefined;
      const stuck = result.status === 'answered' && !terminal(task);
      if (run.id && ((!live && result.status === 'answered') ||
          stuck ||
          (result.status !== 'answered' && (result.status !== 'unavailable' || ledger.request(run.request_id)?.model_called)))) {
        // Aborts proven to propagate need no extra cancel if the child is already
        // terminal and gone. retire() verifies that via a single status read.
        if (run.retirement) {
          await run.retirement;
          if (run.retirementError) throw run.retirementError;
        } else await retire(run.ctx, stuck ? 'stuck_record' : result.status, [run.id]);
        if (stuck) {
          append('stuck_record_retired', { oracle_task_id: run.id, request_id: run.request_id }, run.job);
        }
      }
      const finalTask = result.task ?? task;
      const stats = finalTask?.run_stats ?? {};
      const budget = run.ctx.getPromptCacheSafeWaitSeconds?.();
      lifecycle(run.request_id, 'cleanup', 'fulfilled');
      return {
        ...result, task: undefined, path: run.path ?? 'spawn', oracle_task_id: run.id ?? null,
        model_called: ledger.request(run.request_id).model_called,
        oracle_run_epoch: epoch(finalTask) ?? run.runEpoch ?? null, latency_ms: Math.max(0, now() - run.started),
        main_cache_wait_exceeded: Number.isFinite(budget) && now() - run.started > budget * 1000,
        engine_delivers_completion: run.engineDelivers ?? false,
        model: finalTask?.model ?? null, usage_status: Object.keys(stats).length ? 'actual' : 'unknown',
        input_tokens: stats.input_tokens ?? null, output_tokens: stats.output_tokens ?? null,
        reasoning_tokens: stats.reasoning_tokens ?? null, provider_stop_reason: finalTask?.provider_stop_reason ?? null,
        engine_completion_chars: finalTask?.engine_completion_chars ?? 0,
      };
    } catch (error) {
      const failed = error.consult_abort
        ? { status: error.code }
        : failure({ ...nativeResult(error), isError: true });
      lifecycle(run.request_id, 'execute', 'rejected', error.code ?? 'native_or_cleanup_rejected');
      // Native rejection is a terminal result, not a rejected cancellation
      // promise. Preserve paid attempts and retire any id learned from snapshots.
      if (run.id) {
        try {
          if (run.retirement) {
            await run.retirement;
            if (run.retirementError) throw run.retirementError;
          } else await retire(run.ctx, run.stopStatus ?? failed.status, [run.id]);
        }
        catch (cleanupError) {
          append('oracle_retirement_failed', {
            oracle_task_id: run.id, request_id: run.request_id,
            status: 'unavailable', code: cleanupError.code ?? 'retirement_unconfirmed',
          }, run.job);
        }
      }
      return {
        ...failed, status: run.stopStatus ?? failed.status, path: run.path ?? 'spawn',
        model_called: ledger.request(run.request_id).model_called,
        oracle_task_id: run.id ?? null, oracle_run_epoch: run.runEpoch ?? null,
        latency_ms: Math.max(0, now() - run.started),
      };
    } finally {
      run.signal?.removeEventListener('abort', outerAbort);
      run.offPeers?.();
      if (active === run) active = undefined;
    }
  }
  const transport = {
    decision,
    isRetirementCall(event) {
      const permit = retirement.getStore();
      if (!permit?.active || event.toolName !== 'task_cancel' ||
          event.input?.task_id !== permit.task_id || event.input.name ||
          !owned.has(permit.task_id) || typeof event.toolCallId !== 'string') return false;
      // Both guards may inspect the same preflight; no second call can borrow it.
      permit.tool_call_id ??= event.toolCallId;
      return permit.tool_call_id === event.toolCallId;
    },
    get running() { return active ? { request_id: active.request_id, oracle_task_id: active.id, started_at: active.started } : null; },
    consult({ ctx, request_id, prompt, signal, beforeDispatch }) {
      if (active) return Promise.resolve({ status: 'busy', model_called: false });
      if (getSessionStatus() !== 'lead') return Promise.resolve({ status: 'session_not_ready', model_called: false });
      const job = ledger.state.job;
      if (job?.status !== 'active') return Promise.resolve({ status: 'no_active_job', model_called: false });
      const run = { ctx, request_id, prompt, signal, beforeDispatch, job, nativeAttempt: 0,
        started: now(), controller: new AbortController() };
      active = run;
      run.promise = execute(run);
      return run.promise;
    },
    async cancel() {
      const run = active;
      if (!run) return { status: 'no_consult_running' };
      stop('cancelled');
      await run.promise;
      return { status: 'cancelled', request_id: run.request_id };
    },
    retire,
    async restore(ctx) {
      const job = ledger.state.job;
      adopt(job);
      if (Object.values(job?.consults ?? {}).some(record => record.status === 'interrupted')) {
        forceFresh = true;
        await retire(ctx, 'interrupted', job.oracle_task_ids);
      }
    },
    async branchSwitch(ctx, previousJob) {
      if (active) await transport.cancel();
      adopt(previousJob);
      forceFresh = true;
      return retire(ctx, 'branch_switch', previousJob?.oracle_task_ids ?? []);
    },
    async shutdown(ctx) {
      if (active) await transport.cancel();
      return retire(ctx, 'session_shutdown');
    },
    dispose() {
      const requests = Object.values(ledger.state.requests).filter(record => record.native_attempts);
      try {
        retirement.disable();
        if (typeof subscription === 'function') subscription();
        else pi.events?.off?.(CHANNEL, onSnapshot);
        for (const record of requests) lifecycle(record.request_id, 'dispose', 'fulfilled');
      } catch (error) {
        for (const record of requests) lifecycle(record.request_id, 'dispose', 'rejected', error.code ?? 'dispose_failed');
        throw error;
      }
    },
  };
  return transport;
}
