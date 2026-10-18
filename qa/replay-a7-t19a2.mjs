import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateVerdict, verdictSpec } from './verdict-spec.mjs';
import { scenarioFacts, sameScope, toolData, oracleDispatches } from './scenario-verdict.mjs';
import { checkNudgeEpisodes } from './verdict-primary.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const normalized = path => typeof path === 'string' ? path.replace(/\\/g, '/').toLowerCase() : '';
const samePath = (left, right) => Boolean(normalized(left)) && normalized(left) === normalized(right);
const channels = {
  consult: 'oracle-qa.consult', transport: 'oracle-qa.transport', stop: 'oracle-qa.stop',
  nudge: 'oracle-qa.nudger', seed: 'oracle-qa.seed', lifecycle: 'oracle-qa.lifecycle',
  policy: 'oracle-qa.policy',
};
function familyOf(name) {
  if (name.startsWith('consult-')) return 'consult';
  if (name.startsWith('resident-')) return 'transport';
  if (name.startsWith('stop-')) return 'stop';
  if (name.startsWith('nudge-')) return 'nudge';
  if (name.startsWith('seed-')) return 'seed';
  if (name === 'lifecycle') return 'lifecycle';
  if (name === 'trigger-real') return 'trigger';
  if (['oracle-profile-switch', 'oracle-project-override-write'].includes(name)) return 'policy-static';
  if (name.startsWith('oracle-')) return 'policy';
  if (name.startsWith('acceptance')) return 'acceptance';
  return 'unknown';
}
const auxiliaryFields = [
  // External file/config/task-store observations are not emitted by the scenario
  // observer. Never copy its cached event/proof arrays or any prior verdict.
  'oracle_mode', 'main_mode', 'retired_records', 'mock_oracle_runs', 'mock_provider_calls',
  'receipts', 'fixture_after', 'settle', 'file_exists', 'image_path', 'image_sha256',
  'config_evidence', 'schema_diagnostics', 'project_override',
  'dry_run_with_override', 'refusal', 'profile_evidence', 'switches',
  'unsafe_switched_profile', 'repaired_switched_profile', 'all_profiles_repair',
  'all_profiles_dry_run', 'real_oracle_runs', 'disabled_receipts',
];

