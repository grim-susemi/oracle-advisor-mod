import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

// Capture once in the driver. Owned hosts receive only an IPC channel, never the
// locator or a fallback that could mistake their own session root for the source.
const source = process.env.ORACLE_QA_GUARD_IPC === '1' ? undefined
  : process.env.ORACLE_QA_LIVE_AGENT ?? process.env.OMO_STABLE_AGENT ??
    process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR ??
    join(process.env.OMO_STABLE_ROOT ?? 'C:/Users/USER/.omo-stable-500', 'home/.omo/agent');
const normalize = value => value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
const contained = value => source !== undefined && normalize(value).includes(normalize(source));
const searchKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');
const delimiter = process.platform === 'win32' ? ';' : ':';
const cleanSearch = value => value.split(delimiter).filter(path => !contained(path)).join(delimiter);
const initialSearch = searchKey === undefined ? undefined : cleanSearch(process.env[searchKey]);
function sourceFree(environment) {
  const clean = Object.fromEntries(Object.entries(environment)
    .filter(([key, value]) => !contained(key) && !contained(value)));
  const key = Object.keys(environment).find(name => name.toUpperCase() === 'PATH');
  const search = key === undefined ? initialSearch : cleanSearch(environment[key]);
  if (search !== undefined && !Object.keys(clean).some(name => name.toUpperCase() === 'PATH')) {
    clean[key ?? searchKey] = search;
  }
  return clean;
}
for (const [key, value] of Object.entries(process.env)) {
  if (contained(key) || contained(value)) delete process.env[key];
}
function credentialRoot() {
  if (source === undefined) throw new Error('auth_guard_parent_required');
  return source;
}

export function authSourceAvailable() {
  return source !== undefined && existsSync(source);
}

export function hostConfiguration({ profile = false } = {}) {
  try {
    const directory = dirname(credentialRoot());
    return {
      config: readFileSync(join(directory, 'omo.jsonc'), 'utf8'),
      ...(profile ? { active_profile: JSON.parse(readFileSync(join(directory, 'native-profile-selection.json'), 'utf8')).profile } : {}),
    };
  } catch { throw new Error('host_configuration_unavailable'); }
}

