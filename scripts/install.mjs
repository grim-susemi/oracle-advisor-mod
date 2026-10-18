import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ENTRY, fileHashes, runtimeFiles } from './build.mjs';
import { installOraclePolicy, uninstallOraclePolicy } from './oracle-policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = '// managed by omo-oracle-advisor';
const fail = (code, message = code) => Object.assign(new Error(message), { code });
function replaceWrite(path, text) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function refuseLink(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw fail('symlink_target_refused', path);
}

export function install({
  agentDir, dist = join(ROOT, 'dist'), configPath,
  dryRun = false, uninstall = false, cwd = process.cwd(), env = process.env,
}) {
  if (!agentDir) throw fail('agent_dir_required', 'Use --agent-dir <existing directory>.');
  agentDir = resolve(agentDir);
  refuseLink(agentDir);
  if (!lstatSync(agentDir).isDirectory()) throw fail('agent_dir_required');
  configPath = resolve(configPath ?? join(dirname(agentDir), 'omo.jsonc'));
  const base = join(agentDir, 'oracle-advisor');
  const integration = join(base, 'integration');
  const currentPath = join(base, 'current.json');
  const extensions = join(agentDir, 'extensions');
  const shimPath = join(extensions, 'omo-oracle-advisor.js');
  for (const path of [base, integration, currentPath, extensions, shimPath]) refuseLink(path);
  // Check ownership before policy preflight or creating even a directory.
  if (existsSync(shimPath) && readFileSync(shimPath, 'utf8').split(/\r?\n/, 1)[0] !== MARKER) {
    throw fail('foreign_shim', 'Refusing non-managed omo-oracle-advisor.js; nothing changed.');
  }
  const current = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, 'utf8')) : null;
  if (current?.policy?.config_path && resolve(current.policy.config_path) !== configPath) {
    throw fail('policy_target_mismatch');
  }
  if (uninstall) {
    let policy = current?.policy?.manifest_path && existsSync(current.policy.manifest_path)
      ? uninstallOraclePolicy({ configPath, manifestPath: current.policy.manifest_path, dryRun: true })
      : { status: 'unchanged' };
    if (policy.status === 'drift') throw fail('policy_drift', 'Managed policy drift; shim and config left intact.');
    if (!dryRun) {
      if (current?.policy?.manifest_path && existsSync(current.policy.manifest_path)) {
        policy = uninstallOraclePolicy({ configPath, manifestPath: current.policy.manifest_path });
      }
      if (existsSync(shimPath)) unlinkSync(shimPath);
    }
    return { status: dryRun ? 'dry_run' : 'uninstalled', agent_dir: agentDir,
      shim_path: shimPath, policy, kept: ['generations', 'current.json', 'policy backups and manifests', 'logs'] };
  }
  if (!existsSync(join(dist, ENTRY))) throw fail('dist_missing', 'Run npm run build first.');
  const files = runtimeFiles(dist);
  const sha256 = fileHashes(dist, files);
  const numbers = existsSync(integration) ? readdirSync(integration)
    .map(name => /^generation-(\d{6})$/.exec(name)).filter(Boolean).map(match => Number(match[1])) : [];
  const generation = `generation-${String(Math.max(0, ...numbers) + 1).padStart(6, '0')}`;
  const generationPath = join(integration, generation);
  let manifestPath = join(base, `oracle-policy-${generation}.json`);
  if (current?.policy?.manifest_path && existsSync(current.policy.manifest_path)) {
    const prior = JSON.parse(readFileSync(current.policy.manifest_path, 'utf8'));
    if (prior.status !== 'restored') {
      const checked = uninstallOraclePolicy({ configPath, manifestPath: current.policy.manifest_path, dryRun: true });
      if (checked.status === 'drift') throw fail('policy_drift');
      manifestPath = current.policy.manifest_path;
    }
  }
  const policyOptions = { configPath, manifestPath, cwd, env, allProfiles: true };
  const policy = installOraclePolicy({ ...policyOptions, dryRun: true });
  const report = {
    status: dryRun ? 'dry_run' : 'installed', generation, generation_path: generationPath,
    agent_dir: agentDir, shim_path: shimPath, entry: ENTRY, sha256, policy,
  };
  if (dryRun) return report;
  mkdirSync(generationPath, { recursive: true });
  for (const file of files) {
    const target = join(generationPath, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dist, file), target);
  }
  report.policy = installOraclePolicy(policyOptions);
  const manifest = {
    generation, installed_at: new Date().toISOString(), entry: ENTRY, sha256,
    policy: { config_path: configPath,
      manifest_path: existsSync(manifestPath) ? manifestPath : null },
  };
  replaceWrite(currentPath, JSON.stringify(manifest, null, 2) + '\n');
  mkdirSync(extensions, { recursive: true });
  replaceWrite(shimPath, `${MARKER}\nexport { default } from '../oracle-advisor/integration/${generation}/${ENTRY}';\n`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'agent-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, uninstall: { type: 'boolean' },
    } });
    console.log(JSON.stringify(install({
      agentDir: values['agent-dir'], dryRun: !!values['dry-run'], uninstall: !!values.uninstall,
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: error.code ?? 'install_error', message: error.message }));
    process.exitCode = 1;
  }
}
