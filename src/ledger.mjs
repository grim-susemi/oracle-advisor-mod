import assert from 'node:assert/strict';
import { CONSULT_CAP, LEDGER_ENTRY_TYPE } from './contracts.mjs';
import { applyTriggerEvent, createTriggerState, reduceTriggers } from './triggers.mjs';

export function initialState() {
  return { next_job_number: 1, job: null, requests: {} };
}

export const consultPending = record => ['admitted', 'reserved', 'running'].includes(record?.status);

function openJob(data) {
  return {
    job_id: data.job_id, job_epoch: data.job_epoch ?? 1,
    status: 'active', gate_state: 'ACTIVE', opened_at: data.at ?? null,
    oracle_task_id: null, oracle_task_ids: [], residency: 'unavailable',
    consults: {}, verdicts: [], stops: {}, dispositions: [], overrides: [],
    seed: null, counters: { consults: 0, work: 0, completion: 0, nudges: 0, failure_nudges: 0 },
    nudges: [], progress_revision: 0, retire_pending: false,
    opened_by: data.opened_by ?? 'command',
  };
}

export const openStops = job => Object.values(job?.stops ?? {}).filter(stop => stop.status === 'open');

const freezeFact = fact => {
  for (const value of Object.values(fact)) if (value && typeof value === 'object') freezeFact(value);
  return Object.freeze(fact);
};
const nativeCalled = (fact, record) => {
  if (typeof fact.model_called === 'boolean') return fact.model_called;
  const codes = [fact.kind, fact.status, fact.code, fact.error?.code, fact.reason];
  if (codes.some(code => ['lane_capacity', 'not_continuable', 'not_found', 'no_resident_session'].includes(code))) return false;
  if (codes.some(code => ['quota', 'rate_limit', 429, '429', 'timed_out'].includes(code))) return true;
  if (fact.rejected) return record.dispatched === true;
  if (codes.some(code => ['error', 'denied', 'refused', 'unavailable', 'blocked', 'cancelled', 'oracle_dead'].includes(code))) {
    return !!fact.task_id;
  }
  if (fact.isError) return !!fact.task_id;
  return !!fact.task_id || record.dispatched === true;
};
// Unknown native flags remain absent in storage. Only this projection applies
// the documented native-code/dispatch fallback; lifecycle outcomes cannot do so.
const modelCalled = record => record.native_attempts
  ? Object.values(record.native_attempts).some(fact => nativeCalled(fact, record))
  : record.native_result?.model_called ?? record.model_called ??
    (!record.released && (record.dispatched === true ||
      ['answered', 'invalid', 'quota', 'timed_out', 'oracle_dead', 'unavailable'].includes(record.status)));
const charged = record => ['work', 'completion'].includes(record.slot) &&
  (consultPending(record) || modelCalled(record));

// The only slot calculation: charge is a projection of canonical facts, never
// a mutable balance stored in either a branch or a cached tool response.
export function consultUsage(requests, job_id) {
  const records = Object.values(requests).filter(record => record.job_id === job_id && charged(record));
  const calls_remaining = Math.max(0, Math.min(CONSULT_CAP, CONSULT_CAP - records.length));
  assert.ok(calls_remaining >= 0 && calls_remaining <= CONSULT_CAP);
  return {
    consults: records.length,
    work: records.filter(record => record.slot === 'work').length,
    completion: records.filter(record => record.slot === 'completion').length,
    calls_remaining,
  };
}

function requestView(record, usage) {
  if (!record) return undefined;
  const view = structuredClone(record);
  for (const fact of Object.values(view.native_attempts ?? {})) freezeFact(fact);
  if (view.native_attempts) {
    const fact = Object.values(view.native_attempts).at(-1);
    const stats = fact.run_stats ?? {};
    view.oracle_task_id = fact.task_id ?? view.oracle_task_id ?? null;
    view.model = fact.model ?? null;
    view.usage_status = fact.usage_status ?? (Object.keys(stats).length ? 'actual' : 'unknown');
    for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens']) view[key] = fact[key] ?? stats[key] ?? null;
  }
  view.model_called = modelCalled(record);
  view.counted = charged(record);
  view.calls_remaining = usage.calls_remaining;
  if (view.response) {
    view.response.details.calls_remaining = view.calls_remaining;
    view.response.structuredContent.calls_remaining = view.calls_remaining;
  }
  return view;
}

