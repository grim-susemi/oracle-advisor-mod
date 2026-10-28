import { consultUsage } from './ledger.mjs';

const KEY = Symbol.for('omo.oracle-advisor.status.v1');

export const STATUS_KEY = KEY;

const JOB_STATUSES = new Set(['active', 'paused', 'closed']);
const GATE_STATES = new Set(['ACTIVE', 'HELD', 'HALTED', 'CLOSED']);

function nullSessions() {
  return Object.create(null);
}

function ensureHub() {
  const existing = globalThis[KEY];
  if (existing && existing.v === 1 && existing.sessions &&
      typeof existing.sessions === 'object') {
    if (Object.getPrototypeOf(existing.sessions) !== null) {
      const migrated = nullSessions();
      for (const [id, snapshot] of Object.entries(existing.sessions)) migrated[id] = snapshot;
      existing.sessions = migrated;
    }
    return existing;
  }
  const hub = { v: 1, sessions: nullSessions() };
  globalThis[KEY] = hub;
  return hub;
}

function lastAdvisorOf(requests) {
  let found = null;
  for (const record of Object.values(requests ?? {})) {
    const advisor = record?.advisor;
    if (advisor && typeof advisor === 'object' && advisor.profile != null) found = advisor;
  }
  if (!found) return null;
  return Object.freeze({ profile: found.profile ?? null, source: found.source ?? 'legacy' });
}

function autoOf(job) {
  const run_id = job?.auto?.run_id;
  if (typeof run_id !== 'string' || !run_id) return null;
  return Object.freeze({ run_id });
}

function snapshotOf(state) {
  const job = state?.job;
  if (!job) {
    return Object.freeze({
      job_id: null, status: null, gate_state: null, auto: null,
      consults_remaining: null, open_stops: 0, last_advisor: null,
    });
  }
  // The ledger projection strips calls_remaining from job.counters, so the
  // remaining count is derived here with the ledger's own consultUsage helper.
  const remaining = consultUsage(state.requests ?? {}, job.job_id).calls_remaining;
  return Object.freeze({
    job_id: job.job_id ?? null,
    status: JOB_STATUSES.has(job.status) ? job.status : null,
    gate_state: GATE_STATES.has(job.gate_state) ? job.gate_state : null,
    auto: autoOf(job),
    consults_remaining: remaining,
    open_stops: Object.values(job.stops ?? {}).filter(stop => stop?.status === 'open').length,
    last_advisor: lastAdvisorOf(state.requests),
  });
}

export function registerStatusHub(pi, runtime) {
  const hub = ensureHub();
  const known = new Set();

  const publish = sessionId => {
    if (!sessionId) return null;
    const snapshot = snapshotOf(runtime.ledger.state);
    hub.sessions[sessionId] = snapshot;
    return snapshot;
  };

  const leadOnly = () => {
    try {
      const status = runtime.getSessionStatus?.();
      return status === undefined || status === 'lead';
    } catch {
      return true;
    }
  };

  const unsubscribe = runtime.ledger.subscribe?.(() => {
    for (const sessionId of known) publish(sessionId);
  });

  pi.on('session_start', async (_event, ctx) => {
    if (!leadOnly()) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    known.add(sessionId);
    publish(sessionId);
  });
  // ledger.rebuild does not notify subscribers, so republish after the
  // extension's rebuild on both session_start and session_tree. Wiring
  // contract for todo 7: register the hub AFTER the extension's own
  // session_start, session_tree and session_shutdown handlers, immediately
  // before `return runtime`, NOT in the register* group. registerStatusHub
  // only publishes for sessions seen by its own session_start handler while
  // lead; early wiring (e.g. next to registerNudger) runs while the session
  // status is still 'unknown', so the session never enters `known` and the
  // hub NEVER publishes for it - not merely stale. If late wiring is
  // impossible, call the returned publish(sessionId) after each rebuild.
  pi.on('session_tree', async (_event, ctx) => {
    if (!leadOnly()) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId || !known.has(sessionId)) return;
    publish(sessionId);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    known.delete(sessionId);
    delete hub.sessions[sessionId];
  });

  return { hub, publish, unsubscribe };
}
