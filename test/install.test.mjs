import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildProduct } from '../scripts/build.mjs';
import { install } from '../scripts/install.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-install-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'product'), agentDir = join(directory, 'home/.omo/agent');
  for (const path of [join(source, 'src'), join(source, 'scripts'), join(source, 'prompts'), agentDir]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(source, 'src/extension.mjs'),
    "import './next.mjs'; export { default } from '../scripts/runtime.mjs';\n");
  writeFileSync(join(source, 'src/next.mjs'),
    "import { readFileSync } from 'node:fs'; export const prompt = readFileSync(new URL('../prompts/advice.md', import.meta.url), 'utf8');\n");
  writeFileSync(join(source, 'scripts/runtime.mjs'), 'export default function extension() {}\n');
  writeFileSync(join(source, 'src/not-imported.mjs'), 'this is not JavaScript\n');
  writeFileSync(join(source, 'prompts/advice.md'), 'fixture prompt\n');
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
    'prompts/advice.md', 'scripts/runtime.mjs', 'src/extension.mjs', 'src/next.mjs',
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