function project(state) {
  const view = structuredClone(state);
  const byJob = new Map();
  for (const [id, record] of Object.entries(state.requests)) {
    if (!byJob.has(record.job_id)) byJob.set(record.job_id, {});
    byJob.get(record.job_id)[id] = record;
  }
  const usage = new Map([...byJob].map(([id, records]) => [id, consultUsage(records, id)]));
  view.requests = Object.fromEntries(Object.entries(state.requests)
    .map(([id, record]) => [id, requestView(record, usage.get(record.job_id))]));
  if (view.job) {
    const { calls_remaining: _remaining, ...usage } = consultUsage(state.requests, view.job.job_id);
    Object.assign(view.job.counters, usage);
    view.job.consults = Object.fromEntries(Object.entries(view.requests)
      .filter(([, record]) => record.job_id === view.job.job_id));
  }
  return view;
}

function advanceRequest(requests, data, job) {
  const previous = requests[data.request_id];
  if (data.type === 'consult_lifecycle_result') {
    if (previous) (previous.lifecycle_results ??= []).push(structuredClone(data.lifecycle_result));
    return;
  }
  if (data.type === 'consult_native_result' || data.type === 'consult_accounted') {
    // A selected branch may contain a late fact without its abandoned
    // admission. Rebuild takes its canonical request from the complete log.
    if (!previous) return;
    const attempt = data.native_attempt ?? 'legacy';
    assert.ok(!Object.hasOwn(previous.native_attempts ?? {}, attempt), 'native_fact_already_captured');
    const native = freezeFact(structuredClone(data.native_result ?? { model_called: data.model_called }));
    previous.native_attempts = { ...previous.native_attempts, [attempt]: native };
    return;
  }
  if (previous && !consultPending(previous) && data.type !== 'consult_effect_recorded') return;
  const { events: _events, counted: _counted, calls_remaining: _remaining,
    native_result: _native, native_attempts: _attempts, ...fields } = data;
  const record = { ...previous, ...structuredClone(fields),
    job_id: previous?.job_id ?? data.job_id ?? job?.job_id ?? null };
  record.status = { consult_admitted: 'admitted', consult_reserved: 'reserved',
    consult_started: 'running', consult_interrupted: 'interrupted' }[data.type] ?? data.status ?? previous?.status;
  record.slot = Object.hasOwn(data, 'slot') ? data.slot :
    previous && Object.hasOwn(previous, 'slot') ? previous.slot :
      ['work', 'completion'].includes(record.kind) ? record.kind : null;
  record.dispatched = previous?.dispatched === true || data.type === 'consult_dispatched';
  delete record.counted;
  delete record.calls_remaining;
  if (record.native_attempts || consultPending(record) ||
      consultPending(previous) && !Object.hasOwn(data, 'model_called')) delete record.model_called;
  if (data.type === 'consult_released') {
    record.status = data.status ?? 'unavailable';
    record.released = true;
  }
  requests[data.request_id] = record;
}

