import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildProduct } from '../scripts/build.mjs';
import { install } from '../scripts/install.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-install-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'product'), agentDir = join(directory, 'home/.omo/agent');
  for (const path of [join(source, 'src'), join(source, 'scripts'), join(source, 'prompts'), join(source, 'config'), agentDir]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(source, 'src/extension.mjs'),
    "import './next.mjs'; export { default } from '../scripts/runtime.mjs';\n");
  writeFileSync(join(source, 'src/next.mjs'),
    "import { readFileSync } from 'node:fs'; export const prompt = readFileSync(new URL('../prompts/advice.md', import.meta.url), 'utf8');\n" +
    "export const routingDefault = readFileSync(new URL('../config/routing.default.json', import.meta.url), 'utf8');\n");
  writeFileSync(join(source, 'scripts/runtime.mjs'), 'export default function extension() {}\n');
  writeFileSync(join(source, 'src/not-imported.mjs'), 'this is not JavaScript\n');
  writeFileSync(join(source, 'prompts/advice.md'), 'fixture prompt\n');
  writeFileSync(join(source, 'config/routing.default.json'), '{"v":1,"fixture":true}\n');
  const configPath = join(directory, 'home/.omo/omo.jsonc');
  const original = '// retained comment\n{"[native]":{"agents":{"oracle":{"model":"fixture/oracle"}}}}\n';
  writeFileSync(configPath, original);
  writeFileSync(join(agentDir, 'settings.json'), '{"untouched":true}\n');
  return { source, agentDir, configPath, original, env: { HOME: join(directory, 'home') }, cwd: directory };
}

test('build follows transitive module and URL asset references, checks syntax and preserves the last good dist', t => {
  const f = fixture(t);
  const built = buildProduct({ root: f.source });
  assert.deepEqual(Object.keys(built.sha256).sort(), [
    'config/routing.default.json', 'prompts/advice.md', 'scripts/runtime.mjs', 'src/extension.mjs', 'src/next.mjs',
  ]);
  for (const [path, hash] of Object.entries(built.sha256)) {
    assert.equal(sha(readFileSync(join(f.source, 'dist', path))), hash);
  }
  const before = readFileSync(join(f.source, 'dist/src/next.mjs'));
  writeFileSync(join(f.source, 'src/next.mjs'), 'invalid JavaScript!\n');
  assert.throws(() => buildProduct({ root: f.source }), /Syntax check failed/);
  assert.deepEqual(readFileSync(join(f.source, 'dist/src/next.mjs')), before);
  assert.equal(readdirSync(f.source).some(name => name.startsWith('.dist-stage-')), false);
});

test('install dry-run, generation upgrade and uninstall preserve existing files and restore the policy bytes', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const settings = readFileSync(join(f.agentDir, 'settings.json'));
  const options = { ...f, dist: join(f.source, 'dist') };
  const dry = install({ ...options, dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(existsSync(join(f.agentDir, 'oracle-advisor')), false);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  const first = install(options);
  assert.equal(first.generation, 'generation-000001');
  assert.equal(first.policy.status, 'applied');
  const current = JSON.parse(readFileSync(join(f.agentDir, 'oracle-advisor/current.json'), 'utf8'));
  assert.deepEqual(current.sha256, first.sha256);
  assert.match(readFileSync(first.shim_path, 'utf8'), /^\/\/ managed by omo-oracle-advisor\n/);
  assert.match(readFileSync(first.shim_path, 'utf8'), /generation-000001\/src\/extension\.mjs/);
  const second = install(options);
  assert.equal(second.generation, 'generation-000002');
  assert.equal(existsSync(first.generation_path), true);
  const preview = install({ ...options, uninstall: true, dryRun: true });
  assert.equal(preview.policy.status, 'restored');
  assert.equal(existsSync(first.shim_path), true);
  const removed = install({ ...options, uninstall: true });
  assert.equal(removed.status, 'uninstalled');
  assert.equal(removed.policy.dry_run, false);
  assert.equal(existsSync(first.shim_path), false);
  assert.equal(existsSync(first.generation_path), true);
  assert.equal(existsSync(second.generation_path), true);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  assert.deepEqual(readFileSync(join(f.agentDir, 'settings.json')), settings);
  assert.equal(install(options).generation, 'generation-000003');
});

test('a foreign shim refuses install and uninstall before any policy or generation change', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  mkdirSync(join(f.agentDir, 'extensions'));
  const shim = join(f.agentDir, 'extensions/omo-oracle-advisor.js');
  writeFileSync(shim, '// owned by someone else\n');
  for (const uninstall of [false, true]) {
    assert.throws(() => install({ ...f, dist: join(f.source, 'dist'), uninstall }), { code: 'foreign_shim' });
  }
  assert.equal(readFileSync(shim, 'utf8'), '// owned by someone else\n');
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  assert.equal(existsSync(join(f.agentDir, 'oracle-advisor')), false);
});