// Pure: all I/O is supplied by the caller, and no object owned by that caller is
// mutated. Ordered stdout is a pointer envelope, not a product proof. The raw
// probe (or named RPC extension stream) supplies the scenario events.
export function adaptA7Evidence({ caseName, orderedText, receipt = {}, sources = [] }) {
  const diagnostics = [], family = familyOf(caseName);
  const issue = (code, message, extra = {}) =>
    diagnostics.push({ code, severity: 'error', message, ...extra });
  const parseLines = (text, source) => {
    if (typeof text !== 'string') {
      issue('raw_source_missing', 'Recorded source is missing.', { source });
      return [];
    }
    const records = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          issue('raw_record_shape', 'A JSON object was required.', { source, line: index + 1 });
        } else records.push(record);
      } catch (error) {
        issue('raw_json_malformed', error.message, { source, line: index + 1 });
      }
    }
    return records;
  };
  const ordered = parseLines(orderedText, 'ordered');
  const streams = { stdout: '', stderr: '' };
  let previous = -1;
  for (const [index, record] of ordered.entries()) {
    if (!Number.isInteger(record.sequence) || record.sequence <= previous ||
      !['stdout', 'stderr'].includes(record.stream) || typeof record.text !== 'string' ||
      typeof record.timestamp !== 'string') {
      issue('ordered_record_shape', 'Expected increasing sequence, stream, text and timestamp.',
        { source: 'ordered', line: index + 1 });
      continue;
    }
    previous = record.sequence;
    streams[record.stream] += record.text;
  }
  if (!ordered.length) issue('ordered_log_empty', 'No ordered driver records were observed.');
  const pointers = parseLines(streams.stdout, 'ordered.stdout');
  if (pointers.length !== 1 || typeof pointers[0]?.receipt !== 'string') {
    issue('driver_pointer_missing', 'Exactly one recorded stdout receipt pointer is required.');
  }
  const pointer = pointers[0];
  if (pointer?.case !== undefined && pointer.case !== caseName) {
    issue('case_identity_mismatch', 'The stdout case differs from the enumerated case.');
  }
  for (const candidate of [receipt.case, receipt.native_receipt?.case]) {
    if (candidate !== undefined && candidate !== caseName) {
      issue('case_identity_mismatch', 'The receipt case differs from the enumerated case.');
    }
  }
  if (pointer?.receipt && ![receipt.artifact, receipt.native_receipt_path]
    .some(path => samePath(path, pointer.receipt))) {
    issue('receipt_pointer_mismatch', 'The raw stdout pointer does not identify this receipt.');
  }
  const native = receipt.native_receipt ?? {};
  const observation = { case: caseName };
  const auxiliary = [];
  for (const key of auxiliaryFields) if (Object.hasOwn(native, key)) {
    observation[key] = structuredClone(native[key]);
    auxiliary.push(key);
  }
  if (family === 'acceptance') {
    // Only native child/setup operands are auxiliary proof. A variant's cached
    // events, scenario checks, status and verdict are deliberately not copied.
    observation.setup = {
      real_provider_calls: native.real_provider_calls,
      real_oracle_runs: native.real_oracle_runs,
      variants: (native.variants ?? []).map(variant => {
        const source = sources.find(source => samePath(source.path, variant.evidence));
        let raw = variant;
        if (source) {
          try {
            raw = JSON.parse(source.text);
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected setup object.');
          } catch (error) {
            issue('setup_source_malformed', error.message, { source: source.path });
            raw = {};
          }
        }
        return {
          name: variant.name, source: source?.path ?? 'native-child-metadata',
          provider_calls: Array.isArray(raw.provider_calls) ? raw.provider_calls.length : null,
          main_usage: Array.isArray(raw.main_usage) ? raw.main_usage.length : null,
          children: (raw.children ?? []).map(child => Object.fromEntries(
            ['argv', 'cwd', 'pid', 'exit_code', 'signal', 'timed_out', 'spawn_error', 'qa_label']
              .filter(key => Object.hasOwn(child, key)).map(key => [key, structuredClone(child[key])]))),
        };
      }),
    };
    auxiliary.push('setup');
  }
  const declared = receipt.raw_logs?.retained_host_event_logs ?? [];
  const parsed = [];
  for (const path of declared.filter(path => /(?:probe|receipts)\.jsonl$|host\.stdout\.log$/i.test(path))) {
    const matches = sources.filter(source => samePath(source.path, path));
    if (matches.length !== 1) {
      issue('raw_source_missing', 'Expected one retained raw source.', { source: path });
      continue;
    }
    parsed.push({ path, records: parseLines(matches[0].text, path) });
  }
  const probes = parsed.filter(source => /probe\.jsonl$/i.test(source.path));
  const rpc = parsed.filter(source => /host\.stdout\.log$/i.test(source.path))
    .flatMap(source => source.records);
  if (probes.length > 1) issue('raw_source_ambiguous', 'More than one scenario probe was retained.');
  let events = probes.length === 1 ? probes[0].records : rpc
    .filter(record => record.type === 'extension_event' && record.name === channels[family])
    .map(record => record.data);
  events = structuredClone(events).filter((event, index) => {
    if (event && typeof event === 'object' && typeof event.event === 'string') return true;
    issue('raw_event_shape', 'A named scenario event was required.', { index });
    return false;
  });
  observation.events = events;
  observation.provider_calls = events.filter(event => event.event === 'provider_request');
  const accounting = parsed.find(source => /receipts\.jsonl$/i.test(source.path));
  if (accounting) {
    observation.receipts = structuredClone(accounting.records);
    auxiliary.splice(auxiliary.indexOf('receipts'), auxiliary.includes('receipts') ? 1 : 0);
  }
  const command = args => events.findLast(event => event.event === 'command' && event.args === args);
  const ended = command('end');
  const beforeEnd = events.findIndex(event => event.kind === 'command_start' &&
    event.name === 'oracle' && event.args === 'end');
  const current = beforeEnd < 0 ? events : events.slice(0, beforeEnd);
  const snapshot = rpc.filter(record => record.type === 'response' &&
    record.command === 'extension_request' && record.success && record.data?.state &&
    (Array.isArray(record.data.native_calls) || Array.isArray(record.data.nativeCalls)))
    .findLast(record => record.data.state.job?.status !== 'closed');
  if (ended) observation.ended = ended;
  const owned = ended?.state?.job?.oracle_task_ids;
  if (Array.isArray(owned)) {
    observation.retired_records = owned.map(id => {
      const last = events.findLast(event => event.event === 'evidence' && event.kind === 'executed' &&
        event.name === 'task_output' &&
        (event.result?.structuredContent ?? event.result?.details)?.snapshot?.task_id === id);
      return last ? (last.result.structuredContent ?? last.result.details).snapshot :
        observation.retired_records?.find(record => record.task_id === id);
    }).filter(Boolean);
  }
  if (family === 'consult') {
    observation.consults = events.filter(event => event.event === 'consult_result');
    observation.status_before_end = snapshot?.data;
  } else if (family === 'transport') {
    observation.decision = events.find(event => event.event === 'ready')?.decision;
    observation.consults = events.filter(event => event.event === 'consult_result');
    observation.before_end = snapshot?.data;
    observation.status_command = command('status');
    observation.status_message = events.filter(event => event.event === 'visible')
      .map(event => event.message).findLast(message => message?.customType === 'oracle-advisor-status');
  } else if (family === 'stop') {
    // The unkeyed `tool` summary is not used as a substitute for the executed
    // result. Keep the actual observer call ID, parent and immutable envelope.
    const executed = name => events.find(event =>
      event.event === 'evidence' && event.kind === 'executed' && event.name === name);
    observation.consult = executed('oracle_consult');
    observation.disposition = executed('oracle_record_stop');
    observation.blocked = events.filter(event => event.event === 'blocked');
    observation.operations = events.filter(event => event.event === 'operation_result');
    observation.state = current.findLast(event => event.state)?.state;
  } else if (family === 'nudge') {
    observation.snapshot = snapshot?.data;
    observation.operations = events.filter(event => event.event === 'operation_result');
  } else if (family === 'seed') {
    const fixtures = args => events.filter(event => event.event === 'fixture' && event.args === args);
    const skills = fixtures('skill');
    const marker = events.findLastIndex(event => event.event === 'fixture' && event.args === 'model-window');
    const model = events.slice(marker + 1).find(event => event.event === 'tool_result');
    observation.proofs = {
      bound: skills[0],
      status: events.find(event => event.event === 'command' && event.args === 'status')?.result,
      reload: events.filter(event => event.event === 'session_start')[1],
      invalid_inputs: ['missing', 'ambiguous', 'quoting'].map(input => ({
        input, ...fixtures(input)[0],
      })),
      unchanged: skills[1], rebound: fixtures('other')[0], held: fixtures('hold')[0],
      refused: skills[2], override: events.find(event =>
        event.event === 'command' && event.args.startsWith('override ')),
      final_binding: skills[3], model_tool_call: model,
      model_status: current.findLast(event => event.event === 'command' && event.args === 'status')?.result,
      supplied_seed_drift: fixtures('drift')[0], ended: ended?.state,
    };
  } else if (family === 'lifecycle') {
    observation.initial = events.find(event => event.event === 'session_start');
    observation.tool_calls = rpc.filter(record => record.type === 'message_end' &&
      record.message?.role === 'assistant').flatMap(record =>
      (record.message.content ?? []).filter(part => part.type === 'toolCall'));
  } else if (family === 'trigger') {
    observation.records = events;
    // Case expectations belong to the scenario, not the observed summary.
    observation.shell = 'bash';
    observation.requested_exit_codes = [1, 1];
    observation.expected_triggers = 1;
    observation.shell_args = events.filter(event =>
      event.event === 'tool_call' && event.tool_name === 'bash').map(event => event.input);
  } else if (family === 'policy') {
    const result = events.find(event => event.event === 'result');
    observation.observation = result;
    observation.child_task_id = result?.id;
    observation.preflight = result?.preflight;
    observation.oracle_task_status = (result?.outcome?.result?.structuredContent ??
      result?.outcome?.result?.details)?.status;
    const childPaths = declared.filter(path => /task-state[\\/]children[\\/][^\\/]+[\\/]sessions[\\/].*\.jsonl$/i.test(path));
    observation.child_entries = [];
    for (const path of childPaths) {
      if (!normalized(path).includes(`/children/${normalized(result?.id)}/sessions/`)) {
        issue('child_identity_mismatch', 'Child session path differs from the observed task.', { source: path });
        continue;
      }
      const source = sources.find(source => samePath(source.path, path));
      observation.child_entries.push(...parseLines(source?.text, path));
    }
    if (!childPaths.length) issue('raw_source_missing', 'No retained owned child session.');
    const answer = observation.child_entries.findLast(entry => entry.message?.role === 'assistant' &&
      (entry.message.content ?? []).some(part => part.type === 'text' && part.text?.trim()));
    observation.oracle_response = (answer?.message.content ?? [])
      .filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    observation.child_tool_calls = observation.child_entries.filter(entry => entry.message?.role === 'assistant')
      .flatMap(entry => entry.message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name);
    const schemasPath = native.run_dir && join(native.run_dir, 'real-provider-schemas.json');
    const schemas = sources.find(source => samePath(source.path, schemasPath));
    try {
      observation.oracle_requests = JSON.parse(schemas?.text);
      if (!Array.isArray(observation.oracle_requests)) throw new Error('Expected a provider schema array.');
    } catch (error) {
      observation.oracle_requests = [];
      issue('provider_schema_missing', error.message, { source: schemasPath ?? null });
    }
    observation.actual_oracle_tools = observation.oracle_requests.find(request => request.purpose === 'oracle_agent')?.tools;
    const retirement = rpc.find(record => record.type === 'response' && record.command === 'extension_request' &&
      record.success && record.data?.retired?.some(item => item.id === result?.id));
    observation.retirement = retirement?.data;
    observation.retired_tasks = retirement?.data.retired.map(item => item.output.details?.snapshot);
  } else if (family === 'policy-static') {
    observation.oracle_requests = [];
    diagnostics.push({ code: 'auxiliary_configuration_proof', severity: 'info',
      message: 'This non-host case uses captured configuration operands; stdout proves no tool execution.' });
  }
  if (!events.length && family !== 'policy-static') {
    diagnostics.push({ code: 'scenario_events_missing', severity: 'error',
      message: 'No authoritative raw scenario events were reached.' });
  }
  return { observation, diagnostics, schema: {
    family, ordered_records: ordered.length, driver_pointers: pointers.length,
    ordered_shape: 'sequence,stream,text,timestamp',
    authority: probes.length === 1 ? 'probe-jsonl' : events.length ? 'rpc-extension' : 'none',
    scenario_events: events.length,
    evidence_kinds: Object.fromEntries([...new Set(events.filter(event => event.event === 'evidence')
      .map(event => event.kind))].map(kind =>
      [kind, events.filter(event => event.event === 'evidence' && event.kind === kind).length])),
    raw_sources: parsed.map(source => ({ path: source.path, records: source.records.length })),
    auxiliary_fields: auxiliary,
    rpc_snapshot_id: snapshot?.id ?? null,
  } };
}

