import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import { disposableEnvironment, hostArgs } from '../qa/harness.mjs';

test('default acceptance is admitted mock-only and reserves a new attempt', t => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-default-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = join(root, '.omo/evidence');
  mkdirSync(join(evidence, 'a1'), { recursive: true });
  const latch = join(evidence, 'a1/real-model-safety.json');
  writeFileSync(latch, '{"latched":true}\n');
  const source = readFileSync(new URL('../qa/run.mjs', import.meta.url), 'utf8');
  const defaults = source.slice(source.indexOf('const { values } = parseArgs('),
    source.indexOf("if (['acceptance'"));
  const evaluate = () => runInNewContext(`${defaults}\nvalues`, {
    parseArgs: options => parseArgs({ ...options, args: ['--case', 'acceptance'] }),
    ROOT: root, basename, join, resolve, mkdirSync, mkdtempSync,
  });
  const first = evaluate();
  const second = evaluate();
  assert.equal(first.main, 'mock');
  assert.equal(first.oracle, 'mock');
  assert.notEqual(first.attempt, 'a1');
  assert.notEqual(first.attempt, second.attempt);
  for (const values of [first, second]) {
    assert.equal(existsSync(resolve(evidence, values.attempt)), true);
  }
  assert.equal(readFileSync(latch, 'utf8'), '{"latched":true}\n');
  const argv = process.argv;
  process.argv = [process.execPath, 'qa/run.mjs', '--case', 'acceptance'];
  t.after(() => { process.argv = argv; });
  const sandbox = disposableEnvironment({}, root, {
    ORACLE_QA_MOCK_URL: 'http://127.0.0.1:12345/v1', ORACLE_QA_REAL_ORACLE: '0',
  });
  t.after(() => rmSync(sandbox.stateDir, { recursive: true, force: true }));
  hostArgs({ engine: join(root, 'never-start.mjs'), plugin: join(root, 'plugin') },
    sandbox, join(root, 'candidate.mjs'), { main: first.main });
  assert.equal(sandbox.env.ORACLE_QA_ROUTE_ADMISSION, 'mock-only-v1');
});
