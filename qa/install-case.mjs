import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileHashes } from '../scripts/build.mjs';
import {
  ROOT, OwnedProcess, authHashes, cleanupDisposableState, discoverHost,
  disposableEnvironment, hostArgs, readJson, sourceHash, typedError, writeJson,
} from './harness.mjs';
import { startMockProvider } from './mock-provider.mjs';

function filesIn(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesIn(join(directory, entry.name), name) : [name];
  }).sort();
}
const snapshot = directory => fileHashes(directory, filesIn(directory));

export async function runInstallCase(values) {
  if (!/^[A-Za-z0-9_-]+$/.test(values.attempt)) throw typedError('invalid_attempt');
  if (values.main !== 'mock' || values.oracle !== 'mock') {
    throw typedError('mock_required', 'Installer QA requires --main mock --oracle mock.');
  }
  const evidenceDir = join(ROOT, '.omo/evidence', values.attempt, 'task-12-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const receipt = {
    case: values.case, status: 'running', exit_code: 1, source_hash: sourceHash(),
    started_at: new Date().toISOString(), run_dir: runDir,
    main_mode: 'mock', oracle_mode: 'mock', real_provider_calls: 0,
    loading_mechanism: 'cli-extension-flag', children: [], cleanup: {},
  };
  let sandbox, owned, mock;
  async function stopHost(phase) {
    if (!owned) return;
    try { await owned.stop({ force: true }); }
    catch (error) {
      (receipt.cleanup.process_errors ??= []).push({
        phase, code: error.code ?? 'cleanup_failed', message: error.message,
      });
    }
  }
  async function installer(name, args = [], expected = 0) {
    const child = new OwnedProcess(process.execPath, [
      join(ROOT, 'scripts/install.mjs'), '--agent-dir', sandbox.agentDir, ...args,
    ], { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'raw', name) });
    receipt.children.push(child.metadata);
    child.child.stdin.end();
    await child.exit;
    await child.stop();
    assert.equal(child.metadata.exit_code, expected, `${name}: ${child.stderr}`);
    return JSON.parse(expected === 0 ? child.stdout : child.stderr);
  }
  try {
    const host = discoverHost();
    receipt.installed_versions = host.versions;
    receipt.auth_before = authHashes();
    mock = await startMockProvider();
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_MOCK_URL: mock.baseUrl, OMO_ORACLE_ADVISOR: '1',
      OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
    });
    const belowTemp = relative(resolve(tmpdir()), resolve(sandbox.stateDir));
    assert.ok(belowTemp && belowTemp !== '..' && !belowTemp.startsWith(`..${sep}`));
    receipt.temp_dir = sandbox.stateDir;
    receipt.agent_dir = sandbox.agentDir;
    receipt.config_path = join(sandbox.home, '.omo/omo.jsonc');
    writeJson(receipt.config_path, {
      // Observed installed-host migration, not an installer-owned delta. Start
      // at its current config level so host startup does not alter the baseline.
      _migrations: ['2026-08-reasoning-unification'],
      '[native]': { agents: { oracle: { model: 'oracle-qa-mock/oracle' } } },
      profiles: { fixture: { '[native]': { agents: { oracle: { model: 'oracle-qa-mock/oracle' } } } } },
    });
    mkdirSync(join(sandbox.agentDir, 'extensions'), { recursive: true });
    writeJson(join(sandbox.agentDir, 'unrelated.json'), { preserve: true });
    const shimPath = join(sandbox.agentDir, 'extensions/omo-oracle-advisor.js');
    if (values.case === 'install-foreign-shim') {
      writeJson(shimPath, { foreign_owner: true });
      const before = snapshot(sandbox.stateDir);
      receipt.refusal = await installer('foreign-install', [], 1);
      assert.equal(receipt.refusal.code, 'foreign_shim');
      receipt.before_sha256 = before;
      receipt.after_sha256 = snapshot(sandbox.stateDir);
      assert.deepEqual(receipt.after_sha256, before);
      receipt.proofs = { refused_foreign_shim: true, entire_disposable_tree_unchanged: true };
    } else {
      const before = snapshot(sandbox.stateDir);
      receipt.before_sha256 = before;
      receipt.config_before = readFileSync(receipt.config_path, 'utf8');
      receipt.dry_run = await installer('dry-run', ['--dry-run']);
      assert.deepEqual(snapshot(sandbox.stateDir), before);
      receipt.install = await installer('install');
      assert.equal(receipt.install.status, 'installed');
      assert.equal(receipt.install.policy.status, 'applied');
      assert.equal(receipt.install.policy.config_path, resolve(receipt.config_path));
      const current = readJson(join(sandbox.agentDir, 'oracle-advisor/current.json'));
      receipt.config_installed = readFileSync(receipt.config_path, 'utf8');
      receipt.packaged_files = fileHashes(receipt.install.generation_path);
      assert.deepEqual(receipt.packaged_files, current.sha256);
      assert.ok(receipt.packaged_files['scripts/oracle-policy.mjs']);
      assert.ok(receipt.packaged_files['prompts/oracle-advisor.md']);
      const configFile = relative(sandbox.stateDir, receipt.config_path).replaceAll('\\', '/');
      const settingsFile = relative(sandbox.stateDir, join(sandbox.agentDir, 'settings.json')).replaceAll('\\', '/');
      assert.notEqual(snapshot(sandbox.stateDir)[configFile], before[configFile]);
      assert.equal(snapshot(sandbox.stateDir)[settingsFile], before[settingsFile]);
      owned = new OwnedProcess(process.execPath,
        hostArgs(host, sandbox, shimPath, { main: 'mock' }),
        { cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'raw/host') });
      receipt.children.push(owned.metadata);
      await owned.rpc('get_state');
      receipt.loaded_surfaces = await owned.rpc('get_loaded_surfaces');
      assert.ok(receipt.loaded_surfaces.extensions.some(item =>
        resolve(item.path).toLowerCase() === resolve(shimPath).toLowerCase()));
      const status = owned.waitFor(event => event.type === 'message_end' &&
        event.message?.customType === 'oracle-advisor-status' &&
        event.message.details?.status === 'status', '/oracle status from installed generation',
      { from: owned.history.length });
      await owned.rpc('prompt', { message: '/oracle status' });
      receipt.oracle_status = (await status).message;
      assert.equal(receipt.oracle_status.details.job, null);
      assert.match(receipt.oracle_status.content, /oracle: no job/);
      await stopHost('before_uninstall');
      receipt.config_after_host = readFileSync(receipt.config_path, 'utf8');
      receipt.uninstall = await installer('uninstall', ['--uninstall']);
      receipt.config_restored = readFileSync(receipt.config_path, 'utf8');
      assert.equal(receipt.uninstall.policy.status, 'restored');
      assert.equal(existsSync(shimPath), false);
      const after = snapshot(sandbox.stateDir);
      receipt.restored_sha256 = Object.fromEntries(Object.keys(before).map(file => [file, after[file] ?? null]));
      assert.deepEqual(receipt.restored_sha256, before);
      receipt.retained_created_files = Object.keys(after).filter(file => !Object.hasOwn(before, file));
      assert.ok(existsSync(receipt.install.generation_path));
      receipt.proofs = {
        dry_run_changed_nothing: true, extension_loaded_from_generated_shim: true,
        oracle_status_ran: true, shim_removed: true, every_preexisting_file_hash_restored: true,
        policy_delta_restored: true, generations_retained: true, settings_untouched: true,
      };
    }
    assert.equal(mock.requests.length, 0, 'Host load and command must not call any model.');
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code ?? 'failed';
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message };
  } finally {
    try {
      await stopHost('finalizer');
      if (mock) {
        receipt.mock_provider_calls = mock.requests;
        await mock.close();
        receipt.cleanup.mock_listener_closed = true;
      }
      receipt.cleanup.all_owned_pids_gone = receipt.children.every(child => child.pid_gone);
      assert.equal(receipt.cleanup.all_owned_pids_gone, true);
      if (sandbox) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
      receipt.auth_after = authHashes();
      receipt.auth_unchanged = JSON.stringify(receipt.auth_before) === JSON.stringify(receipt.auth_after);
      receipt.cleanup.write_scope = {
        installer_and_host_state: sandbox?.stateDir ?? null,
        installer_and_host_state_under_os_temp: !!sandbox,
        retained_evidence_only: runDir,
        config_target: receipt.config_path ?? null,
        live_installation_written: false,
      };
    } catch (error) {
      receipt.exit_code = 1;
      receipt.status = 'cleanup_failed';
      receipt.cleanup.error = error.message;
    }
    if (receipt.cleanup.process_errors?.length) {
      receipt.exit_code = 1;
      receipt.status = 'cleanup_failed';
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    const receiptPath = join(evidenceDir, `${values.case}.json`);
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
}