test('routing.json is installed when absent, preserved when modified, and removed on uninstall if unchanged', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const options = { ...f, dist: join(f.source, 'dist') };
  const routingPath = join(f.agentDir, 'oracle-advisor/routing.json');

  // Pre-seed a modified routing table
  mkdirSync(join(f.agentDir, 'oracle-advisor'), { recursive: true });
  writeFileSync(routingPath, '{"custom": true}\n');
  const customSha = sha(readFileSync(routingPath));

  // Install preserves existing routing table
  const dry = install({ ...options, dryRun: true });
  assert.equal(dry.routing.status, 'preserved');
  assert.equal(dry.routing.sha256, customSha);
  assert.equal(readFileSync(routingPath, 'utf8'), '{"custom": true}\n');

  const inst = install(options);
  assert.equal(inst.routing.status, 'preserved');
  assert.equal(inst.routing.sha256, customSha);
  assert.equal(readFileSync(routingPath, 'utf8'), '{"custom": true}\n');

  const current = JSON.parse(readFileSync(join(f.agentDir, 'oracle-advisor/current.json'), 'utf8'));
  assert.equal(current.routing.status, 'preserved');
  assert.equal(current.routing.sha256, customSha);

  // Uninstall keeps modified table
  const uninstDry = install({ ...options, uninstall: true, dryRun: true });
  assert.equal(uninstDry.routing, 'routing_kept_modified');
  assert.ok(uninstDry.kept.includes('routing.json'));
  assert.equal(readFileSync(routingPath, 'utf8'), '{"custom": true}\n');

  const uninst = install({ ...options, uninstall: true });
  assert.equal(uninst.routing, 'routing_kept_modified');
  assert.ok(uninst.kept.includes('routing.json'));
  assert.equal(existsSync(routingPath), true);
  assert.equal(readFileSync(routingPath, 'utf8'), '{"custom": true}\n');

  // Remove routing.json and reinstall -> created default
  rmSync(routingPath);
  const inst2 = install(options);
  assert.equal(inst2.routing.status, 'created');
  assert.equal(existsSync(routingPath), true);
  const defaultSha = inst2.routing.sha256;
  assert.equal(sha(readFileSync(routingPath)), defaultSha);
  // Verify created bytes exactly equal generation's config/routing.default.json
  assert.deepEqual(readFileSync(routingPath), readFileSync(join(options.dist, 'config/routing.default.json')));

  // Uninstall --dry-run with default routing.json keeps routing.json and writes nothing
  const uninstDefaultDry = install({ ...options, uninstall: true, dryRun: true });
  assert.equal(uninstDefaultDry.routing, 'removed');
  assert.equal(existsSync(routingPath), true);
  assert.equal(sha(readFileSync(routingPath)), defaultSha);

  // Uninstall with default routing.json -> removed
  const uninst2 = install({ ...options, uninstall: true });
  assert.equal(uninst2.routing, 'removed');
  assert.equal(existsSync(routingPath), false);
});

