import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installedLoader } from './helpers/installed-policy-loader.mjs';

// Capture once, read only thereafter. All edits below target disposable copies.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/oracle-policy');
const snapshot = join(fixtures, 'live-omo.jsonc');
const source = 'C:/Users/USER/.omo-stable-500/home/.omo/omo.jsonc';
const sha = value => createHash('sha256').update(value).digest('hex');
mkdirSync(fixtures, { recursive: true });
if (!existsSync(snapshot)) {
  copyFileSync(source, snapshot);
  writeFileSync(join(fixtures, 'source.json'), JSON.stringify({
    source, sha256: sha(readFileSync(snapshot)), captured_at: new Date().toISOString(),
  }, null, 2) + '\n');
  chmodSync(snapshot, 0o444);
}
const original = readFileSync(snapshot, 'utf8');
const policy = await import('../scripts/oracle-policy.mjs');
const decision = { allowlist_key: 'tools', allowlist_paths: ['[native].agents.oracle.tools'] };
const expected = ['read', 'find', 'grep', 'ls', 'lsp_diagnostics', 'lsp_goto_definition',
  'lsp_find_references', 'lsp_symbols', 'coordination_inspect', 'coordination_ask', 'look_at'];
function fixture(t, text = original) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-policy-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, '.omo/omo.jsonc');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
  return { root, configPath, env: { HOME: root, USERPROFILE: root }, decision };
}
function apply(options) { return policy.installOraclePolicy(options); }
function oracle(text) { return policy.parseJsonc(text)['[native]'].agents.oracle; }

