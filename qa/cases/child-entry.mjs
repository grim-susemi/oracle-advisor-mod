import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, OwnedProcess, cleanupDisposableState, discoverHost, disposableEnvironment,
  hostArgs, sourceHash, writeJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';

export async function runChildEntry(values) {
  if (!/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  const evidenceDir = join(ROOT, '.omo/evidence', values.attempt, 'task-3-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, 'child-entry-'));
  const receipt = {
    case: 'child-entry', status: 'running', exit_code: null,
    source_hash: sourceHash(), oracle_runs: 0, provider_calls: 0,
    started_at: new Date().toISOString(), cleanup: {}, variants: [],
  };
  let mock;
  try {
    const host = discoverHost();
    receipt.installed_versions = host.versions;
    mock = await startMockProvider();
    const variants = ['canonical', ...(process.platform === 'win32' ? ['uppercase-alias'] : [])];
    if (process.platform !== 'win32') {
      receipt.alias_not_applicable = 'Case aliases are a Windows-specific contract; other platforms retain case-sensitive matching.';
    }
    for (const name of variants) {
      const proof = { name, cleanup: {} };
      receipt.variants.push(proof);
      const variantDir = join(runDir, name);
      mkdirSync(variantDir);
      const sandbox = disposableEnvironment(host, variantDir, {
        ORACLE_QA_MOCK_URL: mock.baseUrl, ORACLE_QA_ATTEMPT: values.attempt,
        OMO_ORACLE_ADVISOR: '1',
      });
      let owned;
      try {
        const physicalDirectory = join(variantDir, 'senpi-task/children/owned/sessions');
        mkdirSync(physicalDirectory, { recursive: true });
        sandbox.sessionDir = name === 'uppercase-alias'
          ? join(variantDir, 'SENPI-TASK/CHILDREN/owned/sessions') : physicalDirectory;
        for (const brand of ['PI', 'SENPI', 'OMO']) {
          sandbox.env[`${brand}_CODING_AGENT_SESSION_DIR`] = sandbox.sessionDir;
        }
        const args = hostArgs(host, sandbox, join(ROOT, 'qa/cases/child-entry-extension.mjs'), { main: 'mock' });
        owned = new OwnedProcess(process.execPath, args, {
          cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(variantDir, 'raw/host'),
        });
        proof.process = owned.metadata;
        await owned.rpc('get_state');
        const isObservation = event => record => record.type === 'extension_event' &&
          record.name === 'oracle-qa.child-entry' && record.data.event === event;
        const event = await owned.waitFor(isObservation('session_start'), 'child load observation');
        proof.observation = event.data;
        const { factory, registrations, actual_session_file } = event.data;
        assert.match(actual_session_file, /[/\\]senpi-task[/\\]children[/\\]/i);
        assert.equal(factory.session_kind, 'interactive');
        assert.equal(event.data.session_status, 'child');
        assert.ok(registrations.commands.includes('oracle'));
        assert.deepEqual(event.data.ledger_entries, []);
        if (name === 'uppercase-alias') {
          const physicalFile = join(physicalDirectory, 'owned.jsonl');
          proof.alias_identity = {
            physical_file: physicalFile, opened_file: actual_session_file,
            physical_inode: statSync(physicalFile, { bigint: true }).ino.toString(),
            opened_inode: statSync(actual_session_file, { bigint: true }).ino.toString(),
            physical_realpath: realpathSync.native(physicalFile),
            opened_realpath: realpathSync.native(actual_session_file),
          };
          assert.equal(proof.alias_identity.physical_inode, proof.alias_identity.opened_inode);
          assert.equal(proof.alias_identity.physical_realpath, proof.alias_identity.opened_realpath);
        }
        const from = owned.history.length;
        const refusal = owned.waitFor(record => record.type === 'extension_ui_request' &&
          record.method === 'notify' && record.message === 'not available in task child sessions',
          'child command refusal text', { from });
        const attempted = owned.waitFor(isObservation('command'), 'child oracle on attempted', { from });
        await owned.rpc('prompt', { message: '/oracle on' });
        const after = (await attempted).data;
        proof.refusal = await refusal;
        proof.after_command = after;
        assert.equal(after.result.status, 'child_session_refused');
        assert.equal(after.result.message, 'not available in task child sessions');
        assert.deepEqual(after.ledger_entries, []);
        assert.deepEqual(after.state, event.data.state);
        proof.product_receipt_exists = existsSync(join(sandbox.agentDir, 'logs/oracle-advisor.jsonl'));
        assert.equal(proof.product_receipt_exists, false);
        proof.meets_inert_contract = true;
      } finally {
        if (owned) {
          await owned.stop({ force: true });
          proof.cleanup.owned_pid_gone = owned.metadata.pid_gone;
        }
        if (!owned || owned.metadata.pid_gone) {
          proof.cleanup.disposable_state = cleanupDisposableState(sandbox);
        }
      }
    }
    receipt.provider_calls = mock.requests.length;
    assert.equal(receipt.provider_calls, 0);
    receipt.meets_inert_contract = true;
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = 'failed';
    receipt.exit_code = 1;
    receipt.error = { type: error.code ?? 'assertion_failed', message: error.message };
  } finally {
    if (mock) {
      await mock.close();
      receipt.cleanup.mock_listener_closed = true;
    }
    receipt.cleanup.all_owned_pids_gone = receipt.variants.every(proof => proof.cleanup.owned_pid_gone);
    receipt.cleanup.all_disposable_states_removed = receipt.variants.every(proof => proof.cleanup.disposable_state?.removed);
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    const path = join(evidenceDir, 'child-entry.json');
    writeJson(path, receipt);
    console.log(JSON.stringify({ receipt: path, status: receipt.status,
      product_contract_met: receipt.meets_inert_contract, exit_code: receipt.exit_code }));
    process.exitCode = receipt.exit_code;
  }
}
