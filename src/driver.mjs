import { familyOf, readDriver } from './seams.mjs';

const drivers = new Map();

function sessionIdOf(ctx) {
  try {
    return ctx?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function snapshotFromContext(ctx) {
  const entry = readDriver(ctx?.sessionManager?.getBranch?.() ?? null);
  const model = ctx?.model ?? {};
  const modelId = typeof model.id === 'string' ? model.id : '';
  const modelProvider = typeof model.provider === 'string' ? model.provider : '';
  return { agentId: entry?.agentId ?? null, modelProvider, modelId, family: familyOf(modelId) };
}

export function registerDriver(pi, runtime) {
  pi.on('before_agent_start', (event, ctx) => {
    if (event?.preview === true) return;
    if (runtime?.getSessionStatus?.() !== 'lead') return;
    const id = sessionIdOf(ctx);
    if (id === undefined) return;
    drivers.set(id, snapshotFromContext(ctx));
  });
  pi.on('session_shutdown', (_event, ctx) => {
    const id = sessionIdOf(ctx);
    if (id !== undefined) drivers.delete(id);
  });
}

export function getDriver(ctx) {
  const id = sessionIdOf(ctx);
  if (id === undefined) return null;
  return drivers.get(id) ?? null;
}