function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}
export function authHashes(agentDir = credentialRoot()) {
  return Object.fromEntries(['auth.json', 'credential-pool-state.json'].map(name => [name, hashFile(join(agentDir, name))]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function expiries(value) {
  if (!object(value) && !Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    /^(expires|expiresAt|expires_at)$/.test(key) && typeof item === 'number' && Number.isFinite(item)
      ? [item] : expiries(item)).sort((a, b) => a - b);
}

// Read only. Neither snapshots nor receipts retain credential material.
function authSnapshot(agentDir = credentialRoot()) {
  const hashes = {};
  const documents = {};
  for (const name of ['auth.json', 'credential-pool-state.json']) {
    const path = join(agentDir, name);
    if (!existsSync(path)) { hashes[name] = null; documents[name] = {}; continue; }
    const bytes = readFileSync(path);
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!object(parsed)) throw new Error('auth_parse_failed');
    documents[name] = parsed;
  }
  const auth = documents['auth.json'];
  const pool = documents['credential-pool-state.json'];
  if (pool.providers !== undefined && !object(pool.providers)) throw new Error('auth_parse_failed');
  const providers = Object.fromEntries([...new Set([
    ...Object.keys(auth), ...Object.keys(pool.providers ?? {}),
  ])].sort().map(provider => {
    const credential = auth[provider];
    const state = pool.providers?.[provider];
    return [provider, {
      auth: credential === undefined ? null : hash(credential),
      pool: state === undefined ? null : hash({ ...pool, providers: { [provider]: state } }),
      expires: expiries(credential),
    }];
  }));
  return { hashes, providers };
}

function compareScopedAuth(state, snapshot, providers) {
  const guarded = [...new Set(providers)].sort();
  const baseline = state.auth_scoped_baseline ??= { providers: snapshot.providers, guarded_providers: guarded };
  const previous = state.auth_scoped_last ?? baseline.providers;
  const changed = (left, right, provider) =>
    left[provider]?.auth !== right[provider]?.auth || left[provider]?.pool !== right[provider]?.pool;
  // A case cannot silently narrow or switch the set after its first observation.
  const blocked = JSON.stringify(baseline.guarded_providers) !== JSON.stringify(guarded) ||
    guarded.some(provider => changed(baseline.providers, snapshot.providers, provider));
  const external = [...new Set([...Object.keys(previous), ...Object.keys(snapshot.providers)])]
    .filter(provider => !guarded.includes(provider) && changed(previous, snapshot.providers, provider)).sort();
  if (external.length) {
    (state.auth_guard_events ??= []).push({
      event: 'concurrent_external_change', providers: external,
      expires_before: Object.fromEntries(external.map(provider => [provider, previous[provider]?.expires ?? []])),
      expires_after: Object.fromEntries(external.map(provider => [provider, snapshot.providers[provider]?.expires ?? []])),
    });
  }
  state.auth_scoped_last = snapshot.providers;
  return blocked;
}

export function authVerdict(state, agentDir, { before = false, providers = ['ollama'], environment, admission = false } = {}) {
  if (environment !== undefined) {
    return { type: 'environment_sanitized', environment: sourceFree(environment) };
  }
  const mode = process.env.ORACLE_QA_AUTH_GUARD === 'scoped' ? 'scoped' : 'strict';
  if (admission) {
    const baseline = state.auth_scoped_baseline;
    const last = state.auth_scoped_last;
    const guardedChange = state.auth_guard_mode === 'scoped' && baseline && last &&
      baseline.guarded_providers.some(provider =>
        baseline.providers[provider]?.auth !== last[provider]?.auth ||
        baseline.providers[provider]?.pool !== last[provider]?.pool);
    return { type: state.blocked && (mode === 'strict' || guardedChange)
      ? 'auth_changed' : 'auth_unchanged' };
  }
  let current;
  let reason = state.blocked ? 'existing_auth_block' : null;
  if (!state.blocked) {
    // Existing whole-file baselines stay strict; opt-in requires a fresh attempt.
    state.auth_guard_mode ??= state.auth_baseline ? 'strict' : mode;
    if (state.auth_guard_mode !== mode) reason = 'auth_guard_mode_changed';
    else {
      let snapshot;
      try { snapshot = authSnapshot(agentDir); }
      catch { reason = 'auth_parse_failed'; } // Never expose parser text containing credential bytes.
      if (snapshot) {
        current = snapshot.hashes;
        state.auth_baseline ??= current;
        const mismatch = mode === 'scoped'
          ? compareScopedAuth(state, snapshot, providers)
          : JSON.stringify(state.auth_baseline) !== JSON.stringify(current);
        if (mismatch) reason = 'credential_entry_changed';
        state.last_hashes = current;
      }
    }
  }
  if (reason) state.blocked = true;
  return {
    type: state.blocked ? 'auth_changed' : 'auth_unchanged', hashes: current,
    receipt: {
      mode, phase: before ? 'before' : 'after', blocked: state.blocked, reason,
      guarded_providers: [...new Set(providers)].sort(),
      events: state.auth_guard_events ?? [],
    },
  };
}

export function authObservation(before, agentDir) {
  const hashes = authHashes(agentDir);
  const unchanged = JSON.stringify(before) === JSON.stringify(hashes);
  return { type: process.env.ORACLE_QA_AUTH_GUARD !== 'scoped' && !unchanged
    ? 'auth_changed' : 'auth_unchanged', hashes, unchanged };
}

export function mainKey(agentDir = credentialRoot()) {
  const path = join(agentDir, 'auth.json');
  let credential;
  try { credential = JSON.parse(readFileSync(path, 'utf8')).ollama; }
  catch { throw new Error('missing_main_credential: live Ollama API key is unavailable'); }
  if (credential?.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key) {
    throw new Error('missing_main_credential: live Ollama API key is unavailable');
  }
  if (credential.key.startsWith('!')) throw new Error('missing_main_credential: command-valued keys are not executed by QA');
  const reference = credential.key.match(/^\$(?:\{(\w+)\}|(\w+))$/);
  const key = reference ? credential.env?.[reference[1] ?? reference[2]] ?? process.env[reference[1] ?? reference[2]] : credential.key;
  if (!key) throw new Error('missing_main_credential: unresolved Ollama key reference');
  return key;
}
