import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { OwnedProcess, disposableEnvironment, hostArgs, writeJson } from '../qa/harness.mjs';
import { admitHostRoute, assertHostRoute } from '../qa/route-guard.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-route-guard-'));
  const sandbox = disposableEnvironment({}, directory, {
    ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1', ORACLE_QA_REAL_ORACLE: '0',
  });
  t.after(() => {
    rmSync(sandbox.stateDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const host = { engine: join(directory, 'never-start.mjs'), plugin: join(directory, 'plugin') };
  return { sandbox, host, candidate: join(directory, 'candidate.mjs') };
}

function invocation(t, args, policy) {
  const argv = process.argv;
  const previous = process.env.ORACLE_QA_ROUTE_POLICY;
  process.argv = [process.execPath, 'qa/run.mjs', ...args];
  if (policy === undefined) delete process.env.ORACLE_QA_ROUTE_POLICY;
  else process.env.ORACLE_QA_ROUTE_POLICY = policy;
  t.after(() => {
    process.argv = argv;
    if (previous === undefined) delete process.env.ORACLE_QA_ROUTE_POLICY;
    else process.env.ORACLE_QA_ROUTE_POLICY = previous;
  });
}

test('explicit real invocation with authorized parent admits before any host spawn', t => {
  invocation(t, ['--main', 'real', '--oracle', 'mock'], 'real-authorized');
  for (const [args, main, realOracle] of [
    [['--main', 'real', '--oracle', 'mock'], 'real', false],
    [['--main', 'mock', '--oracle', 'real'], 'mock', true],
    [['--main=real', '--oracle=mock'], 'real', false],
    [['--main=mock', '--oracle=real'], 'mock', true],
  ]) {
    process.argv = [process.execPath, 'qa/run.mjs', ...args];
    const { sandbox } = fixture(t);
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY, 'real-authorized');
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY_REASON, 'explicit-real-route-and-parent-authorization');
    admitHostRoute(sandbox.env, { main, realOracle });
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, 'real-authorized-v1');
  }
});

test('explicit real invocation without parent authorization refuses before spawn', t => {
  invocation(t, ['--main', 'real'], undefined);
  for (const policy of [undefined, 'mock-only', 'real-authorized-typo']) {
    if (policy === undefined) delete process.env.ORACLE_QA_ROUTE_POLICY;
    else process.env.ORACLE_QA_ROUTE_POLICY = policy;
    const { host, sandbox, candidate } = fixture(t);
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY, 'mock-only');
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY_REASON, 'parent-not-authorized');
    assert.throws(() => hostArgs(host, sandbox, candidate, { main: 'real' }), { code: 'unsafe_qa_route' });
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, undefined);
  }
});

test('mock invocation under authorized parent retains every mock route check', t => {
  invocation(t, ['--main', 'mock', '--oracle', 'mock'], 'real-authorized');
  const { host, sandbox, candidate } = fixture(t);
  const args = hostArgs(host, sandbox, candidate, { main: 'mock' });
  assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY, 'mock-only');
  assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, 'mock-only-v1');
  const receipt = assertHostRoute(args, sandbox.env, sandbox.workDir);
  assert.equal(receipt.policy, 'mock-only');
  assert.equal(receipt.policy_reason, 'no-explicit-real-route');
  assert.equal(receipt.admitted_before_spawn, true);
  args[args.indexOf('--provider') + 1] = 'ollama';
  assert.throws(() => assertHostRoute(args, sandbox.env, sandbox.workDir), { code: 'unsafe_qa_route' });
  assert.throws(() => hostArgs(host, sandbox, candidate, { main: 'mock', realOracle: true }),
    { code: 'unsafe_qa_route' });
});

for (const runner of ['qa/install-case.mjs', 'qa/run-verdict-mocks.mjs']) {
  test(`${runner} stays mock-only under authorized parent without explicit real flags`, t => {
    invocation(t, [], 'real-authorized');
    process.argv[1] = runner;
    const { host, sandbox, candidate } = fixture(t);
    const args = hostArgs(host, sandbox, candidate, { main: 'mock' });
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_POLICY, 'mock-only');
    assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, 'mock-only-v1');
    assert.equal(assertHostRoute(args, sandbox.env, sandbox.workDir).policy_reason, 'no-explicit-real-route');
    assert.throws(() => hostArgs(host, sandbox, candidate, { main: 'real' }), { code: 'unsafe_qa_route' });
  });
}

