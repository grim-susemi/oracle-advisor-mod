// Task-nature reader (J11): observes lead `task` tool calls, classifies them
// with classifyNature + config/task-nature.json, and answers freshness-gated
// consult queries. No host access beyond the supplied `pi` ExtensionAPI.

import { classifyNature, loadTaskNature } from './seams.mjs';

export const RING_SIZE = 64;

const CHILD_PATH = /(?:^|\/)senpi-task\/children(?:\/|$)/;

function isLead(pi, ctx) {
  if (pi.sessionKind !== 'interactive') return false;
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file === undefined) return true;
    let canonical = String(file).replace(/\\/g, '/');
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    return !CHILD_PATH.test(canonical);
  } catch {
    return false;
  }
}

function sessionIdOf(ctx, fallback) {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? fallback ?? 'default';
  } catch {
    return fallback ?? 'default';
  }
}

const sessions = new Map();

function stateFor(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      records: [], counter: 0,
      sessionStart: 0, lastInput: 0, jobOpen: null,
      maxEvictedAt: 0,
    };
    sessions.set(sessionId, state);
  }
  return state;
}

// Host batch shape (proven by Arsenal's classifyDispatch, which reads a
// top-level `category` off the batch input and lets items inherit it):
// an item without its own `category` property inherits the call's.
function withInheritedCategory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { tasks } = input;
  if (!Array.isArray(tasks)) return input;
  const inherited = Object.getOwnPropertyDescriptor(input, 'category')?.value;
  if (typeof inherited !== 'string') return input;
  return {
    ...input,
    tasks: tasks.map(item => {
      if (!item || typeof item !== 'object') return item;
      if (Object.getOwnPropertyDescriptor(item, 'category') !== undefined) return item;
      return { ...item, category: inherited };
    }),
  };
}

function hasClassifiableItem(input) {
  const items = Array.isArray(input?.tasks) ? input.tasks : [input];
  return items.some(item => {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.category === 'string') return true;
    return typeof input?.category === 'string' &&
      Object.getOwnPropertyDescriptor(item, 'category') === undefined;
  });
}

function recordNature(sessionId, nature) {
  const state = stateFor(sessionId);
  state.counter += 1;
  state.records.push({ nature, at: state.counter });
  if (state.records.length > RING_SIZE) {
    const removed = state.records.shift();
    if (removed.at > state.maxEvictedAt) state.maxEvictedAt = removed.at;
  }
}

function query(sessionId, kind, horizons = {}) {
  const state = sessions.get(sessionId);
  if (!state) return 'neutral';
  const sessionStart = horizons.sessionStart ?? state.sessionStart;
  const lastInput = horizons.lastInput ?? state.lastInput;
  const jobOpen = horizons.jobOpen ?? state.jobOpen;
  if (kind === 'completion') {
    if (jobOpen === null || jobOpen === undefined) return 'neutral';
    if (state.maxEvictedAt > jobOpen) return 'neutral';
    const since = state.records.filter(record => record.at > jobOpen);
    if (since.length === 0) return 'neutral';
    const values = new Set(since.map(record => record.nature));
    if (values.size === 1 && !values.has('neutral')) return since[0].nature;
    return 'neutral';
  }
  const latest = Math.max(sessionStart, lastInput, jobOpen ?? 0);
  const fresh = state.records.filter(record => record.at > latest);
  return fresh.length === 0 ? 'neutral' : fresh[fresh.length - 1].nature;
}

export function noteJobOpen(sessionId) {
  stateFor(sessionId).jobOpen = stateFor(sessionId).counter;
}

export function getNature(sessionId, kind, horizons) {
  return query(sessionId, kind, horizons);
}

export function registerNature(pi, runtime) {
  let table;
  try {
    table = loadTaskNature();
  } catch {
    table = undefined;
  }

  pi.on('tool_call', (event, ctx) => {
    if (!isLead(pi, ctx)) return undefined;
    if (event?.toolName !== 'task') return undefined;
    if (event?.parentToolCallId !== null && event?.parentToolCallId !== undefined) return undefined;
    const input = event?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const effective = withInheritedCategory(input);
    if (!hasClassifiableItem(effective)) return undefined;
    recordNature(sessionIdOf(ctx), classifyNature(effective, table));
    return undefined;
  });

  pi.on('input', (event, ctx) => {
    if (!isLead(pi, ctx)) return undefined;
    if (event?.source === 'extension') return undefined;
    stateFor(sessionIdOf(ctx)).lastInput = stateFor(sessionIdOf(ctx)).counter;
    return undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    if (!isLead(pi, ctx)) return undefined;
    stateFor(sessionIdOf(ctx)).sessionStart = stateFor(sessionIdOf(ctx)).counter;
    return undefined;
  });

  const nature = { forConsult: query, noteJobOpen, getState: stateFor };
  if (runtime && typeof runtime === 'object') runtime.nature = nature;
  return nature;
}