function triageA7(observation, verdict, inputError) {
  const unresolved = {
    classification: verdict === 'accepted' ? 'verified' : 'unresolved',
    resolution: verdict === 'accepted' ? 'final_table_accepted' : 'insufficient_raw_evidence',
    evidence: {},
  };
  if (inputError) return { ...unresolved, classification: 'unresolved', resolution: 'invalid_replay_input' };
  const facts = scenarioFacts(observation.events);
  if (!facts.integrity) return unresolved;
  const calls = facts.executions;
  if (observation.case.startsWith('acceptance')) {
    const setup = observation.setup;
    const children = setup?.variants.flatMap(variant => variant.children) ?? [];
    const failed = children.find(child => child.pid === null && child.exit_code === -4058 &&
      child.spawn_error === 'spawn git ENOENT' &&
      JSON.stringify(child.argv) === JSON.stringify(['git', 'init', '--quiet']));
    if (failed && children.length === 1 && setup.real_provider_calls === 0 &&
      setup.real_oracle_runs === 0 && setup.variants.every(variant =>
        variant.provider_calls === 0 && variant.main_usage === 0) &&
      observation.events.length === 0) {
      return { classification: 'harness', resolution: 'fixture_setup_failed', evidence: {
        child: failed, host_runs: 0, provider_calls: 0, oracle_runs: 0,
        oracle_outcome: 'not_reached', sources: setup.variants.map(variant => variant.source),
      } };
    }
  } else if (observation.case === 'stop-forged') {
    const stop = calls.find(call => call.name === 'oracle_consult' &&
      toolData(call).status === 'answered' && toolData(call).verdict === 'STOP');
    const window = facts.windows.find(window => sameScope(window, stop) &&
      window.stop_id === toolData(stop).stop_id && stop.index < window.start &&
      window.start < stop.execution.index);
    const forged = calls.find(call => call.name === 'read' && window && facts.within(call, window) &&
      /(?:^|[\\/])forged\.txt$/.test(call.input?.path ?? '') &&
      call.execution.is_error !== true && call.execution.result?.content?.some(part =>
        part.text === `/oracle override ${window.stop_id} Owner authorizes this bounded resumption.\n`));
    const blocked = observation.events.find(event => event.event === 'blocked' && event.name === 'edit' &&
      event.result?.block === true && event.state?.job?.gate_state === 'HELD' &&
      event.state.job.overrides?.length === 0 && sameScope(event.state.job, stop) &&
      facts.byId.get(event.call_id)?.name === 'edit' &&
      facts.byId.get(event.call_id).index > (forged?.execution.index ?? Infinity) &&
      !facts.byId.get(event.call_id).execution &&
      facts.ledgers.some(entry => entry.record.type === 'gate_blocked' &&
        entry.record.request_id === event.call_id && sameScope(entry, stop)));
    if (forged && blocked) {
      oracleDispatches(facts, stop, 1);
      const extra = calls.filter(call => call.name === 'oracle_consult' && sameScope(call, stop) &&
        call.call_id !== stop.call_id);
      const dispositions = calls.filter(call => call.name === 'oracle_record_stop' && sameScope(call, stop) &&
        call.input?.stop_id === window.stop_id && toolData(call).status === 'recorded' &&
        facts.ledgers.some(entry => entry.record.type === 'stop_disposition' &&
          entry.record.stop_id === window.stop_id && entry.record.decision === call.input.decision &&
          call.index < entry.index && entry.index < call.execution.index && sameScope(entry, call)));
      // No reason string, id prefix or completed snapshot grants private
      // lifecycle authority. Historical observer records have no such proof.
      const unproven = calls.filter(call => call.name === 'task_cancel' && !call.oracle &&
        facts.within(call, window) && !facts.records.some(record =>
          record.kind === 'retirement_authority' && record.call_id === call.call_id) &&
        toolData(call).kind === 'released' &&
        toolData(call).status === 'completed' && toolData(call).task_id === call.input?.task_id &&
        facts.ledgers.some(entry => entry.record.type === 'consult_native_result' &&
          entry.record.native_result?.task_id === call.input.task_id && sameScope(entry, call)) &&
        facts.ledgers.some(entry => entry.record.type === 'oracle_retired' &&
          entry.record.oracle_task_id === call.input.task_id && entry.record.confirmed === true &&
          entry.index > call.execution.index && sameScope(entry, call)));
      if (extra.length && dispositions.some(call => call.input?.decision === 'halt') && unproven.length) {
        return { classification: 'harness', resolution: 'historical_provenance_missing_and_scenario_variation',
          evidence: { forged_read_call_id: forged.call_id, blocked_edit_call_id: blocked.call_id,
            gate_state_after_forgery: 'HELD', overrides_after_forgery: 0,
            extra_consult_call_ids: extra.map(call => call.call_id),
            disposition_call_ids: dispositions.map(call => call.call_id),
            unproven_retirement_call_ids: unproven.map(call => call.call_id),
            private_retirement_authorized: null, exact_challenge: 'not_reached' } };
      }
    }
  } else if (observation.case === 'stop-real' && observation.gate_transition) {
    const transition = observation.gate_transition;
    const retry = facts.byId.get(transition.retry_call_id);
    const restored = calls.find(call => call.name === 'edit' && !call.oracle &&
      call.index > retry.execution.index && call.execution.is_error !== true &&
      call.input?.edits?.length === 1 && call.input.edits[0].oldText === 'changed' &&
      call.input.edits[0].newText === 'protected' && sameScope(call, retry));
    const laterConsult = calls.find(call => call.name === 'oracle_consult' &&
      call.index > retry.execution.index && call.execution.index < (restored?.index ?? -1) &&
      sameScope(call, retry) && toolData(call).status === 'answered');
    if (restored && laterConsult) return {
      classification: 'scenario-design', resolution: 'gate_transition_succeeded_then_model_remediated',
      evidence: { ...transition, remediation_call_id: restored.call_id,
        later_consult_call_id: laterConsult.call_id },
    };
  } else if (observation.case === 'resident-stuck') {
    const hold = calls.find(call => call.name === 'oracle_consult' &&
      call.input?.question === 'QA_TRANSPORT_HOLD' && toolData(call).status === 'answered' &&
      call.execution.is_error !== true);
    const cancellation = facts.commands.some(command => command.name === 'oracle' && command.args === 'cancel');
    const controlledHold = observation.events.some(event => event.event === 'held' || event.kind === 'provider_hold');
    if (hold && observation.oracle_mode === 'real' && observation.mock_provider_calls?.length === 0 &&
      !controlledHold && !cancellation && !calls.some(call => call.name === 'task_cancel' &&
        toolData(call).status === 'cancelled')) {
      oracleDispatches(facts, hold, 1);
      return { classification: 'scenario-design', resolution: 'controlled_hold_not_reached',
        evidence: { hold_consult_call_id: hold.call_id, oracle_status: toolData(hold).status,
          mock_provider_calls: 0, controlled_hold: false, owner_cancel: false } };
    }
  } else if (observation.case === 'nudge-real') {
    const episodes = checkNudgeEpisodes(observation, facts, { host: true });
    const completions = observation.snapshot.state.job.nudges.filter(nudge => nudge.kind === 'completion');
    const missing = episodes.flatMap(episode => episode.call_ids).map(id => facts.byId.get(id))
      .filter(call => call.execution.is_error === true &&
        call.execution.result?.content?.some(part => /node: command not found/.test(part.text ?? '') &&
          /Command exited with code 127/.test(part.text ?? '')));
    const preflight = observation.events.some(event => event.event === 'executable_preflight' &&
      event.exit_code === 0);
    if (episodes.length === 2 && completions.length === 1 && missing.length === 2 && !preflight &&
      new Set(episodes.map(episode => episode.operation_key)).size === 2) {
      return { classification: 'harness', resolution: 'executable_setup_and_real_recovery_variation',
        evidence: { episodes, failure_notices: 2, completion_notices: 1, total_notices: 3,
          caps_preserved: true, executable_preflight: false,
          missing_executable_call_ids: missing.map(call => call.call_id) } };
    }
  }
  return unresolved;
}

