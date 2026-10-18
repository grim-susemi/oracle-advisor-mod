import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { effectiveOracleTools, parseJsonc } from '../scripts/oracle-policy.mjs';
import { assertNodeLaunch, registerNodeHostPrograms } from './node-spawn.mjs';

function refuse(reason) {
  throw Object.assign(new Error(`Unsafe QA route: ${reason}`), { code: 'unsafe_qa_route' });
}

const hostPrograms = new Set();
export function registerHostPrograms(host) {
  registerNodeHostPrograms(host);
  for (const path of [host.engine, host.launcher].filter(Boolean)) hostPrograms.add(resolve(path));
}

export function assertMockEndpoint(environment) {
  let url;
  try { url = new URL(environment.ORACLE_QA_MOCK_URL); } catch { refuse('missing local provider'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password) refuse('provider is not an owned loopback fixture');
}

export function admitHostRoute(environment, { main, realOracle }) {
  if (!['mock', 'real'].includes(main)) refuse('main mode must be explicit');
  if (environment.ORACLE_QA_ROUTE_POLICY !== 'real-authorized') {
    if (main !== 'mock' || realOracle || environment.ORACLE_QA_REAL_ORACLE === '1') {
      refuse('real main or oracle in a mock-only/diagnostic run');
    }
    assertMockEndpoint(environment);
    environment.ORACLE_QA_ROUTE_ADMISSION = 'mock-only-v1';
  } else {
    environment.ORACLE_QA_ROUTE_ADMISSION = 'real-authorized-v1';
  }
}

export function assertHostRoute(args, environment, cwd, executable = process.execPath, options = {}) {
  const nodeGuard = assertNodeLaunch(executable, args, environment, { ...options, cwd });
  const identity = path => {
    let absolute = resolve(cwd ?? process.cwd(), path);
    try { absolute = realpathSync(absolute); } catch { /* Missing fixture engines still have a stable lexical identity. */ }
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const hostPaths = [...hostPrograms, environment.ORACLE_QA_HOST_ENGINE, environment.ORACLE_QA_HOST_LAUNCHER]
    .filter(Boolean).map(identity);
  const launcher = hostPaths.includes(identity(executable));
  const node = Boolean(nodeGuard);
  if (!node && !launcher) return null;
  const scripts = args.flatMap((arg, index) => hostPaths.includes(identity(arg)) ? [index] : []);
  const hostLaunch = launcher || scripts.length > 0 ||
    args.some(arg => /^(?:--(?:mode|print|provider|model|models)(?:=|$)|-p$)/.test(arg));
  if (!hostLaunch) return null; // Ordinary Node/Git fixture commands do not drive a model.
  // The accepted Node-prefix allowlist is empty. Scan all arguments first, so
  // moving a script behind options cannot turn a host launch into a fixture.
  if (node && scripts.length && (scripts.length !== 1 || scripts[0] !== 0)) {
    refuse('Node options before the native host script are not admitted');
  }
  if (scripts.length === 1 && args.length === 2 && ['--help', '--version'].includes(args[1])) {
    return { policy: 'non-model-diagnostic', admitted_before_spawn: true };
  }
  if (args.filter(arg => arg === '--mode').length !== 1 ||
      args[args.indexOf('--mode') + 1] !== 'rpc' ||
      args.some(arg => arg === '--print' || arg === '-p' || arg.startsWith('--print='))) {
    refuse('native QA hosts require exactly one RPC mode and no print mode');
  }
  const admission = environment.ORACLE_QA_ROUTE_ADMISSION;
  if (admission === 'real-authorized-v1' && environment.ORACLE_QA_ROUTE_POLICY === 'real-authorized') {
    return { policy: 'real-authorized', policy_reason: environment.ORACLE_QA_ROUTE_POLICY_REASON,
      admitted_before_spawn: true };
  }
  if (admission !== 'mock-only-v1') refuse('host has no route admission');
  if (environment.ORACLE_QA_REAL_ORACLE === '1') refuse('real oracle flag changed after admission');
  assertMockEndpoint(environment);
  if (args.some(arg => /^--(?:provider|model|mode)=/.test(arg) || ['-m', '--models', '--api-key'].includes(arg) ||
      (arg.startsWith('--') && arg.includes('fallback')))) {
    refuse('alternate routing argument');
  }
  for (const [flag, expected] of [['--provider', 'oracle-qa-mock'], ['--model', 'main']]) {
    const indexes = args.flatMap((arg, i) => arg === flag ? [i] : []);
    if (indexes.length !== 1 || args[indexes[0] + 1] !== expected) refuse(`${flag} override`);
  }
  if (args.some(arg => /(?:^|[\\/])(?:main-provider|oracle-policy-models)\.mjs$/.test(arg))) {
    refuse('real provider extension in mock-only run');
  }
  const policy = effectiveOracleTools(cwd, { env: environment });
  if (policy.diagnostics.length) refuse('unreadable oracle configuration');
  const sources = [...new Set(policy.sources.filter(source => source.active).map(source => source.file))];
  const models = [];
  for (const file of sources) {
    const document = parseJsonc(readFileSync(file, 'utf8'));
    const profile = policy.active_profile && document.profiles?.[policy.active_profile];
    for (const container of [document, profile].filter(Boolean)) {
      for (const view of [container, container['[native]'] ?? container['[senpi]']].filter(Boolean)) {
        const oracle = view.agents?.oracle;
        if (!oracle) continue;
        if (oracle.model !== undefined) models.push(oracle.model);
        for (const key of ['model_fallback', 'fallback_models']) {
          if (oracle[key] !== undefined && JSON.stringify(oracle[key]) !== '[]') refuse('oracle fallback configured');
        }
      }
    }
  }
  if (!models.length || models.some(model => typeof model !== 'string' || !/^oracle-qa-mock\/[^/]+$/.test(model))) {
    refuse('oracle route is absent or not local');
  }
  // These are the only persistent model settings the disposable engine reads.
  const agent = environment.SENPI_CODING_AGENT_DIR ?? environment.OMO_CODING_AGENT_DIR;
  const settings = agent && join(agent, 'settings.json');
  if (settings && existsSync(settings)) {
    const value = JSON.parse(readFileSync(settings, 'utf8'));
    if (value.retry?.modelFallback !== false || value.retry?.enabled !== false) refuse('engine fallback enabled');
  }
  return { policy: 'mock-only', policy_reason: environment.ORACLE_QA_ROUTE_POLICY_REASON,
    admitted_before_spawn: true, provider: 'oracle-qa-mock',
    model: 'main', oracle_models: models, configuration_sources: sources };
}