function reduceState(state, data, owned = false) {
  const next = owned ? state : structuredClone(state);
  data = structuredClone(data);
  if (data.type === 'job_opened') {
    next.job = openJob(data);
    const number = /^J(\d+)$/.exec(data.job_id);
    if (number) next.next_job_number = Math.max(next.next_job_number, Number(number[1]) + 1);
    return next;
  }
  const requestEvent = data.type.startsWith('consult_') && data.request_id !== undefined;
  const previous = requestEvent ? next.requests[data.request_id] : null;
  if (previous && !consultPending(previous) &&
      !['consult_effect_recorded', 'consult_native_result', 'consult_accounted', 'consult_lifecycle_result'].includes(data.type)) return next;
  if (requestEvent) advanceRequest(next.requests, data, next.job);
  const job = next.job;
  if (!job || (data.job_id && data.job_id !== job.job_id)) return next;
  switch (data.type) {
    case 'job_paused': job.status = 'paused'; break;
    case 'job_resumed': job.status = 'active'; break;
    case 'job_ended':
      job.status = 'closed';
      job.seed = null;
      job.gate_state = 'CLOSED';
      job.retire_pending = data.retire_pending ?? true;
      break;
    case 'oracle_assigned':
      job.oracle_task_id = data.oracle_task_id;
      if (!job.oracle_task_ids.includes(data.oracle_task_id)) job.oracle_task_ids.push(data.oracle_task_id);
      job.residency = data.residency ?? 'resident';
      break;
    case 'oracle_retired':
      if (job.oracle_task_id === data.oracle_task_id) {
        job.oracle_task_id = null;
        job.residency = data.residency ?? 'retired';
      }
      break;
    case 'revival_failed':
      job.revival_failures ??= [];
      job.revival_failures.push(data);
      break;
    case 'stuck_record_retired':
      (job.stuck_records_retired ??= []).push(data);
      break;
    case 'verdict_recorded': job.verdicts.push(data); break;
    case 'redirect_disposition': {
      const verdict = job.verdicts.find(verdict => verdict.redirect_id === data.redirect_id &&
        verdict.verdict === 'REDIRECT');
      if (verdict && ['followed', 'declined'].includes(data.decision) &&
          !job.dispositions.some(disposition => disposition.redirect_id === data.redirect_id)) {
        job.dispositions.push(data);
        // The disposition is the durable machine fact. Derive its effect in
        // the same reduction, including cold replay; no second write is needed.
        const consult = next.requests[verdict.request_id];
        if (consult) consult.verdict_changed_direction = data.decision === 'followed';
      }
      break;
    }
    case 'stop_opened':
      job.stops[data.stop_id] = { ...data, status: 'open' };
      job.gate_state = 'HELD';
      break;
    case 'stop_disposition':
    case 'stop_override':
      if (job.stops[data.stop_id]?.status === 'open') {
        const override = data.type === 'stop_override';
        // A halt remains an open STOP so the owner can always override it.
        job.stops[data.stop_id].status = override ? 'overridden' : data.decision === 'halt' ? 'open' : 'disposed';
        job[override ? 'overrides' : 'dispositions'].push(data);
        job.gate_state = data.decision === 'halt' ? 'HALTED' : openStops(job).length ? 'HELD' : 'ACTIVE';
      }
      break;
    case 'seed_bound':
      if (job.seed?.hash !== data.seed.hash) {
        job.progress_revision++;
        if (job.trigger_state) job.trigger_state = reduceTriggers(
          job.trigger_state, { type: 'seed_rebound' },
        ).state;
      }
      if (job.seed && job.seed.hash !== data.seed.hash) job.job_epoch++;
      job.seed = data.seed;
      if (data.job_epoch !== undefined) job.job_epoch = data.job_epoch;
      break;
    case 'trigger_state_recorded':
      job.trigger_state = data.event
        ? Object.assign(applyTriggerEvent(
          job.trigger_state ?? createTriggerState({ active: true }), data.event,
        ).state, data.state)
        : data.state;
      break;
    case 'nudge_recorded':
      job.nudges.push(data);
      job.counters.nudges++;
      if (data.kind === 'failure') job.counters.failure_nudges++;
      break;
    case 'gate_blocked': job.gate_blocks = (job.gate_blocks ?? 0) + 1; break;
    case 'progress_recorded':
      job.progress_revision = data.revision ?? job.progress_revision + 1;
      break;
  }
  return (data.events ?? []).reduce((current, event) => reduceState(current, event, owned), next);
}

export function reduceEntry(state, data) {
  return project(reduceState(state, data));
}

function replayState(entries) {
  return entries.filter(entry => entry.type === 'custom' && entry.customType === LEDGER_ENTRY_TYPE)
    .reduce((state, entry) => reduceState(state, entry.data, true), initialState());
}

export function replayLedger(branch) {
  return project(replayState(branch));
}

