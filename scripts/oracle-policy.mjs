import {
  existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Todo-2 probe-report.json decision: exclusive boolean tools map; root alone is
// sufficient. Unregistered keys remain inert. No wildcard LSP or mutating rename.
export const READONLY_ORACLE_TOOLS = Object.freeze(Object.fromEntries([
  'read', 'find', 'grep', 'ls', 'lsp_diagnostics', 'lsp_goto_definition',
  'lsp_find_references', 'lsp_symbols', 'coordination_inspect', 'coordination_ask', 'look_at',
].map(name => [name, true])));
export const POLICY_DECISION = Object.freeze({
  allowlist_key: 'tools', allowlist_paths: ['[native].agents.oracle.tools'],
});
const fail = (code, message) => Object.assign(new Error(message ?? code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => path.reduce((parent, key) => parent?.[key], value);
const unsafeKey = key => ['__proto__', 'constructor', 'prototype'].includes(key);

// The scanner keeps character offsets for edits and UTF-8 byte offsets for the
// manifest. Comments are trivia, never structural tokens; strings use JSON's
// escape rules. Duplicate properties are refused because path restore is ambiguous.
function scan(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const invalid = () => { throw fail('invalid_jsonc', `Invalid or ambiguous JSONC at character ${i}`); };
  function trivia() {
    while (i < text.length) {
      if (/\s/.test(text[i])) { i++; continue; }
      if (text.slice(i, i + 2) === '//') {
        i += 2;
        while (i < text.length && !['\r', '\n'].includes(text[i])) i++;
      } else if (text.slice(i, i + 2) === '/*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) invalid();
        i = end + 2;
      } else break;
    }
  }
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        try { return { start, end: i, value: JSON.parse(text.slice(start, i)) }; }
        catch { invalid(); }
      }
    }
    invalid();
  }
  function value() {
    trivia();
    const start = i;
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++;
      const properties = [];
      const output = Object.create(null);
      trivia();
      while (text[i] !== '}') {
        if (text[i] !== '"') invalid();
        const key = string();
        if (Object.hasOwn(output, key.value)) invalid();
        trivia();
        const colon = i;
        if (text[i++] !== ':') invalid();
        const child = value();
        output[key.value] = child.value;
        trivia();
        const comma = text[i] === ',' ? i++ : null;
        properties.push({ key: key.value, start: key.start, keyEnd: key.end, colon, node: child, comma });
        trivia();
        if (comma === null && text[i] !== '}') invalid();
        if (i >= text.length) invalid();
      }
      return { start, end: ++i, value: output, properties };
    }
    if (text[i] === '[') {
      i++;
      const output = [];
      trivia();
      while (text[i] !== ']') {
        output.push(value().value);
        trivia();
        if (text[i] === ',') { i++; trivia(); }
        else if (text[i] !== ']') invalid();
        if (i >= text.length) invalid();
      }
      return { start, end: ++i, value: output };
    }
    const token = text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) invalid();
    i += token.length;
    return { start, end: i, value: JSON.parse(token) };
  }
  const root = value();
  trivia();
  if (i !== text.length || !root.properties) invalid();
  return root;
}
export function parseJsonc(text) { return JSON.parse(JSON.stringify(scan(text).value)); }
function nodeAt(root, path) {
  return path.reduce((node, key) => node?.properties?.find(property => property.key === key)?.node, root);
}
function replacePolicyMap(text, node) {
  if (!node.properties || node.properties.some(property => typeof property.node.value !== 'boolean')) {
    throw fail('invalid_tools_policy', 'Existing oracle tools must be a boolean map.');
  }
  // Remove only old policy tokens. Every trivia byte, including comments between
  // a key, colon, value and separator, remains in its original relative order.
  const tokens = node.properties.flatMap(property => [
    [property.start, property.keyEnd], [property.colon, property.colon + 1],
    [property.node.start, property.node.end],
    ...(property.comma === null ? [] : [[property.comma, property.comma + 1]]),
  ]);
  let trivia = text.slice(node.start, node.end);
  for (const [start, end] of tokens.sort((a, b) => b[0] - a[0])) {
    trivia = trivia.slice(0, start - node.start) + trivia.slice(end - node.start);
  }
  return JSON.stringify(READONLY_ORACLE_TOOLS).slice(0, -1) + trivia.slice(1);
}
function oracleDefinitions(document) {
  const definitions = [];
  const add = (layer, prefix, profile = null) => {
    for (const block of [[], ['[senpi]'], ['[native]']]) {
      const path = [...prefix, ...block, 'agents', 'oracle'];
      const oracle = at(document, path);
      if (record(oracle)) definitions.push({ path, profile, tools: oracle.tools ?? null });
    }
  };
  add(document, []);
  for (const name of Object.keys(document.profiles ?? {})) add(document.profiles[name], ['profiles', name], name);
  return definitions;
}
function requestedPaths(decision) {
  if (decision?.allowlist_key !== 'tools') throw fail('allowlist_unproven', 'Exclusive oracle tools policy is unproven; no file was changed.');
  if (!Array.isArray(decision.allowlist_paths) || decision.allowlist_paths.length === 0) throw fail('allowlist_unproven');
  return decision.allowlist_paths.map(path => {
    const parts = Array.isArray(path) ? path : path.split('.');
    if (parts.at(-1) !== 'tools' || parts.at(-2) !== 'oracle' || parts.at(-3) !== 'agents' ||
        !parts.includes('[native]')) throw fail('allowlist_unproven', `Unproven oracle policy path: ${path}`);
    return parts;
  });
}
function plan(text, decision, allProfiles) {
  const paths = requestedPaths(decision);
  const root = scan(text);
  const sources = oracleDefinitions(root.value);
  if (allProfiles) for (const source of sources) {
    if (source.profile && source.path.at(-3) === '[native]') paths.push([...source.path, 'tools']);
  }
  const unique = [...new Map(paths.map(path => [JSON.stringify(path), path])).values()];
  const ranges = unique.map(path => {
    const parent = nodeAt(root, path.slice(0, -1));
    if (!parent?.properties) throw fail('oracle_definition_missing', JSON.stringify(path.slice(0, -1)));
    const property = parent.properties.find(item => item.key === 'tools');
    const replacement = JSON.stringify(READONLY_ORACLE_TOOLS);
    if (property && JSON.stringify(property.node.value) === replacement) return null;
    const start = property ? property.node.start : parent.start + 1;
    const end = property ? property.node.end : start;
    const after = property ? replacePolicyMap(text, property.node)
      : `"tools":${replacement}${parent.properties.length ? ',' : ''}`;
    return {
      path, kind: property ? 'replace' : 'insert', start, end,
      before_text: text.slice(start, end), after_text: after,
      byte_range_before: [Buffer.byteLength(text.slice(0, start)), Buffer.byteLength(text.slice(0, end))],
    };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
  let output = text;
  for (const range of [...ranges].reverse()) output = output.slice(0, range.start) + range.after_text + output.slice(range.end);
  let delta = 0;
  for (const range of ranges) {
    const start = range.byte_range_before[0] + delta;
    range.byte_range_after = [start, start + Buffer.byteLength(range.after_text)];
    delta += Buffer.byteLength(range.after_text) - Buffer.byteLength(range.before_text);
    range.before_sha256 = sha(range.before_text);
    range.after_sha256 = sha(range.after_text);
    delete range.start;
    delete range.end;
  }
  return { output, ranges, sources };
}
function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, text, { flag: 'wx' });
  renameSync(temporary, path);
}
function targetFile(path) {
  const resolved = resolve(path);
  if (lstatSync(resolved).isSymbolicLink()) throw fail('symlink_target_refused', resolved);
  return resolved;
}

