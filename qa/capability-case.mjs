import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  ROOT, OwnedProcess, admitAuth, authHashes, cleanupDisposableState, discoverHost, disposableEnvironment,
  finalizeAuthGuard, guardAuth, hostArgs, hostConfiguration, sourceHash, writeJson, readJson,
} from './harness.mjs';
import { startCapabilityProvider } from './capability-provider.mjs';
import { decideProbe } from './probe-decision.mjs';

const TRUE_TOOLS = ['read', 'find', 'grep', 'ls', 'lsp_diagnostics', 'lsp_goto_definition',
  'lsp_find_references', 'lsp_symbols', 'coordination_inspect', 'coordination_ask', 'look_at'];
const toolMap = Object.fromEntries(TRUE_TOOLS.map(name => [name, true]));
const isEvent = name => event => event.type === 'extension_event' &&
  event.name === 'oracle-qa.capability' && event.data?.event === name;
const textOf = result => result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
const terminal = status => !['pending', 'running'].includes(status);

function pngFixture() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const output = Buffer.alloc(body.length + 8);
    output.writeUInt32BE(data.length);
    body.copy(output, 4);
    output.writeUInt32BE(crc32(body), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64); header.writeUInt32BE(64, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(64 * 257);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const offset = y * 257 + 1 + x * 4;
    rows[offset + 1] = 128; rows[offset + 2] = 255; rows[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function imageObservation(entry) {
  const results = entry.read_tool_results ?? [];
  const supported = results.some(result => result.content_types.includes('image'));
  return { supported, provider_received_images: entry.provider_calls.some(item => item.image_parts > 0),
    read_tool_results: results, error: supported ? null : results.flatMap(result => result.text).join('\n'),
    observation: entry.observation, provider_calls: entry.provider_calls };
}

function idleTimeoutResult(entry) {
  const observation = entry.observation;
  const message = textOf(observation.spawn?.result);
  const proven = /(?:Provider stream(?! start).*timed out|idle|stalled)/i.test(message) && /600/.test(message);
  return {
    applies: proven ? true : 'unproven', value_ms: proven ? 600 : null,
    installed_host_default_ms: 300000, fixture_value_ms: 600,
    error: proven ? null : observation.timeout_observation ?? {
      code: 'idle_timeout_not_observed', message: message || 'No provider idle-timeout result was returned.',
    },
    setting: 'httpIdleTimeoutMs, overridden by retry.provider.timeoutMs',
    observation,
  };
}

function parseJsonc(text) {
  let result = '';
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const a = text[i], b = text[i + 1];
    if (state === 'string') {
      result += a;
      if (a === '\\') { result += b; i++; } else if (a === '"') state = 'normal';
    } else if (state === 'line') {
      if (a === '\n') { result += a; state = 'normal'; }
    } else if (state === 'block') {
      if (a === '*' && b === '/') { state = 'normal'; i++; }
    } else if (a === '"') { state = 'string'; result += a; }
    else if (a === '/' && b === '/') { state = 'line'; i++; }
    else if (a === '/' && b === '*') { state = 'block'; i++; }
    else result += a;
  }
  return JSON.parse(result);
}

export async function runCapabilityCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) throw new Error('Attempt must be a simple name');
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-2-piomo-oracle-advisor-mod');
  const rawDir = join(evidenceDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const runDir = mkdtempSync(join(rawDir, `${values.case}-`));
  const host = discoverHost();
  const usesRealOracle = values.case === 'probe';
  const before = usesRealOracle || !existsSync(join(attemptDir, 'real-model-safety.json'))
    ? admitAuth(attemptDir, undefined, { real: usesRealOracle }) : authHashes();
  const receipt = { case: values.case, status: 'running', exit_code: null, argv: process.argv,
    source_hash: sourceHash(), installed_versions: host.versions, host, run_dir: runDir,
    auth_before: before, runs: [], started_at: new Date().toISOString() };
  const mock = await startCapabilityProvider(join(runDir, 'provider.jsonl'));
  const doctor = await import(pathToFileURL(join(host.plugin, 'runtime/category-coverage/index.js')).href);
  const snapshot = hostConfiguration({ profile: true });
  const original = parseJsonc(snapshot.config);
  const activeProfile = snapshot.active_profile;
  const otherProfile = Object.keys(original.profiles).find(name => name !== activeProfile);

  function configuration(policy, profile = activeProfile, real = false) {
    const config = structuredClone(original);
    // A disposable copy keeps all profile definitions but all oracle routes use
    // the selected QA model, so missing provider catalog entries cannot spend.
    for (const layer of [config, ...Object.values(config.profiles ?? {})]) {
      const native = layer['[native]'] ??= {};
      native.task = { ...(native.task ?? {}), default_execution_mode: 'in-process' };
      const oracle = (native.agents ??= {}).oracle ??= {};
      oracle.model = real ? 'ollama/deepseek-v4.1-flash' : 'oracle-qa-mock/oracle';
      delete oracle.tools;
      delete oracle.variant;
      delete oracle.model_fallback;
    }
    if (policy === 'both' || policy === 'profile') config.profiles[profile]['[native]'].agents.oracle.tools = toolMap;
    if (policy === 'both' || policy === 'root') config['[native]'].agents.oracle.tools = toolMap;
    return config;
  }

  async function run(name, action, options = {}) {
    assert.ok(usesRealOracle || !options.real, 'Mock-only supplements cannot dispatch a real model.');
    const directory = join(runDir, name);
    mkdirSync(directory);
    const sandbox = disposableEnvironment(host, directory, {
      ORACLE_QA_MOCK_URL: mock.baseUrl, ORACLE_QA_ATTEMPT: values.attempt,
      ORACLE_QA_REAL_ORACLE: options.real ? '1' : '0', ORACLE_QA_ATTEMPT_DIR: attemptDir,
      ORACLE_QA_TASK_STATE: join(directory, 'task-state'),
      ORACLE_QA_IMAGE: join(directory, 'fixture.png'),
      OMO_PROFILE: options.profile ?? activeProfile, OCX_PROFILE: options.profile ?? activeProfile,
    });
    const configPath = join(sandbox.home, '.omo/omo.jsonc');
    const config = configuration(options.policy, options.profile, options.real);
    for (const layer of [config, ...Object.values(config.profiles)]) layer['[native]'].task.state_dir = join(directory, 'task-state');
    if (options.selectionOnly) {
      config['[native]'].agents.oracle.tools = { look_at: true };
      config.profiles[activeProfile]['[native]'].agents.oracle.tools = { read: true };
      config.profiles[otherProfile]['[native]'].agents.oracle.tools = { lsp_symbols: true };
    }
    writeJson(configPath, config);
    if (action === 'image') writeFileSync(sandbox.env.ORACLE_QA_IMAGE, pngFixture());
    if (options.selectionOnly) {
      delete sandbox.env.OMO_PROFILE; delete sandbox.env.OCX_PROFILE; delete sandbox.env.OPENCODE_CONFIG_DIR;
    }
    writeJson(join(sandbox.home, '.omo/native-profile-selection.json'), { profile: options.homeSelection ?? activeProfile });
    writeJson(join(sandbox.agentDir, 'native-profile-selection.json'), { profile: options.agentSelection ?? otherProfile });
    if (options.project) {
      writeJson(join(sandbox.workDir, '.omo/omo.jsonc'), {
        '[native]': { agents: { oracle: { tools: { write: true }, model: 'oracle-qa-mock/oracle' } } },
      });
    }
    const settings = readJson(join(sandbox.agentDir, 'settings.json'));
    if (options.promote) settings.promptCache = { safetyBufferSeconds: 299 };
    if (options.idle) settings.httpIdleTimeoutMs = 600;
    writeJson(join(sandbox.agentDir, 'settings.json'), settings);
    const configBefore = readFileSync(configPath, 'utf8');
    const schema = doctor.configDoctorLines({ cwd: sandbox.workDir, env: sandbox.env });
    const entry = { name, action, disposable_home: sandbox.home, profile_env: sandbox.env.OMO_PROFILE ?? null,
      config_validation: { loader: join(host.plugin, 'runtime/category-coverage/index.js'),
        diagnostics: schema, schema_valid: schema.length === 0 },
      before_selection: { home: options.homeSelection ?? activeProfile, agent: options.agentSelection ?? otherProfile } };
    receipt.runs.push(entry);
    const args = [...hostArgs(host, sandbox, join(ROOT, 'qa/capability-extension.mjs'), {
      main: 'mock', mockExtension: join(ROOT, 'qa/capability-models.mjs'),
    }),
      ...(options.real ? ['--extension', join(ROOT, 'qa/main-provider.mjs')] : []),
      '--tools', 'probe_oracle,task,task_send,task_cancel,task_output,read,find,grep,ls,lsp_diagnostics,lsp_goto_definition,lsp_find_references,lsp_symbols',
      '--system-prompt', 'Run the exact requested probe tool. Do not call other tools.'];
    const child = new OwnedProcess(process.execPath, args, {
      cwd: sandbox.workDir, env: sandbox.env, rawPrefix: join(directory, 'host'), deadlineMs: 150000,
    });
    entry.process = child.metadata;
    const fromRequests = mock.requests.length;
    let pending;
    try {
      await child.rpc('get_state');
      await child.waitFor(isEvent('ready'), 'capability extension ready');
      const observed = child.waitFor(isEvent('result'), `${action} observations`, { timeoutMs: options.idle ? 8000 : 125000 });
      pending = child.prompt(`QA_CAPABILITY:${action} QA_RUN_${sandbox.env.ORACLE_QA_NONCE}`);
      pending.catch(() => {});
      if (options.abort) {
        const admitted = mock.requests.findLast(item => item.model === 'oracle' && /QA_HOLD_ABORT/.test(item.text));
        if (!admitted) {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { mock.events.off('request', listener); reject(new Error('abort fixture not admitted')); }, 20000);
            const listener = item => { if (item.model === 'oracle' && /QA_HOLD_ABORT/.test(item.text)) {
              clearTimeout(timeout); mock.events.off('request', listener); resolve(item);
            } };
            mock.events.on('request', listener);
          });
        }
        await child.rpc('abort');
      }
      if (options.promote) {
        await child.waitFor(isEvent('foreground_returned'), 'foreground promoted before release', { timeoutMs: 20000 });
        mock.release('PROMOTE');
      }
      try { entry.observation = (await observed).data; }
      catch (error) {
        if (!options.idle) throw error;
        entry.observation = { action, timeout_observation: { code: error.code, message: error.message },
          provider_idle_timeout_not_observed_within_ms: 8000 };
        entry.retirement = await child.rpc('extension_request', { name: 'oracle.probe.retire', data: {} });
      }
      await pending.catch(error => { if (!options.abort) throw error; entry.prompt_abort_error = error.message; });
      entry.after_tool = await child.rpc('extension_request', { name: 'oracle.probe.status', data: {} });
      if (action === 'image' && entry.observation.spawn?.id) {
        const id = entry.observation.spawn.id;
        const sessions = join(directory, 'task-state/children', id, 'sessions', id);
        entry.read_tool_results = readdirSync(sessions).filter(file => file.endsWith('.jsonl')).flatMap(file =>
          readFileSync(join(sessions, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
          .filter(item => item.message?.role === 'toolResult' && item.message.toolName === 'read')
          .map(item => ({ isError: item.message.isError, content_types: item.message.content.map(part => part.type),
            text: item.message.content.filter(part => part.type === 'text').slice(0, 1).map(part => part.text) }));
      }
      entry.retirement = await child.rpc('extension_request', { name: 'oracle.probe.retire', data: {} });
      entry.after_retire = await child.rpc('extension_request', { name: 'oracle.probe.status', data: {} });
      entry.config_unchanged = configBefore === readFileSync(configPath, 'utf8');
      entry.selections_after = {
        home: readJson(join(sandbox.home, '.omo/native-profile-selection.json')),
        agent: readJson(join(sandbox.agentDir, 'native-profile-selection.json')),
      };
      writeJson(join(directory, 'observations.json'), entry);
    } catch (error) {
      entry.error = { code: error.code ?? null, message: error.message };
      try { entry.retirement = await child.rpc('extension_request', { name: 'oracle.probe.retire', data: {} }); } catch (failure) { entry.retirement_error = failure.message; }
      writeJson(join(directory, 'observations.json'), entry);
      throw error;
    } finally {
      await child.stop({ force: true });
      entry.provider_calls = mock.requests.slice(fromRequests);
      entry.cleanup = cleanupDisposableState(sandbox);
      entry.auth_after = usesRealOracle ? guardAuth(attemptDir) : authHashes();
    }
    return entry;
  }

  try {
    if (values.case === 'probe-completion') {
      const report = readJson(join(evidenceDir, 'probe-report.json'));
      const path = join(report.run_dir, 'completion-notification/sessions/owned.jsonl');
      const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const messages = entries.filter(entry => entry.type === 'custom_message' &&
        (entry.customType === 'senpi-task.completion' || (entry.customType === 'omo-senpi:wake' &&
          Array.isArray(entry.details) && entry.details.some(part => part.customType === 'senpi-task.completion'))))
        .map(entry => ({ ...entry, chars: entry.content.length }));
      assert.ok(messages.length, 'Actual native completion must be present in the immutable parent transcript.');
      report.engine_completion_messages.background = messages;
      report.engine_completion_messages.background_chars = messages.reduce((sum, item) => sum + item.chars, 0);
      report.engine_completion_messages.native_envelope = 'omo-senpi:wake with details[].customType=senpi-task.completion';
      report.engine_completion_messages.raw_parent_transcript = path;
      report.await.find(item => item.name === 'completion-notification').parent_boundary_observation = {
        messages: messages.length, chars: report.engine_completion_messages.background_chars,
        arrived_while_extension_executing: false,
        delivery: 'The persisted wake entry follows the outer tool result; it cannot unblock that executing tool.',
      };
      report.completion_reconciliation_source_hash = receipt.source_hash;
      receipt.report = report;
      Object.assign(receipt, { status: 'passed', exit_code: 0 });
    } else if (values.case === 'probe-idle') {
      const idle = await run('idle-after-first-event', 'idle', { idle: true });
      const image = await run('valid-png-read', 'image', { policy: 'both' });
      const report = readJson(join(evidenceDir, 'probe-report.json'));
      report.provider_idle_timeout = idleTimeoutResult(idle);
      report.policy.read_images = imageObservation(image);
      report.supplemental_source_hash = receipt.source_hash;
      report.runs.push(...receipt.runs);
      report.decision = decideProbe(report);
      report.cleanup_verified &&= receipt.runs.every(entry => entry.retirement.every(item => {
        const snapshot = item.output?.details?.snapshot ?? item.snapshot;
        return snapshot && terminal(snapshot.status) && snapshot.residency_state !== 'resident';
      }));
      receipt.report = report;
      assert.equal(report.provider_idle_timeout.applies, true, 'Actual idle-after-first-event child guard');
      Object.assign(receipt, { status: 'passed', exit_code: 0 });
    } else if (values.case === 'probe-dead-target') {
      const dead = await run('dead-target', 'dead');
      const refusal = dead.observation.send;
      assert.ok(refusal?.isError || /not.continuable|cancelled|No resident|not_found/.test(JSON.stringify(refusal)), 'exact dead-target refusal');
      Object.assign(receipt, { refusal, retries: 0, status: 'passed', exit_code: 0 });
      writeJson(join(evidenceDir, 'probe-dead-target.json'), receipt);
    } else {
      const mockTransport = await run('transport-mock', 'transport');
      // Native oracle routing with a real model, deliberately using the cheap
      // credential-safe registered route. The production oracle OAuth store is
      // never opened by this disposable host. Every dispatch reserves the cap.
      const transport = await run('transport-real', 'transport', { real: true });
      const abort = await run('abort-mock', 'abort', { abort: true });
      const promotion = await run('promotion-mock', 'promote', { promote: true });
      const idle = await run('idle-timeout-mock', 'idle', { idle: true });
      const image = await run('image-read-mock', 'image', { policy: 'both' });
      const notification = await run('completion-notification', 'notification');
      const variants = [];
      for (const [name, options] of [
        ['no-change', {}], ['both-paths', { policy: 'both' }],
        ['root-active', { policy: 'root' }], ['root-other', { policy: 'root', profile: otherProfile }],
        ['project-override', { policy: 'both', project: true }],
        ['profile-only', { policy: 'profile' }],
        ['selection-home-active', { selectionOnly: true, homeSelection: activeProfile, agentSelection: otherProfile }],
        ['selection-agent-active', { selectionOnly: true, homeSelection: otherProfile, agentSelection: activeProfile }],
      ]) variants.push(await run(name, 'surface', options));
      const first = transport.observation.foreground;
      const revivals = transport.observation.revivals;
      assert.equal(revivals.length, 5);
      const rawOracle = variant => variant.provider_calls.find(call => call.model === 'oracle')?.tools ?? [];
      const unrestricted = rawOracle(variants[0]);
      const restricted = rawOracle(variants[1]);
      const expectedAvailable = TRUE_TOOLS.filter(tool => restricted.includes(tool)).sort();
      // Explicit true rules also activate latent builtins (find/grep/ls), so the
      // default unrestricted *active* list is not the registered-tool universe.
      const exclusive = restricted.length > 0 && restricted.every(tool => TRUE_TOOLS.includes(tool));
      const retirementClean = receipt.runs.every(entry => (entry.retirement ?? []).every(item => {
        const snapshot = item.output?.details?.snapshot ?? item.snapshot;
        return snapshot && terminal(snapshot.status) && snapshot.residency_state !== 'resident';
      }));
      const selectionTools = [rawOracle(variants[6]), rawOracle(variants[7])];
      const neitherSelectionFile = selectionTools.every(tools => JSON.stringify(tools) === '["look_at"]');
      const safety = readJson(join(attemptDir, 'real-model-safety.json'));
      assert.ok(safety.real_oracle_runs <= 24);
      const report = {
        ...receipt,
        real_oracle_runs_for_attempt: safety.real_oracle_runs,
        real_oracle_limit: 24,
        foreground: {
          ...first, final_text_returned: /QA_ANSWER_FIRST/.test(textOf(first.result)),
          nested_parent_tool_call_ids: transport.observation.nested.map(event => ({
            phase: event.phase, tool: event.toolName, id: event.toolCallId, parent: event.parentToolCallId,
          })),
          abort_observation: abort.observation,
          abort_propagates: !!abort.observation.terminal && abort.observation.terminal.status === 'cancelled',
        },
        await: mockTransport.observation.mechanisms,
        mock_transport: mockTransport.observation,
        oracle_model_observed: {
          real: 'ollama/deepseek-v4.1-flash', production: 'chatgpt-subscription/gpt-6.1-sol',
          reason: 'The cheap registered real route reads its key without an OAuth refresh or writable live AuthStorage; runtime mechanics use native task(oracle) unchanged.',
        },
        revivals: revivals.map((item, index) => ({ ...item,
          next_send_accepted: index < 4 ? revivals[index + 1].send_accepted : null,
          next_send_note: index === 4 ? 'No sixth revival was requested; send_accepted records admission of this fifth revival.' : null })),
        stuck_record: {
          reproduced: revivals.some(item => item.answered && item.status === 'running'),
          method: 'Unmodified installed engine; stand-in and real native oracle runs observed without patching records or installed files.',
          limitation: 'No synthetic stuck record is claimed. Normal terminal completion cannot enable live residency.',
        },
        policy: {
          input_key: 'tools', input_type: 'object<boolean>', true_keys: TRUE_TOOLS,
          schema_valid: variants[1].config_validation.schema_valid,
          exclusive, exact_available_true_keys: expectedAvailable,
          unavailable_true_keys: TRUE_TOOLS.filter(tool => !restricted.includes(tool)),
          variants: variants.map(variant => ({ name: variant.name, config_validation: variant.config_validation,
            tools: rawOracle(variant), oracle_self_report: textOf(variant.observation.spawn?.result),
            profile_env: variant.profile_env, selections: variant.before_selection,
            config_unchanged: variant.config_unchanged, raw_path: join(runDir, variant.name, 'observations.json') })),
          paths: [], profile_selection: {
            home_path: null,
            agent_path: null,
            observation: 'Selection files deliberately disagree in the disposable runs; effective profiles are selected by OMO_PROFILE/OCX_PROFILE when supplied.',
            authoritative_in_installed_engine: neitherSelectionFile ? 'neither selection file; root [native] without profile environment selectors' : 'see distinguishing effective tool surfaces',
            distinguishing_tools_observed: selectionTools,
            switch_rewrites_root: variants.every(variant => variant.config_unchanged) ? false : true,
            scope: 'Installed engine/config-loader selection only; no external owner profile-switch script was invoked.',
            external_owner_switch_rewrites_root: {
              status: 'unproven',
              error: 'No native-profile-selection reference was found in the installed plugin/config-loader or installed bin sources. The external owner selector was not located and was not invoked against any live file.',
            },
            distinguishing_policy: {
              root: { look_at: true }, home_profile: { read: true }, agent_profile: { lsp_symbols: true },
              purpose: 'With both profile environment selectors removed, the effective tool schema distinguishes the selection-file locations from the root view.',
            },
          },
          running_tool_list: {
            mechanism: mockTransport.after_tool.providerHooks.some(item => item.model === 'oracle')
              ? 'before_provider_request payload.tools' : 'unproven',
            available_to_parent_extension: mockTransport.after_tool.providerHooks.some(item => item.model === 'oracle'),
            proof: 'The QA HTTP server observes the machine-consumed child surface; it is not a product runtime inspection API.',
            error: mockTransport.after_tool.providerHooks.some(item => item.model === 'oracle') ? null
              : 'Observed parent before_provider_request hooks contained only model main; task_output snapshots and persisted spawn_spec do not contain an effective child tools field.',
            parent_hook_observed: mockTransport.after_tool.providerHooks.some(item => item.model === 'oracle'),
          },
          read_images: imageObservation(image),
        },
        usage: { source: 'Native task result details.run_stats and task snapshot run_stats; raw observations retained.',
          observed: first.result?.details?.run_stats ?? null,
          per_revival: revivals.map(item => ({ index: item.index, run_epoch: item.run_epoch,
            run_stats: item.output?.details?.snapshot?.run_stats ?? item.answer_arrival?.task?.run_stats ?? null })) },
        promotion: {
          ...promotion.observation,
          promoted: promotion.observation.spawn?.result?.details?.run_in_background === true,
          wait_continued_and_answered: !!promotion.observation.arrival,
          release_order: 'The held provider stream was released only after foreground_returned was observed.',
        },
        provider_idle_timeout: idleTimeoutResult(idle),
        engine_completion_messages: {
          foreground_and_revivals: transport.after_tool.persisted_completions,
          background: notification.after_tool.persisted_completions,
          arrived_while_extension_executing: notification.observation.persisted_while_executing,
          raw: notification.observation,
          foreground_notify_on_terminal: transport.after_tool.records[0]?.record?.notify_on_terminal,
          foreground_and_revival_chars: transport.after_tool.persisted_completions.reduce((sum, item) => sum + item.chars, 0),
          background_chars: notification.after_tool.persisted_completions.reduce((sum, item) => sum + item.chars, 0),
          observation: 'A foreground-created task retains notify_on_terminal=false across its revivals on this build; the mod cannot assume the engine delivers their full analysis.',
        },
        cleanup_verified: retirementClean,
        adversarial: {
          misleading_success_output: 'Decision derives from structured native results, task snapshots and effective HTTP schemas, never success prose.',
          stale_state: 'A fresh disposable home and work directory are created for each variant.',
          hung_commands: 'Owned 150-second process and bounded observation deadlines; no consult semantics deadline.',
          cancel_resume: 'Outer abort measured with a held oracle provider stream.',
          flaky: 'Five same-id consecutive revivals retained individually, including refusals.',
          others: 'N/A: this capability probe does not install, gate, edit product files, or use external messages.',
        },
      };
      if (exclusive) {
        const rootOnly = rawOracle(variants[2]);
        const profileOnly = rawOracle(variants[5]);
        const rootWorks = JSON.stringify(rootOnly) === JSON.stringify(restricted);
        const profileWorks = JSON.stringify(profileOnly) === JSON.stringify(restricted);
        report.policy.paths = rootWorks ? ['[native].agents.oracle.tools']
          : profileWorks ? [`profiles.${activeProfile}.[native].agents.oracle.tools`]
            : [`profiles.${activeProfile}.[native].agents.oracle.tools`, '[native].agents.oracle.tools'];
        report.policy.path_scope = 'Smallest sufficient user-config delta in the tested engine views; project policy can expand the merged surface and must be checked separately.';
      }
      report.decision = decideProbe(report);
      report.status = 'passed';
      report.exit_code = 0;
      receipt.report = report;
      writeJson(join(evidenceDir, 'probe-report.json'), report);
      assert.equal(retirementClean, true, 'Every owned task must be terminal and non-resident before host shutdown.');
      Object.assign(receipt, { status: 'passed', exit_code: 0 });
    }
  } catch (error) {
    receipt.status = 'failed'; receipt.exit_code = 1;
    receipt.error = { code: error.code ?? 'probe_failed', message: error.message, stack: error.stack };
  } finally {
    await mock.close();
    receipt.auth_after = authHashes();
    if (usesRealOracle) finalizeAuthGuard(receipt, attemptDir);
    const safety = readJson(join(attemptDir, 'real-model-safety.json'));
    receipt.real_model_guard_blocked = safety.blocked;
    receipt.real_oracle_runs_for_attempt = safety.real_oracle_runs;
    receipt.completed_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    if (receipt.report) {
      if (usesRealOracle) {
        receipt.report.auth_after = receipt.auth_after;
        receipt.report.auth_guard_passed = receipt.auth_guard_passed;
      } else {
        (receipt.report.supplemental_auth_checks ??= []).push({
          case: values.case, auth_before: before, auth_after: receipt.auth_after,
          auth_guard_passed: null, real_oracle_runs: 0,
        });
      }
      receipt.report.real_model_qa_guard = {
        blocked: safety.blocked, real_oracle_runs: safety.real_oracle_runs,
        error: safety.blocked ? 'Credential hashes changed; further real-model QA requires owner decision.' : null,
        baseline: safety.auth_baseline, last_hashes: safety.last_hashes,
      };
      writeJson(join(evidenceDir, 'probe-report.json'), receipt.report);
    }
    if (values.case === 'probe-dead-target') writeJson(join(evidenceDir, 'probe-dead-target.json'), receipt);
    console.log(JSON.stringify({ case: values.case, status: receipt.status, exit_code: receipt.exit_code, run_dir: runDir, error: receipt.error }));
    process.exitCode = receipt.exit_code;
  }
}