test('structural policy_drift handles PowerShell-style CRLF formatting, detects missing keys and modified values', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const options = { ...f, dist: join(f.source, 'dist') };

  // 1. Initial install
  const inst = install(options);
  assert.equal(inst.policy.status, 'applied');
  const manifest = JSON.parse(readFileSync(inst.policy.manifest_path, 'utf8'));
  const originalGen = inst.generation;

  // Next generation check: assert "the next generation number", not a literal
  const nextGenExpected = `generation-${String(Number(originalGen.replace('generation-', '')) + 1).padStart(6, '0')}`;

  // 2. Simulate PowerShell-style re-serialization (CRLF, double spaces after colons, indent 4)
  // Format with double spaces and CRLF with exact READONLY_ORACLE_TOOLS content
  const psFormatted = '{\r\n' +
    '    "[native]":  {\r\n' +
    '        "agents":  {\r\n' +
    '            "oracle":  {\r\n' +
    '                "model":  "fixture/oracle",\r\n' +
    '                "tools":  ' + JSON.stringify(READONLY_ORACLE_TOOLS).replace(/:/g, ':  ') + '\r\n' +
    '            }\r\n' +
    '        }\r\n' +
    '    }\r\n' +
    '}\r\n';
  writeFileSync(f.configPath, psFormatted);

  // Install next generation dry-run: should report policy unchanged (no drift)
  const dry2 = install({ ...options, dryRun: true });
  assert.equal(dry2.generation, nextGenExpected);
  assert.equal(dry2.policy.status, 'unchanged');

  // Real install leaves config bytes unchanged
  const inst2 = install(options);
  assert.equal(inst2.generation, nextGenExpected);
  assert.equal(readFileSync(f.configPath, 'utf8'), psFormatted);

  // Uninstall removes inserted tools properties and leaves parseable result
  const uninst = install({ ...options, uninstall: true });
  assert.equal(uninst.status, 'uninstalled');
  assert.equal(uninst.policy.status, 'restored');
  const parsedRestored = JSON.parse(readFileSync(f.configPath, 'utf8'));
  assert.equal(parsedRestored['[native]'].agents.oracle.tools, undefined);

  // 3. Negative case: modified value inside managed tools -> policy_drift
  const inst3 = install(options);
  // Re-read installed and change one tool boolean
  const driftedVal = readFileSync(f.configPath, 'utf8').replace('"read":true', '"read":false');
  writeFileSync(f.configPath, driftedVal);
  const configBeforeDrift1 = readFileSync(f.configPath, 'utf8');
  const routingPath = join(f.agentDir, 'oracle-advisor/routing.json');
  const routingBeforeDrift1 = readFileSync(routingPath, 'utf8');
  const shimBeforeDrift1 = readFileSync(inst3.shim_path, 'utf8');
  assert.throws(() => install({ ...options, uninstall: true }), { code: 'policy_drift' });
  // Verify nothing was written on drift refusal
  assert.equal(readFileSync(f.configPath, 'utf8'), configBeforeDrift1);
  assert.equal(readFileSync(routingPath, 'utf8'), routingBeforeDrift1);
  assert.equal(readFileSync(inst3.shim_path, 'utf8'), shimBeforeDrift1);

  // Restore valid value so config is in clean state before next case
  writeFileSync(f.configPath, readFileSync(f.configPath, 'utf8').replace('"read":false', '"read":true'));

  // 4. Negative case: extra tool added to managed tools -> policy_drift (todo 9 step 3)
  const driftedExtra = readFileSync(f.configPath, 'utf8').replace('"read":true,', '"read":true,"bash":true,');
  writeFileSync(f.configPath, driftedExtra);
  const configBeforeDrift2 = readFileSync(f.configPath, 'utf8');
  assert.throws(() => install({ ...options, uninstall: true }), { code: 'policy_drift' });
  // Verify nothing was written on extra-tool drift refusal
  assert.equal(readFileSync(f.configPath, 'utf8'), configBeforeDrift2);
  assert.equal(readFileSync(routingPath, 'utf8'), routingBeforeDrift1);
  assert.equal(readFileSync(inst3.shim_path, 'utf8'), shimBeforeDrift1);

  // Restore valid value
  writeFileSync(f.configPath, readFileSync(f.configPath, 'utf8').replace('"bash":true,', ''));

  // 5. Negative case: missing managed key -> policy_drift
  const driftedKey = readFileSync(f.configPath, 'utf8').replace(/"tools":\{[^}]*\},/, '');
  writeFileSync(f.configPath, driftedKey);
  const configBeforeDrift3 = readFileSync(f.configPath, 'utf8');
  assert.throws(() => install({ ...options, uninstall: true }), { code: 'policy_drift' });
  assert.equal(readFileSync(f.configPath, 'utf8'), configBeforeDrift3);
  assert.equal(readFileSync(routingPath, 'utf8'), routingBeforeDrift1);
  assert.equal(readFileSync(inst3.shim_path, 'utf8'), shimBeforeDrift1);
});

