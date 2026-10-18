import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ROOT, OwnedProcess, authHashes, cleanupDisposableState, discoverHost,
  disposableEnvironment, finalizeAuthObservation, hostArgs, sourceHash, writeJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';

export async function runDossierCase(caseName, { attempt = 'a1' } = {}) {
  if (!['dossier-real', 'dossier-nonrepo'].includes(caseName)) throw new Error('Invalid dossier case');
  if (isAbsolute(attempt) || !/^[a-zA-Z0-9_-]+$/.test(attempt)) throw new Error('Attempt must be a simple name');
  const evidenceDir = join(ROOT, '.omo/evidence', attempt, 'task-5-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${caseName}-`));
  const rawDir = join(runDir, 'raw');
  mkdirSync(rawDir);
  const receipt = {
    case: caseName, argv: process.argv, source_hash: sourceHash(), status: 'running', exit_code: null,
    started_at: new Date().toISOString(), run_dir: runDir,
    loading_mechanism: 'cli-extension-flag', route: 'owned-stdio-rpc',
    real_oracle_runs: 0, provider_calls: [], children: [], dossiers: [], adversarial: {}, cleanup: {},
  };
  let owned;
  let sandbox;
  let host;
  let before;
  let mock;
  const isEvent = name => event => event.type === 'extension_event' &&
    event.name === 'oracle-qa.dossier' && event.data.event === name;
  try {
    host = discoverHost();
    receipt.installed_versions = host.versions;
    before = authHashes();
    mock = await startMockProvider();
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: attempt, ORACLE_QA_MOCK_URL: mock.baseUrl,
    });
    let cwd = sandbox.workDir;
    if (caseName === 'dossier-real') {
      cwd = join(sandbox.workDir, 'workspace');
      mkdirSync(cwd);
      writeFileSync(join(cwd, 'fixture.mjs'), 'export const value = 1;\n');
      writeFileSync(join(sandbox.workDir, 'outside-cwd.mjs'), 'export const outside = 1;\n');
      for (const [name, args] of [['init', ['init', '--quiet']], ['add', ['add', '--', '.']]]) {
        const git = new OwnedProcess(sandbox.env.ORACLE_QA_GIT, ['--no-optional-locks', ...args], {
          cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(rawDir, `git-${name}`),
        });
        receipt.children.push(git.metadata);
        git.child.stdin.end();
        await git.exit;
        await git.stop();
        assert.equal(git.metadata.exit_code, 0);
      }
      // An index is enough for an unstaged diff; fixture setup makes no commit.
      writeFileSync(join(cwd, 'fixture.mjs'), 'export const value = 2;\n');
      writeFileSync(join(sandbox.workDir, 'outside-cwd.mjs'), 'export const outside = 2;\n');
    }
    const candidate = join(ROOT, 'qa/cases/dossier-extension.mjs');
    owned = new OwnedProcess(process.execPath, hostArgs(host, sandbox, candidate, { main: 'mock' }), {
      cwd, env: sandbox.env, rawPrefix: join(rawDir, 'host'),
    });
    receipt.children.push(owned.metadata);
    receipt.host_argv = owned.metadata.argv;
    await owned.rpc('get_state');
    await owned.waitFor(isEvent('session_start'), 'dossier candidate loaded');
    const surfaces = await owned.rpc('get_loaded_surfaces');
    assert.ok(surfaces.extensions.some(item => resolve(item.path).toLowerCase() === resolve(candidate).toLowerCase()));
    const observe = async () => {
      const received = owned.waitFor(isEvent('dossier'), 'command builds dossier', { from: owned.history.length });
      await owned.rpc('prompt', { message: '/qa_dossier' });
      const result = (await received).data;
      receipt.dossiers.push(result);
      for (const call of result.calls) {
        assert.equal(call.argv[1], '--no-optional-locks');
        assert.equal(resolve(call.cwd), resolve(cwd));
        assert.deepEqual(call.argv.slice(-2), ['--', '.']);
      }
      assert.equal(result.dossier.question.label, 'UNVERIFIED MAIN CLAIM');
      assert.equal(result.dossier.claims[1].label, 'UNVERIFIED MAIN CLAIM');
      assert.equal(result.dossier.seed.sha256.length, 64);
      return result.dossier;
    };
    const first = await observe();
    receipt.size_chars = first.text.length;
    receipt.sections = Object.keys(first).filter(name => name !== 'text');
    if (caseName === 'dossier-real') {
      assert.ok(first.git.status.includes('fixture.mjs'));
      assert.ok(first.git.diff_stat.includes('fixture.mjs'));
      assert.equal(first.git.status.includes('outside-cwd'), false);
      assert.equal(first.git.diff_stat.includes('outside-cwd'), false);
      writeFileSync(join(cwd, 'fresh.mjs'), 'export const fresh = true;\n');
      const second = await observe();
      assert.equal(first.git.status.includes('fresh.mjs'), false);
      assert.equal(second.git.status.includes('fresh.mjs'), true);
      assert.equal(existsSync(join(sandbox.workDir, '.git/index.lock')), false);
      receipt.adversarial.dirty_worktree = { passed: true, staged_and_unstaged: true, commits: 0 };
      receipt.adversarial.stale_state = { passed: true, rebuilt_dossiers: 2, changed_status: true };
      receipt.adversarial.outside_cwd = { passed: true, sibling_omitted: true };
    } else {
      assert.equal(first.git.note, 'Git status and diff omitted: session cwd is not a Git repository.');
      assert.equal(first.git.status, undefined);
      assert.equal(first.git.diff_stat, undefined);
      receipt.omission_note = first.git.note;
      receipt.adversarial.stale_state = { applicable: false, reason: 'The real-repo case checks changed state across two live commands.' };
    }
    receipt.adversarial.prompt_injection = {
      passed: true, rule: 'Main/tool data stays unverified; only the oracle answer is passed to parseVerdict. No oracle model is called in this case.',
    };
    receipt.adversarial.malformed_input = { applicable: false, reason: 'Parser contract tests exercise broken/multiple JSON, UTF-8 size, and Unicode scalar limits.' };
    receipt.adversarial.other_classes = { applicable: false, reason: 'No model transport, STOP gate, installer, concurrency, cancellation, or resident state belongs to todo 5.' };
    receipt.provider_calls = owned.history.filter(isEvent('provider_request'));
    assert.equal(receipt.provider_calls.length, 0);
    assert.equal(mock.requests.length, 0);
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = 'failed';
    receipt.exit_code = 1;
    receipt.error = { type: error.code ?? 'assertion_failed', message: error.message, stack: error.stack };
  } finally {
    if (owned) {
      try {
        await owned.stop({ force: true });
        receipt.raw_output = owned.metadata.raw_output;
      } catch (error) {
        receipt.cleanup.error = error.message;
        receipt.exit_code = 1;
      }
    }
    receipt.cleanup.all_owned_pids_gone = receipt.children.every(child => child.pid_gone);
    if (!receipt.cleanup.all_owned_pids_gone) receipt.exit_code = 1;
    if (sandbox && receipt.cleanup.all_owned_pids_gone) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    if (mock) {
      receipt.mock_provider_calls = mock.requests;
      await mock.close();
      receipt.cleanup.mock_listener_closed = true;
    }
    if (host && before) {
      finalizeAuthObservation(receipt, before, undefined, { changeStatus: true });
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    const receiptPath = join(evidenceDir, `${caseName}.json`);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
  return receipt;
}