export function replayA7Case(input, options = {}) {
  let adapted;
  try { adapted = adaptA7Evidence(input); }
  catch (error) {
    // One malformed case must neither omit that case nor stop the other logs.
    // Even here the final table sees an empty observation and adjudicates it.
    adapted = { observation: { case: input.caseName, events: [] },
      diagnostics: [{ code: 'adapter_input_malformed', severity: 'error', message: error.message,
        error_type: error.name }],
      schema: { family: familyOf(input.caseName), ordered_records: 0, driver_pointers: 0,
        authority: 'none', scenario_events: 0, raw_sources: [], auxiliary_fields: [] } };
  }
  const { observation, diagnostics, schema } = adapted;
  const clause_ids = verdictSpec.filter(row => row.cases.includes(input.caseName)).map(row => row.id);
  let failure;
  try {
    evaluateVerdict(input.caseName, observation, { ...options, real: true, host: true,
      oracle: observation.oracle_mode, down: input.caseName === 'acceptance-oracle-down' });
  } catch (error) {
    failure = error;
    diagnostics.push({
      code: error.code === 'scenario_not_reached' ? error.code :
        error.code === 'ERR_ASSERTION' ? 'predicate_rejected' : 'evaluator_error',
      severity: 'error', message: error.message, phase: error.verdict_phase ?? null,
      clause_id: error.verdict_row ?? null, error_type: error.name,
    });
  }
  const inputError = diagnostics.some(item => item.severity === 'error' &&
    !['scenario_events_missing', 'scenario_not_reached', 'predicate_rejected',
      'evidence_shape_incomplete', 'evaluator_error'].includes(item.code));
  const verdict = inputError ? 'reject' : failure
    ? failure instanceof TypeError ? 'reject'
      : failure.code === 'scenario_not_reached' || failure.verdict_phase === 'admission'
        ? 'scenario_not_reached' : 'reject'
    : diagnostics.some(item => item.severity === 'error') ? 'scenario_not_reached' : 'accepted';
  let triage;
  try { triage = triageA7(observation, verdict, inputError); }
  catch (error) {
    triage = { classification: 'unresolved', resolution: 'raw_triage_not_proven',
      evidence: {}, diagnostic: { message: error.message, error_type: error.name } };
  }
  return { case: input.caseName, verdict, clause_ids,
    completed_clause_ids: (observation.verdict_rows ?? []).map(row => row.id),
    evaluator: { invoked: true, stage: 'final', host: true, real: true,
      failed_clause_id: failure?.verdict_row ?? null, phase: failure?.verdict_phase ?? null },
    diagnostics, schema, triage, observation: {
      ...(observation.gate_transition ? { gate_transition: observation.gate_transition } : {}),
      ...(observation.nudge_episodes ? { nudge_episodes: observation.nudge_episodes } : {}),
    } };
}

function orderedPaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? orderedPaths(join(directory, entry.name)) :
      entry.name.endsWith('.ordered.jsonl') ? [join(directory, entry.name)] : []);
}

export function replayA7(directory, { skill, expectedTools } = {}) {
  const root = resolve(directory);
  const summary = JSON.parse(readFileSync(join(root, 'batch-summary.json'), 'utf8'));
  const paths = orderedPaths(root);
  const cases = new Map(paths.map(path => [normalized(path), {
    case: path.replace(/\\/g, '/').split('/').at(-1).replace(/\.ordered\.jsonl$/, ''),
    raw_log: path, artifact: path.replace(/\.ordered\.jsonl$/, '.json'),
  }]));
  for (const item of summary.cases) cases.set(normalized(item.raw_log), {
    case: item.case, raw_log: item.raw_log, artifact: item.artifact,
  });
  const results = [];
  for (const item of cases.values()) {
    const diagnostics = [];
    const load = path => {
      if (!normalized(path).startsWith(normalized(root) + '/')) {
        diagnostics.push({ code: 'source_outside_batch', severity: 'error', source: path ?? null,
          message: 'Replay reads only this retained batch.' });
        return null;
      }
      try { return readFileSync(path, 'utf8'); }
      catch (error) {
        diagnostics.push({ code: 'raw_source_missing', severity: 'error', source: path,
          message: error.message });
        return null;
      }
    };
    const orderedText = load(item.raw_log);
    let receipt = {};
    try {
      receipt = JSON.parse(load(item.artifact));
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        throw new Error('Expected a receipt object.');
      }
    }
    catch (error) {
      receipt = {};
      diagnostics.push({ code: 'receipt_json_malformed', severity: 'error', message: error.message });
    }
    // Receipt paths are a catalog only. The adapter verifies the stdout pointer
    // and case; it never reads pass, status, coverage or historical clause IDs.
    receipt.artifact ??= item.artifact;
    const sourcePaths = (Array.isArray(receipt.raw_logs?.retained_host_event_logs)
      ? receipt.raw_logs.retained_host_event_logs : []).filter(path =>
      /(?:probe|receipts)\.jsonl$|host\.stdout\.log$|task-state[\\/]children[\\/].*[\\/]sessions[\\/].*\.jsonl$/i.test(path));
    if (familyOf(item.case) === 'acceptance') {
      for (const variant of receipt.native_receipt?.variants ?? []) {
        if (typeof variant.evidence === 'string') sourcePaths.push(variant.evidence);
      }
    }
    if (familyOf(item.case) === 'policy' && receipt.native_receipt?.run_dir) {
      sourcePaths.push(join(receipt.native_receipt.run_dir, 'real-provider-schemas.json'));
    }
    const sources = [...new Set(sourcePaths)].map(path => ({ path, text: load(path) }));
    const result = replayA7Case({ caseName: item.case, orderedText, receipt, sources },
      { skill, expectedTools });
    if (diagnostics.length) {
      result.diagnostics.push(...diagnostics);
      result.verdict = 'reject';
    }
    results.push({ ...result, raw_log: item.raw_log, artifact: item.artifact });
  }
  return { schema_version: 1, generated_at: new Date().toISOString(),
    evaluator: 'qa/verdict-spec.mjs#evaluateVerdict', model_runs: 0, host_runs: 0,
    coverage: { summary_cases: summary.cases.length, discovered_ordered_logs: paths.length,
      replayed_cases: results.length, ordered_records: results.reduce((n, item) => n + item.schema.ordered_records, 0),
      families: [...new Set(results.map(item => item.schema.family))].sort(),
      verdict_counts: Object.fromEntries(['accepted', 'reject', 'scenario_not_reached']
        .map(verdict => [verdict, results.filter(item => item.verdict === verdict).length])) },
    entries: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = process.argv[2] ? resolve(process.argv[2]) : join(root, '.omo/evidence/a7');
  const result = replayA7(directory, {
    skill: readFileSync(join(root, 'test/fixtures/seed-skill.yaml'), 'utf8'),
    expectedTools: Object.keys(READONLY_ORACLE_TOOLS)
      .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort(),
  });
  result.evaluator_sha256 = Object.fromEntries(
    ['verdict-spec', 'scenario-verdict', 'verdict-primary', 'verdict-aux', 'verdict-policy'].map(name =>
      [`qa/${name}.mjs`, createHash('sha256').update(readFileSync(join(root, `qa/${name}.mjs`))).digest('hex')]));
  const output = join(directory, 'replay-t19a2.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...result.coverage }));
}