test('fixture is an exact read-only snapshot of the live source', () => {
  const metadata = JSON.parse(readFileSync(join(fixtures, 'source.json'), 'utf8'));
  assert.equal(sha(readFileSync(snapshot)), metadata.sha256);
  assert.equal(metadata.source, source);
});
test('uses the explicit proven boolean map, with no mutating LSP or spawn tools', () => {
  assert.deepEqual(Object.keys(policy.READONLY_ORACLE_TOOLS).sort(), expected.sort());
  assert.ok(Object.values(policy.READONLY_ORACLE_TOOLS).every(value => value === true));
  assert.equal(policy.READONLY_ORACLE_TOOLS.lsp_rename, undefined);
});
test('dry-run does not write backup, manifest or config; lists all oracle definitions', t => {
  const options = fixture(t);
  const before = readdirSync(dirname(options.configPath));
  const result = apply({ ...options, dryRun: true });
  assert.equal(readFileSync(options.configPath, 'utf8'), original);
  assert.deepEqual(readdirSync(dirname(options.configPath)), before);
  assert.ok(result.sources.some(item => item.path.includes('profiles')));
  assert.deepEqual(result.ranges.map(item => item.path), [['[native]', 'agents', 'oracle', 'tools']]);
});
test('only managed tool ranges change and uninstall restores exact live-copy bytes', t => {
  const options = fixture(t);
  const result = apply(options);
  const installed = readFileSync(options.configPath, 'utf8');
  assert.deepEqual(oracle(installed).tools, policy.READONLY_ORACLE_TOOLS);
  assert.equal(readFileSync(result.backup_path, 'utf8'), original);
  const range = result.ranges[0];
  const before = Buffer.from(original), after = Buffer.from(installed);
  assert.deepEqual(before.subarray(0, range.byte_range_before[0]), after.subarray(0, range.byte_range_after[0]));
  assert.deepEqual(before.subarray(range.byte_range_before[1]), after.subarray(range.byte_range_after[1]));
  const restored = policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(restored.status, 'restored');
  assert.equal(readFileSync(options.configPath, 'utf8'), original);
});
test('uninstall relocates ranges after unrelated prefix edit and retains that edit', t => {
  const options = fixture(t);
  const result = apply(options);
  writeFileSync(options.configPath, '// unrelated owner edit { "tools": "}" }\n' + readFileSync(options.configPath, 'utf8'));
  assert.equal(policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path }).status, 'restored');
  assert.equal(readFileSync(options.configPath, 'utf8'), '// unrelated owner edit { "tools": "}" }\n' + original);
});
test('changed managed range is reported and left untouched', t => {
  const options = fixture(t);
  const result = apply(options);
  const changed = readFileSync(options.configPath, 'utf8').replace('"read":true', '"read":false');
  writeFileSync(options.configPath, changed);
  const restored = policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(restored.status, 'drift');
  assert.equal(restored.ranges[0].status, 'drift');
  assert.equal(readFileSync(options.configPath, 'utf8'), changed);
});
test('all-profiles restores independent unchanged ranges while preserving one drift', t => {
  const options = fixture(t);
  const result = apply({ ...options, allProfiles: true });
  assert.ok(result.ranges.length > 1);
  const changed = readFileSync(options.configPath, 'utf8').replace('"read":true', '"read":false');
  writeFileSync(options.configPath, changed);
  const restored = policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(restored.status, 'drift');
  assert.equal(restored.ranges.filter(item => item.status === 'drift').length, 1);
  assert.ok(restored.ranges.some(item => item.status === 'restored'));
  assert.ok(readFileSync(options.configPath, 'utf8').includes('"read":false'));
});
test('unproven key refuses before any file write', t => {
  const options = fixture(t);
  assert.throws(() => apply({ ...options, decision: { allowlist_key: 'unproven' } }), { code: 'allowlist_unproven' });
  assert.equal(readFileSync(options.configPath, 'utf8'), original);
  assert.equal(readdirSync(dirname(options.configPath)).length, 1);
});
test('scanner preserves BOM, CRLF, comments, escaped strings and trailing commas', t => {
  const hostile = '\uFEFF{\r\n// braces { } and "tools"\r\n"[native]": {"agents": {"oracle": {\r\n'
    + '"model": "escaped \\" } // /*", /* { } */\r\n},},},\r\n}\r\n';
  const options = fixture(t, hostile);
  const result = apply(options);
  const installed = readFileSync(options.configPath, 'utf8');
  assert.ok(installed.startsWith('\uFEFF'));
  assert.ok(installed.includes('// braces { } and "tools"\r\n'));
  assert.equal(oracle(installed).model, 'escaped " } // /*');
  policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(readFileSync(options.configPath, 'utf8'), hostile);
});
test('existing tools value replacement preserves surrounding comments and restores exactly', t => {
  const text = '{ "[native]": { "agents": { "oracle": { "tools": /* keep */ {"write":true,}, "model":"x" } } } }';
  const options = fixture(t, text);
  const result = apply(options);
  assert.ok(readFileSync(options.configPath, 'utf8').includes('/* keep */'));
  assert.equal(result.ranges[0].kind, 'replace');
  policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(readFileSync(options.configPath, 'utf8'), text);
});
test('manifest ranges are UTF-8 byte offsets even after non-ASCII trivia', t => {
  const text = '// \uD83D\uDD0D \uC77D\uAE30\n{"[native]":{"agents":{"oracle":{}}}}';
  const options = fixture(t, text);
  const result = apply(options);
  const range = result.ranges[0];
  const bytes = readFileSync(options.configPath);
  assert.equal(bytes.subarray(...range.byte_range_after).toString('utf8'), range.after_text);
  policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.equal(readFileSync(options.configPath, 'utf8'), text);
});
test('malformed or ambiguous JSONC fails without touching files', t => {
  for (const text of ['{"[native]": {', '{"x":1,"x":2}', '{"x":"unterminated}', '{/*']) {
    const options = fixture(t, text);
    assert.throws(() => apply(options), { code: 'invalid_jsonc' });
    assert.equal(readFileSync(options.configPath, 'utf8'), text);
  }
});
test('effective tools merge project additions, including ancestor layers and profile view', t => {
  const options = fixture(t);
  apply(options);
  const cwd = join(options.root, 'project/sub');
  mkdirSync(join(options.root, 'project/.omo'), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(options.root, 'project/.omo/omo.jsonc'), JSON.stringify({
    '[native]': { agents: { oracle: { tools: { write: true } } } },
  }));
  const result = policy.effectiveOracleTools(cwd, { env: options.env });
  assert.ok(result.tools.includes('read'));
  assert.ok(result.tools.includes('write'));
  assert.equal(result.status, 'oracle_not_readonly');
  assert.deepEqual(result.unsafe_tools, ['write']);
  assert.ok(result.sources.some(item => item.scope === 'project'));
});
test('profile switching is re-resolved without cache; all-profiles removes profile write', t => {
  const options = fixture(t, '{"[native]":{"agents":{"oracle":{"model":"x"}}},"profiles":{"safe":{"[native]":{"agents":{"oracle":{}}}},"unsafe":{"[native]":{"agents":{"oracle":{"tools":{"write":true}}}}}}}');
  const first = apply(options);
  const safe = policy.effectiveOracleTools(options.root, { env: { ...options.env, OMO_PROFILE: 'safe', OCX_PROFILE: 'unsafe' } });
  assert.equal(safe.readonly, true);
  const unsafe = policy.effectiveOracleTools(options.root, { env: { ...options.env, OMO_PROFILE: 'unsafe' } });
  assert.equal(unsafe.readonly, false);
  policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: first.manifest_path });
  apply({ ...options, allProfiles: true, manifestPath: join(options.root, 'all.json') });
  assert.equal(policy.effectiveOracleTools(options.root, { env: { ...options.env, OMO_PROFILE: 'unsafe' } }).readonly, true);
});
test('selection files are not profile selectors; missing or malformed policy fails closed', t => {
  const options = fixture(t);
  writeFileSync(join(options.root, '.omo/native-profile-selection.json'), '{"profile":"not-a-native-selector"}');
  assert.equal(policy.effectiveOracleTools(options.root, { env: options.env }).status, 'oracle_not_readonly');
  apply(options);
  const result = policy.effectiveOracleTools(options.root, { env: options.env });
  assert.equal(result.active_profile, null);
  assert.equal(result.readonly, true);
  writeFileSync(options.configPath, 'invalid');
  assert.equal(policy.effectiveOracleTools(options.root, { env: options.env }).status, 'oracle_not_readonly');
});

