import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = mkdtempSync(join(tmpdir(), 'oracle-acceptance-launch-'));
const attempt = `acceptance-launch-test-${process.pid}`;
const evidence = join(root, '.omo/evidence', attempt);
const source = join(fixture, 'credentials');
const modules = join(fixture, 'node_modules');
const engine = join(modules, '@code-yeongyu/senpi/dist/bundle/cli.js');
const launcher = join(fixture, 'launcher.mjs');
const plugin = join(fixture, 'plugin');
mkdirSync(dirname(engine), { recursive: true });
mkdirSync(join(modules, 'omo-ai'), { recursive: true });
mkdirSync(source);
mkdirSync(plugin);
writeFileSync(engine, '');
writeFileSync(launcher, '');
writeFileSync(join(modules, '@code-yeongyu/senpi/package.json'), '{"version":"fixture"}');
writeFileSync(join(modules, 'omo-ai/package.json'), '{"version":"fixture"}');
writeFileSync(join(source, 'auth.json'), '{"ollama":{"type":"api_key","key":"synthetic-test-key"}}');
writeFileSync(join(source, 'credential-pool-state.json'), '{}');
Object.assign(process.env, {
  ORACLE_QA_LIVE_AGENT: source, ORACLE_QA_AUTH_GUARD: 'scoped',
  ORACLE_QA_ROUTE_POLICY: 'real-authorized',
  OMO_STABLE_SENPI_BUNDLE: engine, OMO_STABLE_REENTRY: launcher, OMO_STABLE_PLUGIN: plugin,
});
delete process.env.ORACLE_QA_GUARD_IPC;
const original = childProcess.spawn;
const hosts = [];
childProcess.spawn = function (command, args, options) {
  if (args.includes('--mode')) {
    hosts.push({ command, args, policy: options.env.ORACLE_QA_ROUTE_POLICY,
      admission: options.env.ORACLE_QA_ROUTE_ADMISSION });
    throw Object.assign(new Error('Observed host spawn boundary; no host executed'), { code: 'host_spawn_observed' });
  }
  return original.call(this, command, args, options);
};
syncBuiltinESMExports();
try {
  const { runAcceptanceCase } = await import('../../qa/cases/acceptance.mjs');
  const name = process.argv[2];
  await runAcceptanceCase({ case: name, attempt, main: 'real', oracle: 'real' });
  const receipt = JSON.parse(readFileSync(join(evidence, 'task-13-piomo-oracle-advisor-mod', `${name}-real.json`), 'utf8'));
  console.log(JSON.stringify({ hosts, host_launch: receipt.variants[0].host_launch, fixture_setup: receipt.fixture_setup,
    real_provider_calls: receipt.real_provider_calls, real_oracle_runs: receipt.real_oracle_runs,
    cleanup: receipt.cleanup }));
  process.exitCode = 0;
} finally {
  childProcess.spawn = original;
  syncBuiltinESMExports();
  rmSync(fixture, { recursive: true, force: true });
  rmSync(evidence, { recursive: true, force: true });
}
