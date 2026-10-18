import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertNodeLaunch, nodeSpawnEnvironment } from '../qa/node-spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ENTRY = 'src/extension.mjs';

// Runtime imports are literal ESM specifiers; URL-relative resources use the
// same graph so prompt files cannot silently disappear from a generation.
export function runtimeFiles(root, entry = ENTRY) {
  root = resolve(root);
  const files = new Set();
  function visit(file) {
    const path = resolve(root, file);
    const local = relative(root, path);
    if (local === '..' || local.startsWith(`..${sep}`)) throw new Error(`Dependency escapes product: ${file}`);
    const name = local.replaceAll('\\', '/');
    if (files.has(name)) return;
    const bytes = readFileSync(path);
    files.add(name);
    if (!/\.m?js$/.test(path)) return;
    const text = bytes.toString('utf8');
    const imports = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of text.matchAll(imports)) {
      const specifier = match[1] ?? match[2];
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) throw new Error(`Non-builtin runtime dependency: ${specifier}`);
      visit(relative(root, resolve(dirname(path), specifier)));
    }
    for (const match of text.matchAll(/\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      visit(relative(root, resolve(dirname(path), match[1])));
    }
  }
  visit(entry);
  return [...files].sort();
}

export function fileHashes(directory, files = runtimeFiles(directory)) {
  return Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')]));
}

export function buildProduct({ root = ROOT } = {}) {
  const nonce = randomUUID();
  const stage = join(root, `.dist-stage-${nonce}`);
  const previous = join(root, `.dist-previous-${nonce}`);
  const dist = join(root, 'dist');
  try {
    mkdirSync(stage);
    for (const file of runtimeFiles(root)) {
      const destination = join(stage, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, file), destination);
      if (/\.m?js$/.test(file)) {
        const args = ['--check', destination];
        const env = nodeSpawnEnvironment(process.env);
        assertNodeLaunch(process.execPath, args, env, { nodeProfile: 'syntax' });
        const checked = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
        if (checked.status !== 0) throw new Error(`Syntax check failed: ${file}\n${checked.stderr}`);
      }
    }
    const report = { entry: ENTRY, sha256: fileHashes(stage) };
    if (existsSync(dist)) renameSync(dist, previous);
    try { renameSync(stage, dist); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, dist);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return report;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = buildProduct();
    console.log(`build ok -> dist/ (${Object.keys(report.sha256).length} runtime files)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