const retained = JSON.parse(readFileSync(join(fixtures, 'gate-review.json'), 'utf8'));
function verifierFixture(t, name) {
  const root = mkdtempSync(join(tmpdir(), `oracle-policy-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = `${name}/home/`;
  for (const [path, entry] of Object.entries(retained.files)) {
    if (!path.startsWith(prefix)) continue;
    assert.equal(sha(entry.text), entry.sha256);
    const destination = join(root, path.slice(prefix.length));
    mkdirSync(dirname(destination), { recursive: true });
    if (path.endsWith('.oracle-advisor-delta.json')) {
      const manifest = JSON.parse(entry.text);
      manifest.config_path = join(root, '.omo/omo.jsonc');
      manifest.manifest_path = destination;
      writeFileSync(destination, JSON.stringify(manifest));
    } else writeFileSync(destination, entry.text);
  }
  return { root, configPath: join(root, '.omo/omo.jsonc'), env: { HOME: root, USERPROFILE: root }, decision };
}
function sameAsInstalled(options, cwd = options.root, selectors = {}) {
  const env = { ...options.env, ...selectors };
  const actual = installedLoader.loadOmoConfig({ cwd, env, harness: 'native' });
  const enabled = Object.entries(actual.config.agents.oracle?.tools ?? {})
    .filter(([, allowed]) => allowed).map(([name]) => name).sort();
  const resolved = policy.effectiveOracleTools(cwd, { env });
  assert.deepEqual(resolved.tools, enabled, 'Product tools must equal the installed loader true keys.');
  assert.equal(resolved.readonly, enabled.length > 0 &&
    enabled.every(name => expected.includes(name)), 'Read-only result must agree with the installed tool map.');
  return { actual, resolved };
}
test('T11-PRECEDENCE: retained legacy project override agrees with installed loader', t => {
  const options = verifierFixture(t, 'legacy');
  const { actual, resolved } = sameAsInstalled(options, join(options.root, 'project'));
  assert.equal(actual.config.agents.oracle.model, 'fixture-project');
  assert.deepEqual(resolved.tools, ['read', 'write']);
  assert.equal(resolved.status, 'oracle_not_readonly');
});
test('T11-PRECEDENCE: retained canonical hierarchy and all selectors agree with installed loader', t => {
  const options = verifierFixture(t, 'canonical');
  const cwd = join(options.root, 'project/nested');
  for (const selectors of [
    { OMO_PROFILE: 'safe', OCX_PROFILE: 'unsafe' }, { OCX_PROFILE: 'unsafe' },
    { OPENCODE_CONFIG_DIR: join(options.root, 'profiles/safe/') }, { OMO_PROFILE: 'plain' }, {},
  ]) {
    const { actual } = sameAsInstalled(options, cwd, selectors);
    assert.equal(actual.config.agents.oracle.model, 'near-project');
  }
});
test('T11-PRECEDENCE: all accepted oracle views and same-layer alias collisions agree with installed loader', t => {
  const user = {
    agents: { oracle: { tools: { read: true, write: false } } },
    '[native]': { agents: { oracle: { tools: { read: true, write: false } } } },
    profiles: { selected: { '[native]': { agents: { oracle: { tools: { write: false } } } } } },
  };
  const options = fixture(t, JSON.stringify(user));
  const cwd = join(options.root, 'project');
  mkdirSync(join(cwd, '.omo'), { recursive: true });
  for (const project of [
    { agents: { oracle: { tools: { write: true } } } },
    { '[native]': { agents: { oracle: { tools: { write: true } } } } },
    { '[senpi]': { agents: { oracle: { tools: { write: true } } } } },
    { profiles: { selected: { agents: { oracle: { tools: { write: true } } } } } },
    { profiles: { selected: { '[native]': { agents: { oracle: { tools: { write: true } } } } } } },
    { profiles: { selected: { '[senpi]': { agents: { oracle: { tools: { write: true } } } } } } },
    { '[senpi]': { agents: { oracle: { tools: { write: true } } } }, '[native]': {} },
    { profiles: { selected: { '[senpi]': { agents: { oracle: { tools: { write: true } } } }, '[native]': {} } } },
  ]) {
    writeFileSync(join(cwd, '.omo/omo.jsonc'), JSON.stringify(project));
    sameAsInstalled(options, cwd);
    sameAsInstalled(options, cwd, { OMO_PROFILE: 'selected' });
  }
});
test('T11-PRECEDENCE: JSON fallback and JSONC preference agree with installed loader', t => {
  const options = fixture(t, '{"agents":{"oracle":{"tools":{"read":true,"write":false}}}}');
  const cwd = join(options.root, 'project');
  mkdirSync(join(cwd, '.omo'), { recursive: true });
  writeFileSync(join(cwd, '.omo/omo.json'), '{"agents":{"oracle":{"tools":{"write":true}}}}');
  sameAsInstalled(options, cwd);
  writeFileSync(join(cwd, '.omo/omo.jsonc'), '{"agents":{"oracle":{"tools":{"write":false}}}}');
  sameAsInstalled(options, cwd);
  rmSync(options.configPath);
  writeFileSync(join(options.root, '.omo/omo.json'), '{"agents":{"oracle":{"tools":{"read":true}}}}');
  sameAsInstalled(options, cwd);
});
test('T11-COMMENTS: retained internal comments survive replacement and exact uninstall', t => {
  const options = verifierFixture(t, 'inner-comment');
  const before = readFileSync(options.configPath);
  const result = apply({ ...options, manifestPath: join(options.root, 'new-delta.json') });
  const after = readFileSync(options.configPath, 'utf8');
  const comments = before.toString('utf8').match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g);
  for (const comment of comments) assert.ok(after.includes(comment), `Comment bytes lost: ${comment}`);
  assert.deepEqual(oracle(after).tools, policy.READONLY_ORACLE_TOOLS);
  policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
  assert.deepEqual(readFileSync(options.configPath), before);
});
test('T11-RESTORE: retained empty-oracle insertion restores beside an unrelated sibling', t => {
  const options = verifierFixture(t, 'empty-sibling');
  const result = policy.uninstallOraclePolicy({ configPath: options.configPath });
  assert.equal(result.status, 'restored');
  assert.equal(readFileSync(options.configPath, 'utf8'),
    '{"[native]":{"agents":{"oracle":{"model":"owner-added-sibling"}}}}\n');
});
test('T11-RESTORE: sibling additions and removals retain comments and valid separators', t => {
  for (const originalOracle of ['{}', '{"model":"original"}']) {
    for (const placement of ['before', 'after', 'only']) {
      const text = `{"[native]":{"agents":{"oracle":${originalOracle}}}}`;
      const options = fixture(t, text);
      const result = apply(options);
      const managed = `"tools":${JSON.stringify(policy.READONLY_ORACLE_TOOLS)}`;
      const sibling = '"model":"owner"';
      const edited = placement === 'before' ? `{${sibling}, /*before*/ ${managed}}`
        : placement === 'after' ? `{${managed} /*after*/, ${sibling}}` : `{${managed}}`;
      writeFileSync(options.configPath, `{"[native]":{"agents":{"oracle":${edited}}}}`);
      const uninstalled = policy.uninstallOraclePolicy({ configPath: options.configPath, manifestPath: result.manifest_path });
      assert.equal(uninstalled.status, 'restored');
      const restored = readFileSync(options.configPath, 'utf8');
      assert.deepEqual(oracle(restored), placement === 'only' ? {} : { model: 'owner' });
      if (placement !== 'only') assert.ok(restored.includes(`/*${placement}*/`));
    }
  }
});
test('retained hostile and duplicate fixtures preserve bytes and refusal behavior', t => {
  const hostile = verifierFixture(t, 'hostile');
  const before = readFileSync(hostile.configPath);
  const directoryBefore = readdirSync(dirname(hostile.configPath));
  apply({ ...hostile, dryRun: true, allProfiles: true });
  assert.deepEqual(readFileSync(hostile.configPath), before);
  assert.deepEqual(readdirSync(dirname(hostile.configPath)), directoryBefore);
  const installed = apply({ ...hostile, allProfiles: true });
  policy.uninstallOraclePolicy({ configPath: hostile.configPath, manifestPath: installed.manifest_path });
  assert.deepEqual(readFileSync(hostile.configPath), before);
  const duplicate = verifierFixture(t, 'duplicate');
  const invalid = readFileSync(duplicate.configPath);
  for (const dryRun of [false, true]) {
    assert.throws(() => apply({ ...duplicate, dryRun }), { code: 'invalid_jsonc' });
    assert.deepEqual(readFileSync(duplicate.configPath), invalid);
  }
});
test('retained drift fixture remains untouched in dry-run and real uninstall', t => {
  const options = verifierFixture(t, 'drift');
  const manifestPath = `${options.configPath}.oracle-advisor-delta.json`;
  const before = readFileSync(options.configPath);
  const manifest = readFileSync(manifestPath);
  assert.equal(policy.uninstallOraclePolicy({ configPath: options.configPath, dryRun: true }).status, 'drift');
  assert.deepEqual(readFileSync(options.configPath), before);
  assert.deepEqual(readFileSync(manifestPath), manifest);
  assert.equal(policy.uninstallOraclePolicy({ configPath: options.configPath }).status, 'drift');
  assert.deepEqual(readFileSync(options.configPath), before);
});