test('diagnostic hostArgs cannot silently select a real main route', t => {
  const { host, sandbox, candidate } = fixture(t);
  assert.throws(() => hostArgs(host, sandbox, candidate), { code: 'unsafe_qa_route' });
});

test('mock host rejects real main, real oracle and non-loopback fixture provider before spawn', t => {
  for (const change of ['main', 'oracle', 'url']) {
    const { host, sandbox, candidate } = fixture(t);
    if (change === 'oracle') sandbox.env.ORACLE_QA_REAL_ORACLE = '1';
    if (change === 'url') sandbox.env.ORACLE_QA_MOCK_URL = 'https://example.com/v1';
    assert.throws(() => hostArgs(host, sandbox, candidate, {
      main: change === 'main' ? 'real' : 'mock',
    }), { code: 'unsafe_qa_route' });
  }
});

test('spawn boundary rejects a route changed after hostArgs and a real oracle configuration', t => {
  const { host, sandbox, candidate } = fixture(t);
  const args = hostArgs(host, sandbox, candidate, { main: 'mock' });
  assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, 'mock-only-v1');
  const provider = args.indexOf('--provider') + 1;
  args[provider] = 'ollama';
  assert.throws(() => new OwnedProcess(process.execPath, args, {
    cwd: sandbox.workDir, env: sandbox.env,
  }), { code: 'unsafe_qa_route' });
  args[provider] = 'oracle-qa-mock';
  writeJson(join(sandbox.home, '.omo/omo.jsonc'), {
    '[native]': { agents: { oracle: { model: 'ollama/deepseek-v4.1-flash' } } },
  });
  assert.throws(() => new OwnedProcess(process.execPath, args, {
    cwd: sandbox.workDir, env: sandbox.env,
  }), { code: 'unsafe_qa_route' });
});

test('spawn boundary rejects unadmitted diagnostics and appended routing overrides', t => {
  const { host, sandbox, candidate } = fixture(t);
  const args = hostArgs(host, sandbox, candidate, { main: 'mock' });
  delete sandbox.env.ORACLE_QA_ROUTE_ADMISSION;
  assert.throws(() => new OwnedProcess(process.execPath, args, {
    cwd: sandbox.workDir, env: sandbox.env,
  }), { code: 'unsafe_qa_route' });
  sandbox.env.ORACLE_QA_ROUTE_ADMISSION = 'mock-only-v1';
  for (const suffix of [
    ['--provider', 'ollama'], ['--model', 'deepseek-v4.1-flash'],
    ['--extension', join('qa', 'main-provider.mjs')],
    ['--provider=ollama'], ['-m', 'deepseek-v4.1-flash'],
  ]) {
    assert.throws(() => new OwnedProcess(process.execPath, [...args, ...suffix], {
      cwd: sandbox.workDir, env: sandbox.env,
    }), { code: 'unsafe_qa_route' });
  }
});

test('native host identification cannot be bypassed by mode mutation or print diagnostics', t => {
  const { host, sandbox, candidate } = fixture(t);
  const args = hostArgs(host, sandbox, candidate, { main: 'mock' });
  const mode = args.indexOf('--mode');
  const changed = [...args];
  changed[mode + 1] = 'text';
  for (const unsafe of [
    changed,
    [args[0], '--mode', 'text', ...args.slice(1)],
    [args[0], '--mode', 'text', '--mode', 'rpc', '--provider', 'ollama'],
    [args[0], '--print', '--provider', 'ollama'],
    [args[0]],
  ]) {
    assert.throws(() => assertHostRoute(unsafe, sandbox.env, sandbox.workDir), { code: 'unsafe_qa_route' });
  }
  assert.throws(() => assertHostRoute(['--test', 'fixture.test.mjs'], sandbox.env, sandbox.workDir),
    { code: 'unsafe_qa_route' });
  assert.equal(assertHostRoute(['--test', 'fixture.test.mjs'], sandbox.env, sandbox.workDir,
    process.execPath, { nodeProfile: 'test' }), null);
  assert.throws(() => assertHostRoute(['init', '--quiet'], sandbox.env, sandbox.workDir), { code: 'unsafe_qa_route' });
  assert.equal(assertHostRoute(['init', '--quiet'], sandbox.env, sandbox.workDir, 'C:/fixture/git.exe'), null);
});