export function installOraclePolicy({
  configPath, decision = POLICY_DECISION, dryRun = false, allProfiles = false,
  manifestPath = `${configPath}.oracle-advisor-delta.json`, cwd = process.cwd(), env = process.env,
}) {
  requestedPaths(decision); // Refuse before opening or writing anything.
  configPath = targetFile(configPath);
  manifestPath = resolve(manifestPath);
  const before = readFileSync(configPath, 'utf8');
  const delta = plan(before, decision, allProfiles);
  const effective = effectiveOracleTools(cwd, { env });
  const report = {
    version: 1, status: dryRun ? 'dry_run' : delta.ranges.length ? 'applied' : 'unchanged',
    config_path: configPath, manifest_path: manifestPath, all_profiles: allProfiles,
    allowlist_key: decision.allowlist_key, allowlist_paths: decision.allowlist_paths,
    before_sha256: sha(before), after_sha256: sha(delta.output), ranges: delta.ranges,
    sources: [
      ...delta.sources.map(item => ({ ...item, file: configPath, scope: 'target' })),
      ...effective.sources.filter(item => resolve(item.file) !== configPath),
    ], effective_before: effective, backup_path: null,
  };
  if (dryRun || delta.ranges.length === 0) return report;
  if (existsSync(manifestPath)) throw fail('manifest_exists', `Uninstall the existing delta first: ${manifestPath}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  report.backup_path = `${configPath}.bak-oracle-advisor-${stamp}-${randomUUID()}`;
  writeFileSync(report.backup_path, before, { flag: 'wx' });
  // Persist recovery data before replacing the configuration.
  writeFileSync(manifestPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  atomicWrite(configPath, delta.output);
  return report;
}

export function uninstallOraclePolicy({ configPath, manifestPath = `${configPath}.oracle-advisor-delta.json`, dryRun = false }) {
  configPath = targetFile(configPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (resolve(manifest.config_path) !== configPath) throw fail('manifest_target_mismatch');
  let text = readFileSync(configPath, 'utf8');
  const root = scan(text);
  const edits = [];
  const ranges = manifest.ranges.map(range => {
    if (range.status === 'restored') return { ...range };
    const parent = nodeAt(root, range.path.slice(0, -1));
    const property = parent?.properties?.find(item => item.key === range.path.at(-1));
    if (!property) return { ...range, status: 'drift', reason: 'Managed key is missing.' };
    const start = range.kind === 'insert' ? property.start : property.node.start;
    const end = property.node.end;
    const current = text.slice(start, end);
    // Separators belong to the current object structure, not to tool policy.
    // This also accepts version-1 manifests that included an inserted comma.
    const managed = range.kind === 'insert' && range.after_text.endsWith(',')
      ? range.after_text.slice(0, -1) : range.after_text;
    const expectedHash = managed === range.after_text ? range.after_sha256 : sha(managed);
    if (current !== managed || sha(current) !== expectedHash) {
      return { ...range, status: 'drift', reason: 'Managed range no longer matches installed bytes.' };
    }
    edits.push({ start, end, text: range.before_text });
    if (range.kind === 'insert') {
      const index = parent.properties.indexOf(property);
      const comma = property.comma ?? (index > 0 ? parent.properties[index - 1].comma : null);
      if (comma !== null) edits.push({ start: comma, end: comma + 1, text: '' });
    }
    return { ...range, status: 'restored' };
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  scan(text);
  const report = { ...manifest, status: ranges.some(range => range.status === 'drift') ? 'drift' : 'restored',
    ranges, restored_sha256: sha(text), dry_run: dryRun };
  if (!dryRun) {
    if (edits.length) atomicWrite(configPath, text);
    atomicWrite(manifestPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

function merge(base, overlay) {
  const output = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (unsafeKey(key)) continue;
    output[key] = record(value) ? merge(record(output[key]) ? output[key] : {}, value) : value;
  }
  return output;
}
function canonicalNativeBlocks(document) {
  const canonicalize = container => {
    const output = { ...container };
    for (const view of [container, container['[senpi]'], container['[native]']]) {
      if (view === undefined) continue;
      const agents = view?.agents, oracle = agents?.oracle, tools = oracle?.tools;
      if (!record(view) || (agents !== undefined && !record(agents)) ||
          (oracle !== undefined && !record(oracle)) ||
          (tools !== undefined && (!record(tools) || Object.values(tools).some(value => typeof value !== 'boolean')))) {
        throw fail('invalid_oracle_layer', 'An oracle config layer cannot be safely resolved.');
      }
    }
    if (Object.hasOwn(output, '[senpi]')) {
      if (!Object.hasOwn(output, '[native]')) output['[native]'] = output['[senpi]'];
      delete output['[senpi]'];
    }
    return output;
  };
  const output = canonicalize(document);
  if (document.profiles !== undefined) {
    if (!record(document.profiles) || Object.values(document.profiles).some(profile => !record(profile))) {
      throw fail('invalid_oracle_layer', 'Profile config layers must be objects.');
    }
    output.profiles = Object.fromEntries(Object.entries(document.profiles)
      .map(([name, profile]) => [name, canonicalize(profile)]));
  }
  return output;
}
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
function configIn(directory, project = false) {
  const folder = join(directory, '.omo');
  if (project && existsSync(folder) && lstatSync(folder).isSymbolicLink()) return null;
  for (const name of ['omo.jsonc', 'omo.json']) {
    const file = join(folder, name);
    if (existsSync(file) && (!project || !lstatSync(file).isSymbolicLink())) return file;
  }
  return null;
}

/**
 * Installed authority:
 * C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.34-r1/package/plugin/runtime/task-config/index.js:57
 * defines senpi -> native and canonicalizeBlocksIn: rename at root/profiles only,
 * dropping the entire legacy block when its same-source canonical block exists.
 * That bundle's :63 (resolveOmoConfigPaths/loadOmoConfig/resolveOmoConfigView)
 * discovers HOME/.omo/omo.jsonc (else omo.json), then farthest-to-nearest project
 * files, skipping project symlinks and home/account-home, with a 256-dir bound.
 * Each source is canonicalized BEFORE merge; then shared -> native -> selected
 * profile shared -> selected profile native. Accepted oracle shapes are
 * agents.oracle and [native]/legacy [senpi].agents.oracle, also in profiles.<P>;
 * tools is an object of booleans (:57). Invalid oracle shapes fail closed here.
 * Selectors (:63): OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR profile tail;
 * selection JSON files are not selectors. The differential test executes this
 * installed bundle's own loadOmoConfig, rather than another copy of these rules.
 * The union is the true keys of the deep-merged boolean map (not replacement).
 * Fail closed on absent/invalid policy; no cached state across profile switches.
 */
export function effectiveOracleTools(cwd, { env = process.env } = {}) {
  const home = resolve(env.HOME ?? env.USERPROFILE ?? process.cwd());
  const profile = env.OMO_PROFILE || env.OCX_PROFILE ||
    env.OPENCODE_CONFIG_DIR?.match(/(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/)?.[1] || null;
  const files = [];
  const userFile = configIn(home);
  if (userFile) files.push({ file: userFile, scope: 'user' });
  const projects = [];
  const boundaries = new Set([real(home), real(userInfo().homedir)]);
  let directory = resolve(cwd);
  for (let depth = 0; depth < 256 && !boundaries.has(real(directory)); depth++) {
    const file = configIn(directory, true);
    if (file) projects.push({ file, scope: 'project' });
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  files.push(...projects.reverse());
  let merged = {};
  const sources = [], diagnostics = [];
  for (const source of files) {
    try {
      const document = parseJsonc(readFileSync(source.file, 'utf8'));
      for (const definition of oracleDefinitions(document)) sources.push({
        ...source, ...definition, active: definition.profile === null || definition.profile === profile,
      });
      merged = merge(merged, canonicalNativeBlocks(document));
    } catch (error) { diagnostics.push({ file: source.file, code: error.code, message: error.message }); }
  }
  let oracle = {};
  const views = [merged, merged['[native]']];
  if (profile && merged.profiles?.[profile]) {
    const selected = merged.profiles[profile];
    views.push(selected, selected['[native]']);
  }
  for (const view of views) if (record(view?.agents?.oracle)) oracle = merge(oracle, view.agents.oracle);
  const valid = record(oracle.tools) && Object.values(oracle.tools).every(value => typeof value === 'boolean');
  const tools = valid ? Object.keys(oracle.tools).filter(name => oracle.tools[name]).sort() : [];
  const unsafe = tools.filter(name => !Object.hasOwn(READONLY_ORACLE_TOOLS, name));
  const readonly = valid && tools.length > 0 && unsafe.length === 0 && diagnostics.length === 0;
  return {
    tools, sources, active_profile: profile, readonly, status: readonly ? 'readonly' : 'oracle_not_readonly',
    unsafe_tools: unsafe, diagnostics,
    reason: readonly ? null : diagnostics.length ? 'Config cannot be safely resolved.' :
      !valid || !tools.length ? 'No exclusive boolean oracle tools policy is effective.' : 'Unsafe oracle tools are effective.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      config: { type: 'string' }, manifest: { type: 'string' }, decision: { type: 'string' },
      cwd: { type: 'string' }, 'dry-run': { type: 'boolean' }, uninstall: { type: 'boolean' },
      'all-profiles': { type: 'boolean' },
    } });
    const configPath = values.config ?? join(process.env.HOME ?? process.env.USERPROFILE, '.omo/omo.jsonc');
    const options = { configPath, dryRun: !!values['dry-run'],
      ...(values.manifest ? { manifestPath: values.manifest } : {}) };
    const report = values.uninstall ? uninstallOraclePolicy(options) : installOraclePolicy({
      ...options, allProfiles: !!values['all-profiles'], cwd: values.cwd ?? process.cwd(),
      ...(values.decision ? { decision: JSON.parse(readFileSync(values.decision, 'utf8')).decision ??
        JSON.parse(readFileSync(values.decision, 'utf8')) } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'drift') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: error.code ?? 'policy_error', message: error.message }));
    process.exitCode = 1;
  }
}
