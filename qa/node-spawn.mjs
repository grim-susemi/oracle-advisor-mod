import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const executableRecords = new Map();
const hostPrograms = new Map();

function refuse(reason) {
  throw Object.assign(new Error(`Unsafe QA route: ${reason}`), { code: 'unsafe_qa_route' });
}

const environmentKeys = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'ALLUSERSPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'CI', 'DO_NOT_TRACK', 'OCX_PROFILE', 'OPENCODE_CONFIG_DIR',
]);
const environmentPrefixes = ['ORACLE_QA_', 'OMO_', 'SENPI_', 'PI_', 'XDG_', 'LC_', 'GIT_'];

export function allowedNodeEnvironmentKey(key) {
  const name = key.toUpperCase();
  return environmentKeys.has(name) || environmentPrefixes.some(prefix => name.startsWith(prefix));
}

export function nodeSpawnEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowedNodeEnvironmentKey(key)));
}

function identity(path, cwd = process.cwd()) {
  let absolute = resolve(cwd, path);
  try { absolute = realpathSync(absolute); } catch { /* Spawn reports nonexistent executables. */ }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function resolveOwnedExecutable(executable, environment = {}, cwd = process.cwd()) {
  if (isAbsolute(executable) || /[\\/]/.test(executable)) return resolve(cwd, executable);
  const search = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories = search.split(delimiter).filter(isAbsolute);
  if (process.platform === 'win32') directories.push(dirname(process.execPath),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'));
  for (const directory of directories) {
    for (const suffix of process.platform === 'win32' ? ['', '.exe'] : ['']) {
      const candidate = join(directory, executable + suffix);
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    }
  }
  refuse('owned executable could not be resolved');
}

export function registerValidatedExecutable(kind, record) {
  const version = kind === 'node' ? /^v\d+\.\d+\.\d+(?:[-+.\w]*)$/
    : kind === 'git' ? /^git version \d+\.\d+/ : kind === 'bash' ? /^GNU bash, version \d+\./ : /^\d+\.\d+/;
  if (!['node', 'git', 'bash', 'powershell'].includes(kind) ||
      !record?.validated || record.exit_code !== 0 || !isAbsolute(record.path) ||
      record.path !== realpathSync(record.path) || !version.test(record.version) ||
      (kind === 'node' && JSON.stringify(record.args) !== '["--version"]')) {
    refuse('executable has no validated version receipt');
  }
  const prior = executableRecords.get(identity(record.path));
  if (prior && prior.kind !== kind) refuse('executable kind changed after validation');
  executableRecords.set(identity(record.path), { ...record, kind });
}

export function validatedExecutable(executable) {
  return executableRecords.get(identity(executable));
}

function executableRecord(executable, environment, cwd, versionProbe) {
  const resolved = resolveOwnedExecutable(executable, environment, cwd);
  const binding = name => {
    const entries = Object.entries(environment).filter(([key]) => key.toUpperCase() === name);
    if (entries.length > 1) refuse('ambiguous executable binding casing');
    return entries[0]?.[1];
  };
  const manifest = binding('ORACLE_QA_EXECUTABLES');
  const inherited = manifest && JSON.parse(manifest);
  if (manifest) {
    const node = inherited?.node;
    const known = node?.path && validatedExecutable(node.path);
    if (!node?.validated || node.exit_code !== 0 || !isAbsolute(node.path) ||
        JSON.stringify(node.args) !== '["--version"]' ||
        (!(known?.kind === 'node' && known.version === node.version) &&
          !(versionProbe && identity(resolved) === identity(node.path)))) {
      refuse('Node manifest has no matching validated version receipt');
    }
  }
  const record = validatedExecutable(resolved);
  const boundNode = binding('ORACLE_QA_NODE');
  if (boundNode) {
    const bound = identity(boundNode, cwd);
    const expected = inherited?.node?.path ? identity(inherited.node.path) : bound;
    const validated = executableRecords.get(bound)?.kind === 'node';
    if (expected !== bound || (!validated && !(versionProbe && identity(resolved) === bound))) {
      refuse('Node binding disagrees with its validated executable record');
    }
  }
  if (record && inherited) {
    const advertised = inherited[record.kind];
    if (advertised && identity(advertised.path) === identity(record.path) &&
        (advertised.version !== record.version || !advertised.validated || advertised.exit_code !== 0)) {
      refuse('executable binding disagrees with its validated version receipt');
    }
  }
  if (!record && existsSync(resolved) && !versionProbe) refuse('unvalidated owned executable');
  return { resolved, record };
}

export function isNodeExecutable(executable, environment = {}, cwd = process.cwd()) {
  return executableRecord(executable, environment, cwd, false).record?.kind === 'node';
}

export function registerNodeHostPrograms(host) {
  for (const program of [host.engine, host.launcher].filter(Boolean)) hostPrograms.set(identity(program), host);
}

const operand = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-');
const pathOperand = value => operand(value) && isAbsolute(value);
const testFile = value => operand(value) && /(?:^|[\\/])[^\\/]+\.test\.mjs$/.test(value);
const slug = value => operand(value) && /^[A-Za-z0-9_-]+$/.test(value);
const mode = value => value === 'mock' || value === 'real';
const tools = value => typeof value === 'string' && /^[a-zA-Z_][\w]*(?:,[a-zA-Z_][\w]*)*$/.test(value);
const matches = (args, schema) => args.length === schema.length &&
  schema.every((expected, index) => typeof expected === 'function' ? expected(args[index]) : expected === args[index]);
const file = (value, relative, cwd) => operand(value) && identity(value, cwd) === identity(join(ROOT, relative));

function hostArguments(args, environment, cwd, host) {
  if (matches(args, [args[0], '--help']) || matches(args, [args[0], '--version'])) return true;
  if (identity(args[0], cwd) !== identity(host.engine)) return false;
  const builtins = args[10] === '--no-builtin-tools';
  const candidate = args[builtins ? 16 : 15];
  const caseFile = name => file(candidate, `qa/${name}`, cwd);
  const missingExtension = pathOperand(candidate) &&
    /^\.omo\/evidence\/[A-Za-z0-9_-]+\/task-1-piomo-oracle-advisor-mod\/host-missing-ext-[^/]+\/missing-extension\.mjs$/
      .test(relative(ROOT, candidate).replaceAll('\\', '/'));
  const builtinCases = ['cases/acceptance-extension.mjs', 'stop-extension.mjs', 'nudger-extension.mjs', 'triggers-probe-extension.mjs'];
  if (!builtins && !builtinCases.some(caseFile)) return false;
  const real = args[args.indexOf('--provider') + 1] === 'ollama';
  const base = [
    args[0], '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve',
    ...(builtins ? ['--no-builtin-tools'] : []),
    '--extension', value => pathOperand(value) && identity(value, cwd) === identity(host.plugin),
    '--extension', value => ['qa/mock-extension.mjs', 'qa/capability-models.mjs'].some(path => file(value, path, cwd)),
    '--extension', pathOperand,
    ...(real ? ['--extension', value => file(value, 'qa/main-provider.mjs', cwd)] : []),
    '--session-dir', pathOperand, '--session', pathOperand,
    '--provider', real ? 'ollama' : 'oracle-qa-mock', '--model', real ? 'deepseek-v4.1-flash' : 'main',
    '--thinking', 'off', '--omo-senpi-memory-disabled', '--omo-senpi-builtin-mcps-disabled',
    '--omo-senpi-config-watch-disabled', '--omo-senpi-model-profile-disabled',
    '--omo-senpi-ulw-loop-disabled', '--omo-senpi-telemetry-disabled',
  ];
  const tails = [];
  const providerTails = [[]];
  if (environment.ORACLE_QA_ROUTE_POLICY === 'real-authorized') {
    providerTails.push(['--extension', value => file(value, 'qa/main-provider.mjs', cwd)]);
    if (caseFile('oracle-policy-extension.mjs')) {
      providerTails.push(['--extension', value => file(value, 'qa/oracle-policy-models.mjs', cwd)]);
    }
  }
  if (caseFile('cases/acceptance-extension.mjs')) {
    for (const provider of providerTails) tails.push([
      '--extension', value => pathOperand(value) && environment.ORACLE_QA_INSTALLED_ENTRY &&
        identity(value, cwd) === identity(environment.ORACLE_QA_INSTALLED_ENTRY),
      ...provider, '--system-prompt', operand,
    ]);
  } else if (['nudger-extension.mjs', 'triggers-probe-extension.mjs'].some(caseFile)) {
    for (const provider of providerTails) tails.push([...provider, '--system-prompt', operand]);
  } else if (['probe-extension.mjs', 'cases/lifecycle-extension.mjs', 'cases/seed-extension.mjs',
    'consult-extension.mjs', 'lifecycle-retirement-extension.mjs', 'oracle-policy-extension.mjs',
    'stop-extension.mjs', 'transport-extension.mjs', 'capability-extension.mjs'].some(caseFile) || missingExtension) {
    for (const provider of providerTails) tails.push([...provider, '--tools', tools, '--system-prompt', operand]);
    if (caseFile('probe-extension.mjs')) tails.push([]);
  } else tails.push([]);
  return tails.some(tail => matches(args, [...base, ...tail]));
}

function scriptArguments(args, environment, cwd) {
  if (!operand(args[0])) return false;
  const host = hostPrograms.get(identity(args[0], cwd));
  if (host) return hostArguments(args, environment, cwd, host);
  const script = relative => file(args[0], relative, cwd);
  if (script('qa/owned-process-fixture.mjs')) {
    return matches(args, [args[0], value => ['ready', 'hang', 'misleading-success'].includes(value)]);
  }
  if (script('scripts/build.mjs') || script('test/helpers/auth-runtime-client.mjs')) return args.length === 1;
  if (script('scripts/install.mjs')) return matches(args, [args[0], '--agent-dir', pathOperand]) ||
    matches(args, [args[0], '--agent-dir', pathOperand, value => ['--dry-run', '--uninstall'].includes(value)]);
  if (script('qa/run.mjs')) return matches(args, [args[0], '--case', slug, '--attempt', slug, '--main', mode]) ||
    matches(args, [args[0], '--case', slug, '--attempt', slug, '--main', mode, '--oracle', mode]);
  if (script('qa/lifecycle-retirement-case.mjs')) return matches(args, [args[0], '--attempt', slug]);
  if (script('test/helpers/auth-runtime-runner.mjs')) {
    return matches(args, [args[0], value => ['metadata', 'environment', 'repro', 'bridge'].includes(value)]);
  }
  return false;
}

function nativeArguments(args, record) {
  if (record.kind === 'git') return [
    ['--version'], ['init', '--quiet'], ['--no-optional-locks', 'init', '--quiet'],
    ['--no-optional-locks', 'status', '--short'], ['--no-optional-locks', 'add', '--', '.'],
    ['--no-optional-locks', 'add', '--', 'fixture.mjs'],
    ['--no-optional-locks', 'add', '--', 'normalize.mjs', 'fixture.test.mjs'],
  ].some(schema => matches(args, schema));
  if (record.kind === 'bash') return matches(args, ['--version']);
  if (record.kind === 'powershell') return [
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  ].some(schema => matches(args, schema));
  if (record.system_program === 'cmd.exe') return matches(args, ['/d', '/c', 'exit', '0']);
  if (record.system_program === 'taskkill.exe') {
    return matches(args, ['/PID', value => /^[1-9]\d*$/.test(value), '/T', '/F']);
  }
  return false;
}

export function assertNodeLaunch(executable, args, environment, { nodeProfile = 'script', cwd = process.cwd() } = {}) {
  if (Object.keys(environment).some(key => key.toUpperCase().startsWith('NODE_') && !allowedNodeEnvironmentKey(key))) {
    refuse('unapproved Node environment carrier');
  }
  const versionProbe = nodeProfile === 'version' && matches(args, ['--version']);
  const { record } = executableRecord(executable, environment, cwd, versionProbe);
  if (record && record.kind !== 'node') {
    if (!nativeArguments(args, record)) refuse('complete native executable argv differs from its explicit profile');
    return null;
  }
  if (record?.kind !== 'node' && !versionProbe) return null;
  const checkPrefix = ['--test', '--test-isolation=none', '--test-reporter=./qa/verdict-test-reporter.mjs'];
  let prefix = [], admitted = false;
  if (nodeProfile === 'script') admitted = scriptArguments(args, environment, cwd);
  else if (nodeProfile === 'version') { prefix = ['--version']; admitted = versionProbe; }
  else if (nodeProfile === 'exit') {
    prefix = ['-e', args[1]];
    admitted = matches(args, ['-e', value => typeof value === 'string' && /^process\.exit\(\d+\)$/.test(value)]);
  } else if (nodeProfile === 'test') { prefix = ['--test']; admitted = matches(args, ['--test', testFile]); }
  else if (nodeProfile === 'check') {
    prefix = checkPrefix;
    const files = readdirSync(join(ROOT, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
    admitted = matches(args, [...checkPrefix, ...files]);
  } else if (nodeProfile === 'syntax') {
    prefix = ['--check'];
    admitted = matches(args, ['--check', value => pathOperand(value) && /\.m?js$/.test(value)]);
  } else if (nodeProfile === 'containment') {
    prefix = ['--test', '--test-isolation=none', '--test-name-pattern=^credential containment:'];
    admitted = matches(args, [...prefix, 'test/auth-guard.test.mjs']);
  }
  if (!admitted) refuse('complete Node argv differs from its explicit profile');
  return { profile: nodeProfile, approved_prefix: prefix, admitted_before_spawn: true,
    full_argv_validated: true, approved_argv: [...args], executable_validation: record ?? { kind: 'version-candidate' },
    default_configuration: 'no enabling option admitted; installed binaries measured separately' };
}

// Bootstrap exactly one terminal version probe of the already-running Node.
// No caller-controlled operand, inherited NODE_* key, or script can enter it.
executableRecords.set(identity(process.execPath), { kind: 'node', path: realpathSync(process.execPath) });
const bootstrapEnvironment = nodeSpawnEnvironment(process.env);
for (const key of Object.keys(bootstrapEnvironment)) {
  if (['ORACLE_QA_EXECUTABLES', 'ORACLE_QA_NODE'].includes(key.toUpperCase())) delete bootstrapEnvironment[key];
}
assertNodeLaunch(process.execPath, ['--version'], bootstrapEnvironment, { nodeProfile: 'version' });
const bootstrap = spawnSync(process.execPath, ['--version'], { env: bootstrapEnvironment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (bootstrap.status !== 0 || bootstrap.stdout.trim() !== process.version) refuse('running Node version validation failed');
registerValidatedExecutable('node', { path: realpathSync(process.execPath), args: ['--version'], version: bootstrap.stdout.trim(),
  validated: true, exit_code: bootstrap.status, pid: bootstrap.pid, pid_gone: true, source: 'running Node --version' });
if (process.platform === 'win32') for (const name of ['cmd.exe', 'taskkill.exe']) {
  const path = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
  if (existsSync(path)) executableRecords.set(identity(path), {
    kind: 'system', system_program: name, path: realpathSync(path), source: 'Windows System32',
  });
}