test('native host path identity handles Windows casing and child-relative launch paths', t => {
  const { host, sandbox, candidate } = fixture(t);
  hostArgs(host, sandbox, candidate, { main: 'mock' });
  const aliases = [relative(sandbox.workDir, host.engine)];
  if (process.platform === 'win32') aliases.push(host.engine.toUpperCase());
  for (const engine of aliases) {
    assert.throws(() => assertHostRoute([engine], sandbox.env, sandbox.workDir), { code: 'unsafe_qa_route' });
  }
});

test('structural host admission never skips engine paths behind Node options or indirect loaders', t => {
  const { host, sandbox, candidate } = fixture(t);
  hostArgs(host, sandbox, candidate, { main: 'mock' });
  const aliases = [host.engine, relative(sandbox.workDir, host.engine)];
  if (process.platform === 'win32') aliases.push(host.engine.toUpperCase());
  const prefixes = [
    [], ['--no-warnings'], ['--trace-warnings', '--no-warnings'],
    ['--import', 'fixture.mjs'], ['--require=fixture.mjs'], ['--loader', 'fixture.mjs'],
    ['-e', 'import("fixture.mjs")'], ['--eval=import("fixture.mjs")'], ['-p', '"fixture"'],
  ];
  const suffixes = [
    [], ['--mode', 'rpc', '--provider', 'ollama'],
    ['--provider', 'oracle-qa-mock', '--model', 'main', '--mode', 'rpc'],
    ['--mode', 'text', '--mode', 'rpc', '--print'],
  ];
  let evaluations = 0;
  for (const engine of aliases) for (const prefix of prefixes) for (const suffix of suffixes) {
    const args = [...prefix, engine, ...suffix];
    let result, rejected = false;
    try { result = assertHostRoute(args, sandbox.env, sandbox.workDir, process.execPath); }
    catch (error) { assert.equal(error.code, 'unsafe_qa_route'); rejected = true; }
    assert.ok(rejected || result?.policy === 'mock-only', JSON.stringify(args));
    if (prefix.length) assert.equal(rejected, true, JSON.stringify(args));
    evaluations++;
  }
  for (const args of [
    ['-e', `import(${JSON.stringify(host.engine)})`], [`--eval=import(${JSON.stringify(host.engine)})`],
    ['--import', 'fixture.mjs'], ['--require', 'fixture.cjs'], ['--loader=fixture.mjs'], ['-p', '"fixture"'],
  ]) {
    assert.throws(() => assertHostRoute(args, sandbox.env, sandbox.workDir, process.execPath),
      { code: 'unsafe_qa_route' });
    evaluations++;
  }
  let seed = 20261017;
  for (let i = 0; i < 128; i++) {
    const args = ['--no-warnings', '--mode', 'rpc', '--provider', 'oracle-qa-mock', '--model', 'main'];
    for (let j = args.length - 1; j > 0; j--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const next = seed % (j + 1);
      [args[j], args[next]] = [args[next], args[j]];
    }
    args.splice(i % (args.length + 1), 0, aliases[i % aliases.length]);
    let result;
    try { result = assertHostRoute(args, sandbox.env, sandbox.workDir, process.execPath); }
    catch (error) { assert.equal(error.code, 'unsafe_qa_route'); evaluations++; continue; }
    assert.notEqual(result, null, JSON.stringify(args));
    evaluations++;
  }
  assert.throws(() => assertHostRoute(['-e', `import(${JSON.stringify(host.engine)})`], {}, sandbox.workDir,
    process.execPath), { code: 'unsafe_qa_route' });
  assert.throws(() => assertHostRoute(['fixture.mjs'], { ...sandbox.env, NODE_OPTIONS: '--import=fixture.mjs' },
    sandbox.workDir, process.execPath), { code: 'unsafe_qa_route' });
  assert.throws(() => assertHostRoute(['-e', 'process.exit(1)'], sandbox.env, sandbox.workDir, process.execPath),
    { code: 'unsafe_qa_route' });
  assert.equal(assertHostRoute(['-e', 'process.exit(1)'], sandbox.env, sandbox.workDir, process.execPath,
    { nodeProfile: 'exit' }), null);
  assert.equal(assertHostRoute([host.engine, '--print'], sandbox.env, sandbox.workDir, 'C:/fixture/git.exe'), null);
  assert.equal(evaluations, aliases.length * prefixes.length * suffixes.length + 6 + 128);
});
