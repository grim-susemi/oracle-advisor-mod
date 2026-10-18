import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, writeJson } from './harness.mjs';
import { bindFixtureEnvironment } from './host-environment.mjs';
import { assertNodeLaunch, nodeSpawnEnvironment } from './node-spawn.mjs';

const { values } = parseArgs({ options: {
  attempt: { type: 'string', default: 'task19-mocks' }, cases: { type: 'string' },
} });
if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
const allCases = [
  'stop-real', 'stop-forged', 'nudge-real', 'nudge-inactive', 'seed-bind', 'seed-invalid',
  'acceptance', 'acceptance-oracle-down',
  'oracle-readonly', 'oracle-write-attempt', 'oracle-consumer-visual',
  'policy-uninstall-after-unrelated-edit', 'oracle-project-override-write', 'oracle-profile-switch',
  'lifecycle', 'lifecycle-killswitch', 'trigger-real', 'trigger-success-between', 'trigger-real-powershell',
  'resident-3', 'resident-dead', 'resident-stuck', 'shutdown-inflight', 'consult-cache-budget',
  'cancel-after-promotion', 'answered-error-words', 'lifecycle-retirement',
  'consult-real', 'consult-cap', 'consult-not-readonly', 'consult-no-job',
  'consult-policy-change', 'consult-cancel-save', 'consult-seed-rebind', 'consult-checkpoint-matrix',
  'consult-branch-switch-reserved', 'consult-reload-reserved', 'consult-cancel-reserved',
  'consult-admission-replay', 'consult-native-rejection',
];
const cases = values.cases ? values.cases.split(',') : allCases;
if (!cases.length || new Set(cases).size !== cases.length || cases.some(name => !allCases.includes(name))) {
  throw new Error('Cases must be unique names from the verdict mock matrix');
}
const directory = join(ROOT, '.omo/evidence', values.attempt, 'task-19-piomo-oracle-advisor-mod');
mkdirSync(directory, { recursive: true });
const results = [];
const environment = { ...bindFixtureEnvironment(process.env), ORACLE_QA_ROUTE_POLICY: 'mock-only' };
let next = 0;
async function worker() {
  while (next < cases.length) {
    const name = cases[next++];
    const attempt = `${values.attempt}-${name}`;
    const argv = name === 'lifecycle-retirement'
      ? ['qa/lifecycle-retirement-case.mjs', '--attempt', attempt]
      : ['qa/run.mjs', '--case', name, '--attempt', attempt, '--main', 'mock', '--oracle', 'mock'];
    const env = nodeSpawnEnvironment(environment);
    const node_guard = assertNodeLaunch(process.execPath, argv, env);
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exit_code, signal) => resolve({ exit_code, signal }));
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const outcome = await completion;
    const stdout_path = join(directory, `${name}.stdout.log`);
    const stderr_path = join(directory, `${name}.stderr.log`);
    writeFileSync(stdout_path, stdout);
    writeFileSync(stderr_path, stderr);
    const messages = stdout.trim().split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const summary = messages.findLast(message => message.receipt) ?? messages.at(-1) ?? {};
    const result = { case: name, argv: [process.execPath, ...argv], pid: child.pid, node_guard,
      ...outcome, ...summary, stdout_path, stderr_path };
    results.push(result);
    console.log(`${outcome.exit_code === 0 ? 'PASS' : 'FAIL'} ${name} ${summary.error?.message ?? summary.error ?? ''}`);
  }
}
await Promise.all(Array.from({ length: 2 }, worker));
const summary = { cases: cases.length, passed: results.filter(result => result.exit_code === 0).length,
  failed: results.filter(result => result.exit_code !== 0).length, real_model_calls: 0, results };
writeJson(join(directory, 'mock-matrix.json'), summary);
console.log(JSON.stringify({ cases: summary.cases, passed: summary.passed, failed: summary.failed,
  receipt: join(directory, 'mock-matrix.json') }));
process.exitCode = summary.failed ? 1 : 0;