test('install fails loudly when dist is missing routing.default.json before any write', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const dist = join(f.source, 'dist');
  rmSync(join(dist, 'config/routing.default.json'));
  assert.throws(() => install({ ...f, dist }), { code: 'routing_default_missing' });
  assert.equal(existsSync(join(f.agentDir, 'oracle-advisor')), false);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
});

test('a failed install leaves no routing.json and previous generation active', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const options = { ...f, dist: join(f.source, 'dist') };

  // 1. Failure before policy/generation copy (manifest_exists)
  const blockedManifest = join(f.agentDir, 'oracle-advisor/oracle-policy-generation-000001.json');
  mkdirSync(join(f.agentDir, 'oracle-advisor'), { recursive: true });
  writeFileSync(blockedManifest, '{"dummy":true}\n');
  const routingPath = join(f.agentDir, 'oracle-advisor/routing.json');
  assert.equal(existsSync(routingPath), false);

  assert.throws(() => install(options), { code: 'manifest_exists' });
  assert.equal(existsSync(routingPath), false);

  // Clean up blocked manifest and partial generation directory, then complete first install
  rmSync(blockedManifest);
  rmSync(join(f.agentDir, 'oracle-advisor/integration'), { recursive: true, force: true });
  const inst1 = install(options);
  assert.equal(inst1.generation, 'generation-000001');
  assert.equal(existsSync(routingPath), true);
  const gen1Shim = readFileSync(inst1.shim_path, 'utf8');
  const currentPath = join(f.agentDir, 'oracle-advisor/current.json');
  const gen1Current = readFileSync(currentPath, 'utf8');

  // 2. Failure during current.json replaceWrite (open handle blocks atomic rename on Windows)
  rmSync(routingPath);
  assert.equal(existsSync(routingPath), false);

  const fdCurrent = openSync(currentPath, 'r+'); // Windows exclusive open handle blocks replaceWrite rename
  try {
    assert.throws(() => install(options), { code: 'EPERM' });
  } finally {
    closeSync(fdCurrent);
  }

  // Routing.json must NOT have been written
  assert.equal(existsSync(routingPath), false);
  // Shim must still point to generation-000001
  assert.equal(readFileSync(inst1.shim_path, 'utf8'), gen1Shim);
  // current.json must still record generation-000001
  assert.equal(readFileSync(currentPath, 'utf8'), gen1Current);

  // 3. Failure during shim replaceWrite (T4b: open handle blocks atomic rename on Windows)
  const fdShim = openSync(inst1.shim_path, 'r+'); // Windows exclusive open handle blocks shim rename
  try {
    assert.throws(() => install(options), { code: 'EPERM' });
  } finally {
    closeSync(fdShim);
  }

  // Routing.json must NOT have been written
  assert.equal(existsSync(routingPath), false);
  // Shim bytes must remain unchanged (still generation-000001)
  assert.equal(readFileSync(inst1.shim_path, 'utf8'), gen1Shim);
  // current.json was updated right before shim failure (pre-existing commit ordering), but routing.json was never created
  const afterShimFailCurrent = JSON.parse(readFileSync(currentPath, 'utf8'));
  assert.equal(afterShimFailCurrent.generation, 'generation-000003');
});

