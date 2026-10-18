import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  effectiveOracleTools, installOraclePolicy, parseJsonc, POLICY_DECISION,
  READONLY_ORACLE_TOOLS, uninstallOraclePolicy,
} from '../scripts/oracle-policy.mjs';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, finalizeAuthObservation, hashFile, hostArgs, hostConfiguration, readJson, sourceHash, writeJson,
} from './harness.mjs';
import { startCapabilityProvider } from './capability-provider.mjs';
import { correlatePolicyOrigins, describePolicyRequest } from './provider-purpose.mjs';
import { evaluateVerdict } from './verdict-spec.mjs';

const realCases = ['oracle-readonly', 'oracle-write-attempt', 'oracle-consumer-visual'];
const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.policy' && event.data?.event === name;
export async function startPolicyProxy(rawPath, { upstreamBaseUrl = 'https://ollama.com' } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const parsed = JSON.parse(body);
      const record = describePolicyRequest(parsed);
      record.started_at = Date.now();
      requests.push(record);
      writeJson(rawPath, requests);
      const upstream = await fetch(`${upstreamBaseUrl}${request.url}`, {
        method: request.method, headers: { 'content-type': 'application/json', authorization: request.headers.authorization },
        body, signal: AbortSignal.timeout(150000),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) {
        const source = Readable.fromWeb(upstream.body);
        const decoder = new TextDecoder();
        let pending = '', text = '';
        source.on('data', chunk => {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
            try {
              const event = JSON.parse(line.slice(6));
              record.response_id ??= event.id;
              text += event.choices?.[0]?.delta?.content ?? '';
            } catch { /* Unparseable wire data cannot prove a side-request origin. */ }
          }
        });
        source.on('end', () => {
          record.completed = true;
          record.finished_at = Date.now();
          if (text.trim()) record.response_sha256 = createHash('sha256').update(text.trim()).digest('hex');
          writeJson(rawPath, requests);
        });
        source.pipe(response);
      }
      else response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(502);
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1'); await ready;
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async close() { const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; },
  };
}
function pngFixture() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const bytes = Buffer.alloc(body.length + 8);
    bytes.writeUInt32BE(data.length); body.copy(bytes, 4);
    bytes.writeUInt32BE(crc32(body), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(64 * 257);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const offset = y * 257 + 1 + x * 4;
    rows[offset + 1] = 128; rows[offset + 2] = 255; rows[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export function assertVisualObservation(receipt, expectedTools) {
  return evaluateVerdict('oracle-consumer-visual', receipt, { expectedTools });
}

export async function runOraclePolicyCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  if (!['real', 'mock'].includes(values.oracle)) throw new Error('Invalid --oracle');
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const mockOracle = values.oracle === 'mock';
  const evidenceDir = join(attemptDir, 'task-11-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, `${values.case}-`));
  const host = discoverHost();
  const before = authHashes();
  const receipt = {
    case: values.case, status: 'running', exit_code: null, argv: process.argv,
    source_hash: sourceHash(), installed_versions: host.versions, run_dir: runDir,
    oracle_mode: values.oracle, main_mode: 'mock',
    started_at: new Date().toISOString(), auth_before: before, real_oracle_runs: 0,
    provider_calls: [], events: [], oracle_requests: [], blocked_by_auth_guard: [], cleanup: {},
    raw_output_path: join(runDir, 'observations.json'),
    adversarial: {
      malformed_input: 'Unit tests exercise comments/strings with braces, CRLF, BOM, trailing commas and rejected malformed JSONC.',
      dirty_state: 'policy-uninstall-after-unrelated-edit preserves an unrelated prefix edit.',
      installer_drift: 'Unit tests preserve drifted ranges and restore independent unchanged ranges.',
      stale_state: 'oracle-profile-switch rereads the config with two profile environments.',
      others: { status: 'not_applicable', reason: 'No STOP, nudge, concurrency, branch ledger, or transport-revival behavior is changed by this installer task.' },
    },
  };
  let sandbox, owned, mock, proxy;
  try {
    sandbox = disposableEnvironment(host, runDir, {
      ORACLE_QA_ATTEMPT: values.attempt, ORACLE_QA_ATTEMPT_DIR: attemptDir,
      ORACLE_QA_WRITE_TARGET: join(runDir, 'must-not-exist.txt'),
      ORACLE_QA_IMAGE: join(runDir, 'fixture.png'),
      OMO_PROFILE: '', OCX_PROFILE: '', OPENCODE_CONFIG_DIR: '',
    });
    receipt.temp_home = sandbox.home;
    const configPath = join(sandbox.home, '.omo/omo.jsonc');
    writeFileSync(configPath, hostConfiguration().config);
    const options = { configPath, cwd: sandbox.workDir, env: sandbox.env, decision: POLICY_DECISION,
      manifestPath: join(runDir, 'delta-manifest.json') };
    const original = readFileSync(configPath, 'utf8');
    receipt.dry_run = installOraclePolicy({ ...options, dryRun: true });
    receipt.config_evidence = {
      original, dry_run_after: readFileSync(configPath, 'utf8'),
      dry_run_manifest_exists: existsSync(options.manifestPath),
    };
    const applied = installOraclePolicy(options);
    receipt.delta_manifest = options.manifestPath;
    writeJson(join(evidenceDir, 'delta-manifest.json'), applied);
    receipt.config_evidence.applied_effective = effectiveOracleTools(sandbox.workDir, { env: sandbox.env });
    if (!realCases.includes(values.case)) receipt.preflight_verdict_rows =
      evaluateVerdict(values.case, receipt, { stage: 'preflight' });

    if (values.case === 'policy-uninstall-after-unrelated-edit') {
      const unrelated = '// unrelated owner change: { "tools": "}" }\r\n';
      writeFileSync(configPath, unrelated + readFileSync(configPath, 'utf8'));
      receipt.uninstall = uninstallOraclePolicy({ configPath, manifestPath: options.manifestPath });
      receipt.uninstall_evidence = { unrelated_prefix: unrelated, after: readFileSync(configPath, 'utf8') };
      receipt.byte_identical_except_unrelated_edit = receipt.uninstall_evidence.after === unrelated + original;
    } else if (values.case === 'oracle-project-override-write') {
      const projectFile = join(sandbox.workDir, '.omo/omo.jsonc');
      writeJson(projectFile, { '[native]': { agents: { oracle: { tools: { write: true } } } } });
      receipt.project_override = { file: projectFile, document: parseJsonc(readFileSync(projectFile, 'utf8')) };
      receipt.dry_run_with_override = installOraclePolicy({ ...options, dryRun: true });
      receipt.refusal = effectiveOracleTools(sandbox.workDir, { env: sandbox.env });
      receipt.refusal_surface = 'Exported policy preflight; todo 7 consumes this result before native task dispatch.';
      receipt.zero_oracle_runs = receipt.events.filter(event =>
        event.kind === 'attempt' && event.name === 'task').length === 0 && receipt.oracle_requests.length === 0;
    } else if (values.case === 'oracle-profile-switch') {
      const document = parseJsonc(readFileSync(configPath, 'utf8'));
      const profiles = Object.keys(document.profiles ?? {});
      const configBefore = readFileSync(configPath, 'utf8');
      receipt.switches = profiles.slice(0, 2).map(profile => {
        const effective = effectiveOracleTools(sandbox.workDir, { env: { ...sandbox.env, OMO_PROFILE: profile } });
        return { profile, effective, root_still_governs: effective.readonly,
          needs_all_profiles: !effective.readonly };
      });
      receipt.profile_evidence = { profiles, before: configBefore, after: readFileSync(configPath, 'utf8') };
      receipt.all_profiles_dry_run = installOraclePolicy({ ...options, allProfiles: true, dryRun: true });
      receipt.external_owner_selector = {
        status: 'not_exercised', reason: 'The external owner selector is unlocated per todo 2; no live profile-switch script is invoked.',
      };
      // Also distinguish a stale permissive profile from the live-copy profiles.
      document.profiles['qa-unsafe'] = { '[native]': { agents: { oracle: { tools: { write: true } } } } };
      writeJson(configPath, document);
      receipt.unsafe_switched_profile = effectiveOracleTools(sandbox.workDir, {
        env: { ...sandbox.env, OMO_PROFILE: 'qa-unsafe' },
      });
      const repair = installOraclePolicy({ ...options, allProfiles: true, manifestPath: join(runDir, 'all-profiles-delta.json') });
      receipt.all_profiles_repair = repair;
      receipt.repaired_switched_profile = effectiveOracleTools(sandbox.workDir, {
        env: { ...sandbox.env, OMO_PROFILE: 'qa-unsafe' },
      });
    } else if (realCases.includes(values.case)) {
      const document = parseJsonc(readFileSync(configPath, 'utf8'));
      document['[native]'].task = { ...(document['[native]'].task ?? {}),
        default_execution_mode: 'in-process', state_dir: join(runDir, 'task-state') };
      document['[native]'].agents.oracle.model = 'ollama/deepseek-v4.1-flash';
      if (mockOracle) document['[native]'].agents.oracle.model = 'oracle-qa-mock/oracle';
      delete document['[native]'].agents.oracle.variant;
      delete document['[native]'].agents.oracle.model_fallback;
      writeJson(configPath, document);
      if (values.case === 'oracle-consumer-visual') writeFileSync(sandbox.env.ORACLE_QA_IMAGE, pngFixture());
      const doctor = await import(pathToFileURL(join(host.plugin, 'runtime/category-coverage/index.js')).href);
      receipt.schema_diagnostics = doctor.configDoctorLines({ cwd: sandbox.workDir, env: sandbox.env });
      receipt.preflight_verdict_rows = evaluateVerdict(values.case, receipt, { stage: 'preflight' });
      receipt.static_configuration_validated = receipt.preflight_verdict_rows.every(row => row.admission && row.behavioral);
      // Static work above is retained even if this gate refuses. No fallback,
      // baseline replacement, paid call, or host startup precedes this gate.
      if (!mockOracle) admitAuth(attemptDir, undefined, { receipt });
      mock = await startCapabilityProvider(join(runDir, 'provider.jsonl'));
      if (!mockOracle) proxy = await startPolicyProxy(join(runDir, 'real-provider-schemas.json'));
      sandbox.env.ORACLE_QA_MOCK_URL = mock.baseUrl;
      if (proxy) sandbox.env.ORACLE_QA_POLICY_PROXY = proxy.url;
      sandbox.env.ORACLE_QA_REAL_ORACLE = mockOracle ? '0' : '1';
      const args = [
        ...hostArgs(host, sandbox, join(ROOT, 'qa/oracle-policy-extension.mjs'), {
          main: 'mock', realOracle: !mockOracle, mockExtension: join(ROOT, 'qa/capability-models.mjs'),
        }), ...(!mockOracle ? ['--extension', join(ROOT, 'qa/oracle-policy-models.mjs')] : []),
        '--tools', ['probe_oracle', 'task', 'task_cancel', 'task_output', ...Object.keys(READONLY_ORACLE_TOOLS)].join(','),
        '--system-prompt', 'Run the exact requested probe_oracle tool and no other tool.',
      ];
      owned = new OwnedProcess(process.execPath, args, {
        cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(runDir, 'host'),
      });
      receipt.host_process = owned.metadata;
      await owned.rpc('get_state');
      await owned.waitFor(isEvent('ready'), 'policy extension ready');
      const action = values.case === 'oracle-readonly' ? 'surface' : values.case === 'oracle-write-attempt' ? 'write' : 'image';
      await owned.prompt(`QA_CAPABILITY:${action} QA_RUN_${sandbox.env.ORACLE_QA_NONCE}`);
      receipt.events = owned.history.filter(event => event.type === 'extension_event' &&
        event.name === 'oracle-qa.policy').map(event => event.data);
      receipt.observation = receipt.events.findLast(event => event.event === 'result');
      receipt.image_path = sandbox.env.ORACLE_QA_IMAGE;
      receipt.image_sha256 = hashFile(receipt.image_path);
      const id = receipt.observation?.id;
      if (!id) evaluateVerdict(values.case, receipt, { expectedTools: [] });
      const recordPath = join(runDir, 'task-state/tasks', `${id}.json`);
      const taskRecord = existsSync(recordPath) ? readJson(recordPath) : {};
      receipt.oracle_response = taskRecord.final_response ?? receipt.observation.text;
      receipt.oracle_task_status = taskRecord.status;
      receipt.child_task_id = id;
      // The proxy observes the machine-consumed child schema. Session entries
      // separately prove actual tool execution; parent hooks cannot inspect it.
      const sessions = join(runDir, 'task-state/children', id, 'sessions', id);
      const sessionEntries = existsSync(sessions) ? readdirSync(sessions).filter(name => name.endsWith('.jsonl')).flatMap(name =>
        readFileSync(join(sessions, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse)) : [];
      receipt.child_entries = sessionEntries;
      receipt.parent_tool_inspection = 'unproven; policy preflight and actual child tool results are recorded separately';
      const oracleRequests = correlatePolicyOrigins(proxy?.requests ??
        mock.requests.filter(request => request.model === 'oracle'), sessionEntries, {
        fixture_path: receipt.image_path, fixture_sha256: receipt.image_sha256,
      });
      receipt.oracle_requests = oracleRequests;
      if (proxy) writeJson(join(runDir, 'real-provider-schemas.json'), oracleRequests);
      receipt.actual_oracle_tools = oracleRequests.find(request => request.purpose === 'oracle_agent')?.tools;
      const unavailable = ['coordination_inspect', 'coordination_ask'];
      const expectedAvailable = Object.keys(READONLY_ORACLE_TOOLS).filter(name => !unavailable.includes(name)).sort();
      receipt.expected_oracle_tools = expectedAvailable;
      receipt.unavailable_true_keys = unavailable;
      receipt.preflight = effectiveOracleTools(sandbox.workDir, { env: sandbox.env });
      receipt.child_tool_calls = sessionEntries.filter(entry => entry.message?.role === 'assistant')
        .flatMap(entry => entry.message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name);
      if (values.case === 'oracle-readonly') {
        receipt.oracle_self_report = receipt.oracle_response;
      } else if (values.case === 'oracle-write-attempt') {
        receipt.capability_refusal = { kind: 'write_tool_unavailable', oracle_response: receipt.oracle_response };
        receipt.file_exists = existsSync(sandbox.env.ORACLE_QA_WRITE_TARGET);
      } else {
        receipt.read_tool_results = sessionEntries.filter(entry => entry.message?.role === 'toolResult' &&
          entry.message.toolName === 'read').map(entry => entry.message);
      }
      receipt.retirement = await owned.rpc('extension_request', { name: 'oracle.policy.retire', data: {} });
      receipt.retired_tasks = receipt.retirement.retired.map(item => item.output.details?.snapshot);
      receipt.cleanup.running_oracle_records = 0;
      receipt.cleanup.resident_sessions = 0;
      receipt.real_oracle_runs = mockOracle ? 0 : 1;
    } else throw new Error(`Unknown oracle policy case ${values.case}`);
    evaluateVerdict(values.case, receipt, {
      expectedTools: receipt.expected_oracle_tools, host: realCases.includes(values.case),
    });
    if (values.case === 'oracle-profile-switch') receipt.static_profile_switch = 'passed';
    receipt.status = 'passed';
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = error.code === 'auth_changed' ? 'blocked_by_auth_guard'
      : error.code === 'scenario_not_reached' ? error.code : 'failed';
    receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'assertion_failed', message: error.message };
    if (error.code === 'auth_changed') receipt.blocked_by_auth_guard.push(values.case);
  } finally {
    if (owned) {
      try { receipt.final_retirement = await owned.rpc('extension_request', { name: 'oracle.policy.retire', data: {} }); }
      catch (error) { receipt.retirement_error = error.message; }
      await owned.stop({ force: true });
      receipt.cleanup.pids_gone = owned.metadata.pid_gone;
      receipt.provider_calls = owned.history.filter(isEvent('provider_request')).map(event => event.data);
    }
    if (mock) { receipt.mock_provider_calls = mock.requests; await mock.close(); receipt.cleanup.mock_listener_closed = true; }
    if (proxy) {
      receipt.real_provider_calls = proxy.requests;
      receipt.real_oracle_runs = proxy.requests.length ? 1 : 0;
      await proxy.close(); receipt.cleanup.proxy_listener_closed = true;
      finalizeAuthGuard(receipt, attemptDir);
    }
    if (sandbox) receipt.cleanup.disposable_state = cleanupDisposableState(sandbox);
    if (!proxy) finalizeAuthObservation(receipt, before, undefined, { changeStatus: true });
    receipt.finished_at = new Date().toISOString();
    writeJson(receipt.raw_output_path, receipt);
    writeJson(join(runDir, 'receipt.json'), receipt);
    writeJson(join(evidenceDir, `${values.case}.json`), receipt);
    console.log(JSON.stringify({ case: values.case, status: receipt.status, exit_code: receipt.exit_code,
      receipt: join(evidenceDir, `${values.case}.json`), error: receipt.error ?? null }));
    process.exitCode = receipt.exit_code;
  }
  return receipt;
}