export function createLedger(pi) {
  let state = initialState();
  let triggerRevision = 0;
  const listeners = new Set();
  // Rebuildable indexes of canonical facts, not persisted balances. Refused
  // requests remain in state forever but do not enter the charged-record index.
  const indexed = new Map(), chargedByJob = new Map(), pendingByJob = new Map();
  const failures = new Map(), unresolvedByJob = new Map();
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
  };
  function indexRequest(id) {
    const previous = indexed.get(id);
    if (previous) {
      chargedByJob.get(previous.job_id)?.delete(id);
      pendingByJob.get(previous.job_id)?.delete(id);
      unresolvedByJob.get(previous.job_id)?.delete(id);
      if (previous.failure !== undefined) failures.get(previous.failure)?.delete(id);
    }
    const record = state.requests[id];
    if (!record) return;
    const metadata = { job_id: record.job_id };
    if (charged(record)) bucket(chargedByJob, record.job_id).add(id);
    if (consultPending(record)) bucket(pendingByJob, record.job_id).add(id);
    if (!consultPending(record) && record.failure_key && record.same_failure_recurred_after === null) {
      metadata.failure = JSON.stringify([record.job_id, record.failure_key]);
      bucket(failures, metadata.failure).add(id);
      bucket(unresolvedByJob, record.job_id).add(id);
    }
    indexed.set(id, metadata);
  }
  const usageFor = job_id => consultUsage(Object.fromEntries(
    [...(chargedByJob.get(job_id) ?? [])].map(id => [id, state.requests[id]])), job_id);
  const ledger = {
    get state() { return project(state); },
    // Hot readers need job facts, not request or tool-call history. The detector
    // takes a full snapshot only on initialization or a trigger revision change.
    get jobFacts() {
      if (!state.job) return null;
      const { consults: _consults, trigger_state, ...job } = state.job;
      const { calls: _calls, ...summary } = trigger_state ?? {};
      const view = structuredClone({ ...job, ...(trigger_state ? { trigger_state: summary } : {}) });
      const { calls_remaining: _remaining, ...usage } = usageFor(job.job_id);
      Object.assign(view.counters, usage);
      return view;
    },
    get hasPendingConsult() { return !!pendingByJob.get(state.job?.job_id)?.size; },
    ownsTask(id) { return state.job?.oracle_task_ids.includes(id) ?? false; },
    effectCandidates(data) {
      const job = state.job;
      if (!job) return [];
      let ids;
      if (data.type === 'job_ended') ids = unresolvedByJob.get(job.job_id);
      else if (data.type === 'trigger_state_recorded') {
        const failure = data.state?.predecessor;
        ids = failure?.outcome === 'failure'
          ? failures.get(JSON.stringify([job.job_id, failure.key])) : undefined;
      } else {
        const verdict = job.verdicts.find(verdict =>
          data.stop_id && verdict.stop_id === data.stop_id ||
          data.redirect_id && verdict.redirect_id === data.redirect_id);
        ids = verdict ? [verdict.request_id] : [];
      }
      return [...(ids ?? [])].map(id => ledger.request(id)).filter(Boolean);
    },
    get triggerRevision() { return triggerRevision; },
    get triggerState() { return structuredClone(state.job?.trigger_state); },
    request(id) { return requestView(state.requests[id], usageFor(state.requests[id]?.job_id)); },
    captureNativeResult(request_id, native_attempt, result, rejected = false) {
      assert.ok(state.requests[request_id], 'native_fact_without_admission');
      const sources = [result, result?.details, result?.structuredContent];
      const native_result = Object.fromEntries([
        'model_called', 'task_id', 'kind', 'status', 'code', 'error', 'reason', 'run_stats',
        'model', 'usage_status', 'input_tokens', 'output_tokens', 'reasoning_tokens',
        'provider_stop_reason', 'engine_completion_chars', 'run_epoch', 'isError',
      ].map(key => [key, sources.find(source => key === 'model_called'
        ? typeof source?.[key] === 'boolean' : source?.[key] !== undefined)?.[key]])
        .filter(([, value]) => value !== undefined));
      if (rejected) native_result.rejected = true;
      return ledger.append({ type: 'consult_native_result', request_id, native_attempt,
        native_result: freezeFact(structuredClone(native_result)) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    append(data, { snapshot = true } = {}) {
      const previous = state.requests[data.request_id];
      if (previous && ['consult_native_result', 'consult_accounted'].includes(data.type)) {
        assert.ok(!Object.hasOwn(previous.native_attempts ?? {}, data.native_attempt ?? 'legacy'),
          'native_fact_already_captured');
      }
      // Persist before advancing the exclusively owned live state. A failed
      // append cannot publish a disposition or release a STOP in memory.
      pi.appendEntry(LEDGER_ENTRY_TYPE, data);
      state = reduceState(state, data, true);
      for (const event of [data, ...(data.events ?? [])]) {
        if (event.type.startsWith('consult_') && event.request_id !== undefined) indexRequest(event.request_id);
      }
      if (['job_opened', 'seed_bound', 'trigger_state_recorded'].includes(data.type)) triggerRevision++;
      const repeatedTerminal = previous && !consultPending(previous) &&
        ['consult_finished', 'consult_interrupted'].includes(data.type);
      if (!repeatedTerminal) for (const event of [data, ...(data.events ?? [])]) {
        for (const listener of listeners) listener(event);
      }
      if (snapshot) return ledger.state;
    },
    rebuild(branch, allEntries = branch) {
      const canonical = replayState(allEntries);
      state = branch === allEntries ? canonical : replayState(branch);
      state.requests = canonical.requests;
      state.next_job_number = Math.max(state.next_job_number, canonical.next_job_number);
      for (const index of [indexed, chargedByJob, pendingByJob, failures, unresolvedByJob]) index.clear();
      for (const id of Object.keys(state.requests)) indexRequest(id);
      triggerRevision++;
      for (const consult of Object.values(state.requests)) {
        if (consultPending(consult)) ledger.append({
          type: 'consult_interrupted', job_id: consult.job_id,
          job_epoch: consult.job_epoch, request_id: consult.request_id,
          status: 'interrupted', analysis_path: null, analysis_chars: 0,
        });
      }
      return ledger.state;
    },
  };
  return ledger;
}
