import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, typedError } from './harness.mjs';
import {
  createPane, closePane, createTuiSandbox, run, sendText, sendKeys,
  waitOutput, readText, startMock,
} from '../../piomo-primary-agents/qa/probes/tui-lib.mjs';
import { SEEDED_MODEL_PROFILES } from '../../piomo-primary-agents/qa/harness.mjs';

const primaryEntry = process.env.ORACLE_QA_PRIMARY_ENTRY;
const oracleEntry = process.env.ORACLE_QA_INSTALLED_ENTRY;
if (!primaryEntry || !oracleEntry) throw typedError('installed_entries_required',
  'Provide ORACLE_QA_PRIMARY_ENTRY and ORACLE_QA_INSTALLED_ENTRY for read-only installed QA.');
const evidence = join(ROOT, '.omo/evidence', `installed-entry-${Date.now()}`);
mkdirSync(evidence, { recursive: true });
const receipt = { exit_code: 1, command: '/ulw-execute', real_consults: 0 };
const mock = await startMock({ route: () => ({ text: 'Owned entry-path QA complete.' }) });
const tui = createTuiSandbox({
  name: 'atlas-entry',
  extensions: [
    primaryEntry,
    oracleEntry,
  ],
  omoConfig: {
    model_profiles: SEEDED_MODEL_PROFILES,
    '[native]': { agents: { oracle: { model: 'qa-mock/claude-mock-medium', tools: { read: true } } } },
  },
  mockUrl: mock.baseUrl,
  extraEnv: { OMO_ORACLE_ADVISOR: '1', OMO_ORACLE_AUTO_ATLAS: '1' },
});
let pane;
const entries = () => readFileSync(tui.sandbox.sessionFile, 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  pane = createPane(tui.sandbox.workDir, 'Atlas implementation entry QA');
  receipt.pane = pane;
  receipt.launch = tui.command;
  run(pane, tui.command);
  const initial = await waitOutput(pane, 'Sisyphus', { timeout: 60000 });
  assert.equal(initial.code, 0, 'initial Sisyphus editor must load');
  receipt.before_frame = readText(pane);
  assert.equal(entries().filter(e => e.customType === 'oracle-advisor' && e.data.type === 'job_opened').length, 0);
  const opened = waitOutput(pane, '고문 자동 작업 J1 시작', { timeout: 60000 });
  sendText(pane, '/ulw-execute');
  sendKeys(pane, 'enter');
  assert.equal((await opened).code, 0, 'implementation entry must open an automatic oracle job');
  const branch = entries();
  const atlas = branch.findIndex(e => e.customType === 'primary-agent/v1' && e.data.agentId === 'atlas');
  const job = branch.findIndex(e => e.customType === 'oracle-advisor' && e.data.type === 'job_opened');
  assert.ok(atlas >= 0 && job > atlas, 'real primary-agent transition must precede auto job');
  receipt.identity = branch[atlas];
  receipt.job = branch[job];
  assert.equal(receipt.job.data.auto.trigger, 'atlas_ulw_execute');
  receipt.after_frame = readText(pane);
  cpSync(tui.sandbox.sessionFile, join(evidence, 'entry-tui-session.jsonl'));
  receipt.exit_code = 0;
} catch (error) {
  receipt.error = { message: error.message, stack: error.stack };
} finally {
  if (pane) receipt.close = closePane(pane);
  await mock.close();
  rmSync(tui.sandbox.stateDir, { recursive: true, force: true });
  receipt.temp_removed = true;
  writeFileSync(join(evidence, 'entry-tui-test.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ exit_code: receipt.exit_code, real_consults: 0,
  identity: receipt.identity?.data, job: receipt.job?.data, rollback: receipt.rollback,
  error: receipt.error }));
process.exitCode = receipt.exit_code;