test('default_sha256 updates when next generation default differs, and uninstall removes untouched new default', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const options = { ...f, dist: join(f.source, 'dist') };
  const routingPath = join(f.agentDir, 'oracle-advisor/routing.json');

  // Generation 1 install
  const inst1 = install(options);
  assert.equal(inst1.generation, 'generation-000001');
  const gen1DefaultSha = inst1.routing.sha256;

  // Now delete routing.json (as if user removed it or test scenario)
  rmSync(routingPath);

  // Update dist/config/routing.default.json with new default
  const newDefaultContent = '{"v":1,"gen":2,"updatedDefault":true}\n';
  writeFileSync(join(options.dist, 'config/routing.default.json'), newDefaultContent);
  const gen2DefaultSha = sha(newDefaultContent);
  assert.notEqual(gen2DefaultSha, gen1DefaultSha);

  // Generation 2 install -> creates routing.json with gen2 default
  const inst2 = install(options);
  assert.equal(inst2.generation, 'generation-000002');
  assert.equal(inst2.routing.status, 'created');
  assert.equal(inst2.routing.sha256, gen2DefaultSha);

  // current.json must record gen2DefaultSha as default_sha256!
  const current = JSON.parse(readFileSync(join(f.agentDir, 'oracle-advisor/current.json'), 'utf8'));
  assert.equal(current.routing.default_sha256, gen2DefaultSha);

  // Uninstall -> must remove the untouched gen2 default (NOT keep as routing_kept_modified)
  const uninst = install({ ...options, uninstall: true });
  assert.equal(uninst.routing, 'removed');
  assert.equal(existsSync(routingPath), false);
});

test('T5: preserved untouched table across upgraded generation with different default keeps original default_sha and is removed', t => {
  const f = fixture(t);
  buildProduct({ root: f.source });
  const options = { ...f, dist: join(f.source, 'dist') };
  const routingPath = join(f.agentDir, 'oracle-advisor/routing.json');

  // 1. Generation 1 install creates routing.json with default A
  const inst1 = install(options);
  assert.equal(inst1.generation, 'generation-000001');
  const defaultASha = inst1.routing.sha256;
  assert.equal(existsSync(routingPath), true);
  const defaultABytes = readFileSync(routingPath);

  // 2. Next generation dist ships DIFFERENT default B
  const defaultBContent = '{"v":1,"gen":2,"defaultB":true}\n';
  writeFileSync(join(options.dist, 'config/routing.default.json'), defaultBContent);
  const defaultBSha = sha(defaultBContent);
  assert.notEqual(defaultBSha, defaultASha);

  // 3. Install gen-2 with existing default A table untouched
  const inst2 = install(options);
  assert.equal(inst2.generation, 'generation-000002');
  assert.equal(inst2.routing.status, 'preserved');
  assert.equal(inst2.routing.sha256, defaultASha);
  assert.deepEqual(readFileSync(routingPath), defaultABytes);

  // current.json must KEEP default_sha256 = defaultASha (not defaultBSha!)
  const current2 = JSON.parse(readFileSync(join(f.agentDir, 'oracle-advisor/current.json'), 'utf8'));
  assert.equal(current2.routing.default_sha256, defaultASha);

  // 4. Uninstall must REMOVE the untouched table because its sha matches recorded default_sha256 (defaultASha)
  const uninst = install({ ...options, uninstall: true });
  assert.equal(uninst.routing, 'removed');
  assert.equal(existsSync(routingPath), false);
});
