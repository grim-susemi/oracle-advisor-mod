import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import { canonicalJson, classifyOutcome } from '../src/triggers.mjs';
import { typedError } from './harness.mjs';
import { fixtureShellCommand } from './fixture-executable.mjs';

// Independent copy of the plan's explicit gate contract, not the implementation
// under test. Every unlisted name (including wrappers and new mutators) is gated.
const allowedWhileHeld = new Set([
  'read', 'find', 'grep', 'ls', 'lsp_diagnostics', 'lsp_goto_definition',
  'lsp_find_references', 'lsp_symbols', 'lsp_prepare_rename',
  'oracle_consult', 'oracle_record_stop', 'oracle_advisor', 'brief', 'plan_brief',
  'question', 'request_user_input', 'task_output', 'task_cancel',
  'coordination_inspect', 'coordination_notify',
]);
export const toolData = call => call?.execution?.result?.structuredContent ??
  call?.execution?.result?.details ?? {};
export const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();

export const sameScope = (left, right) => Boolean(left && right &&
  left.job_id === right.job_id && left.job_epoch === right.job_epoch);

export function scenarioFacts(events = []) {
  const records = events.map((event, index) => ({ ...event, index })).filter(event => event.event === 'evidence');
  const calls = [], byId = new Map(), commands = [], ledgers = [], errors = [];
  const epochs = new Map();
  let active = false, jobId = null, epoch = null;
  const current = () => ({ job_id: jobId, job_epoch: epoch });
  const scope = (data, fallback = current()) => {
    const id = Object.hasOwn(data, 'job_id') ? data.job_id : fallback.job_id;
    return { job_id: id, job_epoch: Object.hasOwn(data, 'job_epoch') ? data.job_epoch
      : id === fallback.job_id ? fallback.job_epoch : epochs.get(id) ?? null };
  };
  const invalid = label => errors.push(label);
  for (const record of records) {
    if (record.kind === 'ledger') {
      const packet = record.record;
      for (const data of [packet, ...(packet.events ?? [])]) {
        if (data.type === 'job_opened') {
          jobId = data.job_id; epoch = data.job_epoch ?? 1;
          if (typeof jobId !== 'string' || !jobId || !Number.isSafeInteger(epoch) || epoch < 1) invalid('invalid_job_identity');
          epochs.set(jobId, epoch); active = true;
        } else if (data.type === 'job_resumed' && epochs.has(data.job_id)) {
          jobId = data.job_id; epoch = data.job_epoch ?? epochs.get(jobId); active = true;
          epochs.set(jobId, epoch);
        } else if (data.type === 'seed_bound' && data.job_id === jobId &&
            data.job_epoch !== undefined) {
          epoch = data.job_epoch; epochs.set(jobId, epoch);
        }
        const identity = scope(data, scope(packet));
        ledgers.push({ ...record, ...identity, record: data });
        if (sameScope(identity, current())) {
          if (data.type === 'job_resumed') active = true;
          if (['job_ended', 'job_paused'].includes(data.type)) active = false;
        }
      }
    } else if (record.kind === 'attempt') {
      if (typeof record.call_id !== 'string' || !record.call_id || byId.has(record.call_id)) invalid('duplicate_or_missing_call_id');
      const identity = scope(record);
      if (identity.job_id !== null && (!Number.isSafeInteger(identity.job_epoch) || identity.job_epoch < 1)) invalid('invalid_call_epoch');
      if (!sameScope(identity, current())) invalid('attempt_scope_mismatch');
      const call = { ...record, ...identity, parent_id: record.parent_id ?? null, active, oracle: false };
      if (call.parent_id !== null && (typeof call.parent_id !== 'string' || !call.parent_id)) invalid('invalid_parent_identity');
      calls.push(call); byId.set(record.call_id, call);
    } else if (record.kind === 'executed') {
      const call = byId.get(record.call_id);
      if (!call || call.execution || call.name !== record.name) invalid('unmatched_execution');
      else {
        const identity = scope(record, call);
        if (!sameScope(identity, call) || (record.parent_id ?? null) !== call.parent_id) invalid('execution_identity_mismatch');
        call.execution = { ...record, ...identity, parent_id: record.parent_id ?? null };
      }
    } else if (record.kind === 'command_start') {
      if (typeof record.command_id !== 'string' || !record.command_id ||
        commands.some(command => command.command_id === record.command_id)) invalid('duplicate_command_id');
      const identity = scope(record);
      if (!sameScope(identity, current())) invalid('command_scope_mismatch');
      commands.push({ ...record, ...identity });
    } else if (record.kind === 'command_end') {
      const matches = commands.filter(command => !command.end && command.command_id === record.command_id &&
        command.name === record.name && command.args === record.args);
      if (matches.length !== 1) invalid('unmatched_command_end');
      else {
        const identity = scope(record);
        if (!sameScope(identity, current())) invalid('command_end_scope_mismatch');
        matches[0].end = { ...record, ...identity };
      }
    }
  }
  for (const call of calls) {
    const parent = byId.get(call.parent_id);
    const validParent = !call.parent_id || parent && sameScope(parent, call) && parent.index < call.index &&
      // Admission inherits only a still-live parent. Abort may settle the child
      // after the parent's result, but cannot create a new child afterwards.
      (!parent.execution || parent.execution.index > call.index);
    if (!validParent) invalid('stale_or_cross_scope_ancestry');
    call.oracle = call.name === 'oracle_consult' || Boolean(validParent && parent?.oracle);
  }
  for (const entry of ledgers.filter(entry => entry.record.type === 'consult_admitted')) {
    const call = byId.get(entry.record.request_id);
    if (!call || call.name !== 'oracle_consult' || !sameScope(call, entry) || call.index >= entry.index ||
      ledgers.filter(other => other.record.type === 'consult_admitted' &&
        other.record.request_id === entry.record.request_id).length !== 1) invalid('admission_identity_mismatch');
  }
  for (const entry of ledgers.filter(entry => ['consult_native_result', 'consult_finished'].includes(entry.record.type))) {
    const call = byId.get(entry.record.request_id);
    if (call && (!sameScope(call, entry) || call.index >= entry.index)) invalid('request_fact_scope_mismatch');
  }
  const windows = [], unauthorizedReleases = [];
  const ownerCommand = (record, predicate) => commands.filter(command => command.name === 'oracle' &&
    predicate(command.args) && command.end && sameScope(command, record) && sameScope(command.end, record) &&
    command.index < record.index && record.index < command.end.index).length === 1;
  const stopKey = value => JSON.stringify([value.job_id, value.job_epoch, value.stop_id]);
  for (const entry of ledgers) {
    const data = entry.record;
    if (data.type === 'seed_bound' && windows.some(window =>
      window.job_id === entry.job_id && window.end === Infinity)) invalid('seed_binding_while_held');
    if (data.type === 'stop_opened') {
      const window = { start: entry.index, end: Infinity, stop_id: data.stop_id,
        job_id: entry.job_id, job_epoch: entry.job_epoch };
      if (windows.some(prior => stopKey(prior) === stopKey(window))) invalid('duplicate_stop_identity');
      windows.push(window);
    }
    if (data.type === 'stop_disposition' || data.type === 'stop_override') {
      const authorized = data.type === 'stop_disposition'
        ? calls.filter(call => call.name === 'oracle_record_stop' && sameScope(call, entry) &&
          call.input?.stop_id === data.stop_id && call.input?.decision === data.decision &&
          call.index < entry.index && call.execution?.index > entry.index &&
          toolData(call).status === 'recorded' && toolData(call).stop_id === data.stop_id).length === 1
        : ownerCommand(entry, args => args.startsWith('override ' + data.stop_id + ' '));
      if (!authorized) unauthorizedReleases.push(entry);
      else if (data.decision !== 'halt') for (const window of windows) {
        if (sameScope(window, entry) && window.stop_id === data.stop_id && window.end === Infinity) window.end = entry.index;
      }
    } else if (data.type === 'job_ended' && ownerCommand(entry, args => args === 'end')) {
      for (const window of windows) if (sameScope(window, entry) && window.end === Infinity) window.end = entry.index;
    }
  }
  const within = (call, window) => sameScope(call, window) && call.index > window.start && call.index < window.end;
  const executions = calls.filter(call => call.execution);
  const eligible = call => ['bash', 'powershell'].includes(call.name) || /(?:test|check)$/.test(call.name);
  const outcome = call => classifyOutcome({ structuredContent: call.execution.result?.structuredContent,
    isError: call.execution.is_error });
  const failures = executions.filter(call => !call.oracle && eligible(call) && outcome(call).outcome === 'failure');
  const serialFailures = failures.find((call, index) => index > 0 &&
    failures[index - 1].execution.index < call.index && sameScope(failures[index - 1], call) &&
    failures[index - 1].name === call.name && outcome(failures[index - 1]).error_class === outcome(call).error_class &&
    failures[index - 1].cwd === call.cwd && canonicalJson(failures[index - 1].input) === canonicalJson(call.input) &&
    !executions.some(other => other.index > failures[index - 1].execution.index && other.index < call.index &&
      eligible(other) && !failures.includes(other)));
  const pair = serialFailures ? [failures[failures.indexOf(serialFailures) - 1], serialFailures] : [];
  return { events, records, calls, executions, ledgers, commands, windows, unauthorizedReleases,
    integrity: errors.length === 0, integrity_errors: errors, within, pair, byId };
}

export function commandForSnapshot(facts, snapshot) {
  const index = facts.events.indexOf(snapshot);
  const matches = facts.commands.filter(command => command.end && command.args === snapshot.args &&
    (!snapshot.command || command.name === snapshot.command) &&
    command.index < index && index < command.end.index);
  assert.equal(matches.length, 1, 'Each command snapshot needs its own command identity and span.');
  for (const job of [snapshot.state?.job, snapshot.result?.job].filter(Boolean)) {
    assert.ok(sameScope(job, matches[0].end), 'Command snapshot job/epoch must match its command.');
  }
  return matches[0];
}

export function summarizedCall(facts, event, name) {
  const id = event.call_id ?? event.tool_call_id;
  assert.ok(id && (!event.call_id || !event.tool_call_id || event.call_id === event.tool_call_id));
  const call = facts.byId.get(id);
  assert.ok(call?.execution && call.name === name, 'Result summary must identify its actual executed call.');
  const data = event.result?.structuredContent ?? event.result?.details ?? event.result;
  assert.deepEqual(data, toolData(call), 'Result summary must equal its actual raw execution outcome.');
  return call;
}

export function nativeOutcome(call) {
  const execution = call.execution;
  const sources = [{ ...execution.result, isError: execution.is_error },
    execution.result?.details, execution.result?.structuredContent];
  return Object.fromEntries([
    'model_called', 'task_id', 'kind', 'status', 'code', 'error', 'reason', 'run_stats',
    'model', 'usage_status', 'input_tokens', 'output_tokens', 'reasoning_tokens',
    'provider_stop_reason', 'engine_completion_chars', 'run_epoch', 'isError',
  ].map(key => [key, sources.find(source => key === 'model_called'
    ? typeof source?.[key] === 'boolean' : source?.[key] !== undefined)?.[key]])
    .filter(([, value]) => value !== undefined));
}

export function oracleDispatches(facts, consult, expected) {
  const records = facts.ledgers.filter(entry => entry.record.request_id === consult.call_id);
  const admissions = records.filter(entry => entry.record.type === 'consult_admitted');
  const terminals = records.filter(entry => entry.record.type === 'consult_finished');
  assert.equal(admissions.length, 1, 'A consult needs one durable admission.');
  assert.equal(terminals.length, 1, 'A consult needs one durable terminal outcome.');
  assert.ok(sameScope(admissions[0], consult) && sameScope(terminals[0], consult) &&
    consult.index < admissions[0].index && admissions[0].index < terminals[0].index &&
    terminals[0].index < consult.execution.index);
  assert.equal(terminals[0].record.status, toolData(consult).status);
  const children = facts.calls.filter(call => ['task', 'task_send'].includes(call.name) &&
    call.parent_id === consult.call_id);
  assert.equal(children.length, expected, 'Each consult must own exactly its native dispatches.');
  const captures = records.filter(entry => entry.record.type === 'consult_native_result');
  assert.equal(captures.length, expected, 'Every native dispatch needs its own canonical capture.');
  for (const value of [terminals[0].record.oracle_task_id,
    ...captures.map(entry => entry.record.native_result?.task_id)]) {
    assert.ok(value == null || typeof value === 'string', 'Native identities are opaque strings or absent.');
  }
  for (const child of children) {
    assert.ok(child.execution && sameScope(child, consult) && child.name === 'task' &&
      child.input?.subagent_type === 'oracle' && child.index > consult.index &&
      child.index > admissions[0].index && child.execution.index < consult.execution.index,
    'Native dispatch belongs to this completed request.');
    const actual = toolData(child);
    const rawId = actual.task_id ?? actual.id ?? actual.snapshot?.task_id ?? null;
    assert.ok(rawId === null || typeof rawId === 'string');
    // Native pre-model refusals use both "" and null for no created task.
    const id = rawId || null;
    if (toolData(consult).status === 'answered') assert.ok(typeof id === 'string' && id,
      'Answered advice requires an identified native oracle task.');
    const matching = captures.filter(entry => sameScope(entry, child) &&
      (entry.record.native_result?.task_id || null) === id && child.execution.index < entry.index &&
      entry.index < terminals[0].index);
    assert.equal(matching.length, 1, 'Native execution and canonical capture must agree on task identity.');
    assert.deepEqual(matching[0].record.native_result, nativeOutcome(child),
      'Canonical native outcome must equal its actual immutable execution envelope.');
    if (id) assert.equal(facts.calls.filter(call => call.name === 'task' &&
      toolData(call).task_id === id).length, 1, 'Each native dispatch creates a unique task identity.');
    assert.equal(terminals[0].record.oracle_task_id || null, id);
    if (typeof actual.model_called === 'boolean') {
      assert.equal(matching[0].record.native_result.model_called, actual.model_called);
    }
  }
  return children;
}

function admissionChecks(name, observation, facts, { host = false } = {}) {
  const checks = [];
  const need = (label, value) => { checks.push({ label, reached: Boolean(value) }); return value; };
  need('fresh_observed_session', facts.records.some(record => record.kind === 'session_start' && record.entries?.length === 0));
  need('correlated_execution_log', facts.integrity);
  const calls = facts.calls;
  const executed = (tool, predicate = () => true) => facts.executions.find(call => call.name === tool && predicate(call));
  const completed = facts.records.findLast(record => record.kind === 'agent_end');
  const ordered = predicates => {
    let after = -1;
    return predicates.every(predicate => {
      const index = facts.events.findIndex((event, index) => index > after && predicate(event, index));
      if (index < 0) return false;
      after = index;
      return true;
    });
  };
  if (name.startsWith('stop-')) {
    const hold = need('STOP_hold', facts.windows[0]);
    const consult = need('STOP_consult', executed('oracle_consult', call =>
      toolData(call).verdict === 'STOP' && toolData(call).stop_id === hold?.stop_id &&
      sameScope(call, hold) &&
      call.index < hold.start && hold.start < call.execution.index));
    facts.stopConsult = consult;
    need('Seed_submission_before_STOP', executed('oracle_bind_seed', call =>
      typeof call.input?.seed_yaml === 'string' && call.job_id === consult?.job_id &&
      (sameScope(call, consult) || facts.ledgers.some(pin => pin.record.type === 'seed_bound' &&
        sameScope(pin, consult) && call.index < pin.index && pin.index < call.execution.index &&
        pin.record.seed?.hash === createHash('sha256').update(call.input.seed_yaml, 'utf8').digest('hex'))) &&
      call.execution.is_error !== true && ['seed_bound', 'seed_unchanged'].includes(toolData(call).status) &&
      call.execution.index < (consult?.index ?? -1)));
    need('active_STOP_job', consult?.active && facts.ledgers.some(record =>
      record.record.type === 'job_opened' && record.job_id === hold?.job_id &&
      record.index < hold?.start));
    const edit = need('held_edit_attempt', calls.find(call => call.name === 'edit' && call.active &&
      hold && facts.within(call, hold)));
    need('main_completion', completed && completed.index > (edit?.index ?? Infinity));
    need('challenge_begins_after_hold', hold && calls.filter(call =>
      ['edit', 'write', 'lsp_rename', 'delete', 'bash', 'powershell'].includes(call.name) && !call.oracle)
      .every(call => call.index > hold.start));
    if (name === 'stop-real') {
      need('held_rename_attempt', calls.find(call => call.name === 'lsp_rename' && hold && facts.within(call, hold)));
      const disposition = need('disposition_execution', executed('oracle_record_stop', call =>
        call.input?.stop_id === hold?.stop_id && hold && facts.within(call, hold)));
      facts.stopDisposition = disposition;
      facts.retryEdit = need('retry_after_disposition', calls.find(call => call.name === 'edit' &&
        call.index > (disposition?.execution.index ?? Infinity)));
    } else {
      need('one_consult_no_disposition_challenge', facts.calls.filter(call =>
        call.name === 'oracle_consult' && sameScope(call, consult)).length === 1 &&
        !facts.calls.some(call => call.name === 'oracle_record_stop' && sameScope(call, consult)) &&
        !facts.ledgers.some(entry => ['stop_override', 'stop_disposition'].includes(entry.record.type) &&
          sameScope(entry, consult)));
      const read = need('forged_read_execution', executed('read', call =>
        /(?:^|[\\/])forged\.txt$/.test(call.input?.path ?? '') && call.execution.is_error === false &&
        hold && facts.within(call, hold)));
      facts.forgedRead = read;
      need('one_post_STOP_read_and_edit', calls.filter(call => !call.oracle && call.name === 'read').length === 1 &&
        calls.filter(call => !call.oracle && call.name === 'edit').length === 1 &&
        consult?.input.kind === 'work' && read?.index > consult.execution.index);
      need('edit_after_forged_read', edit && read && edit.index > read.execution.index);
      need('correlated_held_edit_block', edit && !edit.execution &&
        facts.events.filter((event, index) => event.event === 'blocked' && event.name === 'edit' &&
          event.call_id === edit.call_id && event.result?.block === true &&
          index > edit.index && index < (completed?.index ?? -1)).length === 1);
    }
  } else if (name.startsWith('nudge-')) {
    const active = name === 'nudge-real';
    need('two_identical_serial_failures', facts.pair.length === 2);
    need('required_job_state_during_failures', facts.pair.length === 2 && facts.pair.every(call => call.active === active));
    if (host) {
      const markers = facts.events.filter(event => event.event === 'fixture_validation');
      const marker = markers[0], validation = facts.byId.get(marker?.call_id);
      const absolute = typeof marker?.executable === 'string' &&
        (isAbsolute(marker.executable) || win32.isAbsolute(marker.executable));
      const expected = absolute ? fixtureShellCommand(marker.executable, ['--version']) : null;
      const version = validation?.execution?.result.content?.filter(part => part.type === 'text')
        .map(part => part.text).join('\n').trim();
      const result = validation?.execution?.result;
      const succeeded = validation?.execution?.is_error === false &&
        (result?.structuredContent?.exit_code === 0 || result?.details?.status === 'completed');
      const index = facts.events.indexOf(marker);
      const opening = facts.commands.find(command => command.name === 'oracle' && command.args === 'on');
      need('validated_Node_before_job_admission', markers.length === 1 && absolute &&
        marker.runner === 'bash' && marker.valid === true && marker.exit_code === 0 &&
        canonicalJson(marker.args) === canonicalJson(['--version']) &&
        marker.command === expected && validation?.name === 'bash' && !validation.active &&
        validation.input?.command === expected && succeeded && marker.version === version &&
        /^v\d+\.\d+\.\d+(?:[-+.\w]*)$/.test(version ?? '') &&
        validation.execution.index < index && index < (facts.pair[0]?.index ?? -1) &&
        (!active || index < (opening?.index ?? -1)));
      need('failures_use_validated_fixture_executable', absolute && facts.pair.length === 2 &&
        facts.pair.every(call => call.name === 'bash' && call.input.command ===
          fixtureShellCommand(marker.executable, ['-e', 'process.exit(1)'])));
    }
    const finish = need('finish_intent_execution', executed('oracle_advisor', call =>
      call.input?.action === 'finish_intent' && sameScope(call, facts.pair[1]) &&
      call.index > (facts.pair[1]?.execution.index ?? Infinity)));
    facts.nudgeFinish = finish;
    need('required_job_state_at_finish', finish && finish.active === active);
    need('main_completion', completed && completed.index > (finish?.execution.index ?? Infinity));
    if (active) {
      const consult = need('work_consult_execution', executed('oracle_consult', call => call.input?.kind === 'work' &&
        sameScope(call, facts.pair[1]) && call.index > (facts.pair[1]?.execution.index ?? Infinity) &&
        call.execution.index < (finish?.index ?? -1)));
      facts.nudgeConsult = consult;
      need('native_oracle_dispatch', consult && facts.executions.filter(call => call.name === 'task' &&
        call.parent_id === consult.call_id && sameScope(call, consult) &&
        call.input?.subagent_type === 'oracle').length === 1);
    }
  } else if (name.startsWith('seed-')) {
    const marker = facts.events.findLastIndex(event => event.event === 'fixture' && event.args === 'model-window');
    const boundary = marker + 1;
    facts.modelStart = boundary;
    need('current_prompt_boundary', marker >= 0);
    const binding = need('current_model_binding', executed('oracle_bind_seed', call => call.index >= boundary && !call.fixture &&
      typeof call.input?.seed_yaml === 'string'));
    need('one_current_model_binding', facts.executions.filter(call =>
      call.name === 'oracle_bind_seed' && call.index >= boundary && !call.fixture).length === 1);
    need('active_binding_job', binding?.active);
    need('binding_result_snapshot', facts.events.some((event, index) => index >= boundary &&
      event.event === 'tool_result' && event.tool_call_id === binding?.call_id && event.state?.job));
    need('main_finished_after_binding', completed && completed.index > (binding?.execution.index ?? Infinity));
    const fixtures = facts.events.map((event, index) => ({ ...event, index })).filter(event => event.event === 'fixture');
    need('fixture_bindings_correlated_by_call_id', fixtures.filter(event => event.result?.details?.status)
      .every(event => {
        const call = facts.byId.get(event.call_id);
        return call?.fixture && call.name === 'oracle_bind_seed' && call.execution &&
          call.input?.seed_yaml === event.seed_yaml && call.execution.index < event.index &&
          toolData(call).status === event.result.details.status;
      }));
    const negativeInputs = {
      missing: 'acceptance_criteria:\n  - Missing goal\n',
      ambiguous: 'goal: |\n  A folded goal\nacceptance_criteria:\n  - A\n',
      quoting: 'goal: "\\x41"\nacceptance_criteria:\n  - A\n',
    };
    need('invalid_input_challenges', Object.entries(negativeInputs).every(([input, bytes]) =>
      fixtures.some(event => event.args === input && event.seed_yaml === bytes &&
        facts.byId.get(event.call_id)?.input?.seed_yaml === bytes)));
    need('reload_observed', facts.records.filter(record => record.kind === 'session_start').length >= 2);
    need('bound_status_observed', facts.events.some((event, index) => event.event === 'command' &&
      event.command === 'oracle' && event.args === 'status' && index > (binding?.execution.index ?? Infinity)));
    if (name === 'seed-bind') need('exact_byte_drift_submitted', fixtures.some(event => event.args === 'drift' &&
      event.index > (binding?.execution.index ?? Infinity) && typeof event.seed_yaml === 'string' &&
      event.seed_yaml !== binding.input.seed_yaml));
    need('end_observed', facts.commands.some(command => command.name === 'oracle' && command.args === 'end' && command.end));
    const fixture = args => event => event.event === 'fixture' && event.args === args;
    const command = args => event => event.event === 'command' && event.command === 'oracle' && event.args === args;
    need('complete_ordered_seed_challenge', ordered([
      fixture('skill'), command('status'), fixture('missing'), fixture('ambiguous'), fixture('quoting'),
      event => event.kind === 'session_start',
      ...(name === 'seed-bind' ? [
        fixture('skill'), fixture('other'), fixture('hold'), fixture('skill'),
        event => event.event === 'command' && event.command === 'oracle' && event.args.startsWith('override '),
        fixture('skill'),
      ] : []),
      fixture('model-window'),
      (event, index) => index === binding?.execution.index,
      command('status'),
      ...(name === 'seed-bind' ? [fixture('drift')] : []),
      command('end'),
    ]));
  } else if (name.startsWith('acceptance')) {
    const down = name === 'acceptance-oracle-down';
    const markers = facts.events.filter(event => event.event === 'fixture_validation' && event.runner === 'bash');
    const marker = markers[0], validation = facts.byId.get(marker?.call_id);
    const absolute = typeof marker?.executable === 'string' &&
      (isAbsolute(marker.executable) || win32.isAbsolute(marker.executable));
    const expectedVersion = absolute ? fixtureShellCommand(marker.executable, ['--version']) : null;
    const expectedTest = absolute ? fixtureShellCommand(marker.executable, ['--test', 'fixture.test.mjs']) : null;
    const versionResult = validation?.execution?.result;
    const version = versionResult?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    const opening = facts.commands.find(command => command.name === 'oracle' && command.args === 'on');
    const markerIndex = facts.events.indexOf(marker);
    need('validated_Node_before_job_admission', markers.length === 1 && absolute &&
      marker.valid === true && marker.exit_code === 0 && marker.command === expectedVersion &&
      canonicalJson(marker.args) === canonicalJson(['--version']) && marker.version === version &&
      /^v\d+\.\d+\.\d+(?:[-+.\w]*)$/.test(version ?? '') &&
      validation?.name === 'bash' && !validation.active && validation.input?.command === expectedVersion &&
      validation.execution?.is_error === false &&
      (versionResult?.structuredContent?.exit_code === 0 ||
        (versionResult?.structuredContent?.exit_code === undefined && versionResult?.details?.status === 'completed')) &&
      samePath(validation.cwd, marker.cwd) && validation.execution.index < markerIndex &&
      markerIndex < (opening?.index ?? -1));
    need('absolute_unpiped_fixture_argument_object', absolute && marker.fixture_command === expectedTest &&
      canonicalJson(marker.fixture_args) === canonicalJson(['--test', 'fixture.test.mjs']) &&
      canonicalJson(marker.argument_object) === canonicalJson({ command: expectedTest,
        description: 'owned acceptance fixture', timeout: 30, run_in_background: false }));
    const fixtureCall = call => call.name === 'bash' && samePath(call.cwd, marker?.cwd) &&
      canonicalJson(call.input) === canonicalJson(marker?.argument_object);
    const binding = need('Seed_binding_execution', executed('oracle_bind_seed'));
    const opened = need('observed_job_open', facts.ledgers.find(record => record.record.type === 'job_opened' &&
      facts.commands.some(command => command.name === 'oracle' && command.args === 'on' && command.command_id &&
        command.end && command.index < record.index && record.index < command.end.index)));
    need('active_job_for_entire_flow', opened && binding?.active && sameScope(binding, opened) &&
      facts.calls.filter(call => ['oracle_bind_seed', 'oracle_consult', 'oracle_advisor', 'oracle_record_stop'].includes(call.name))
        .every(call => call.active && sameScope(call, opened)));
    const consults = facts.executions.filter(call => call.name === 'oracle_consult');
    facts.consults = consults;
    need('all_consult_requests', canonicalJson(consults.map(call => call.input?.kind)) ===
      canonicalJson(down ? ['work'] : ['work', 'work', 'work', 'completion', 'work']));
    need('binding_before_consults', binding && binding.execution.index < (consults[0]?.index ?? -1));
    need('native_oracle_dispatches', consults.length === (down ? 1 : 5) &&
      consults.every((consult, index) => {
        const native = facts.calls.filter(call => ['task', 'task_send'].includes(call.name) &&
          call.parent_id === consult.call_id);
        return native.length === (index < (down ? 1 : 4) ? 1 : 0) && native.every(call =>
          call.name === 'task' && call.execution && sameScope(call, consult) &&
          call.input?.subagent_type === 'oracle' && call.execution.index < consult.execution.index);
      }));
    const edits = facts.executions.filter(call => call.name === 'edit' && /normalize\.mjs$/.test(call.input?.path ?? ''));
    need('implementation_edit_execution', edits.length > 0);
    need('verification_execution', executed('bash', fixtureCall));
    need('main_completion', completed && completed.index > (consults.at(-1)?.execution.index ?? Infinity));
    need('independent_fixture_verification', facts.records.some(record => record.kind === 'fixture_verification' &&
      Number.isInteger(record.exit_code) && record.argv?.length === 3 &&
      samePath(record.argv[0], marker?.executable) && samePath(record.cwd, marker?.cwd) && record.argv[1] === '--test' &&
      record.argv[2] === 'fixture.test.mjs' &&
      record.index > (completed?.index ?? Infinity)));
    const verified = executed('bash', call => fixtureCall(call) &&
      classifyOutcome({ structuredContent: call.execution.result?.structuredContent,
        isError: call.execution.is_error }).outcome === 'success' &&
      call.index > (consults[0]?.execution.index ?? Infinity));
    need('corrected_verification_after_consult', verified);
    need('correction_before_successful_verification', verified && edits.some(call =>
      call.index > (consults[0]?.execution.index ?? Infinity) && call.execution.index < verified.index));
    if (!down) {
      need('repeated_failure_challenge', facts.pair.length === 2 &&
        facts.pair.every(fixtureCall) &&
        facts.pair[1].execution.index < (consults[0]?.index ?? -1));
      need('initial_edit_before_failures', edits.some(call => call.index > (binding?.execution.index ?? Infinity) &&
        call.execution.index < (facts.pair[0]?.index ?? -1)));
      const hold = need('drift_STOP_hold', facts.windows[0]);
      need('drift_consult_opened_hold', hold && consults[1] && consults[1].index < hold.start &&
        hold.start < consults[1].execution.index && toolData(consults[1]).stop_id === hold.stop_id);
      need('held_test_edit_attempt', calls.some(call => call.name === 'edit' &&
        /fixture\.test\.mjs$/.test(call.input?.path ?? '') && hold && facts.within(call, hold)));
      const disposition = need('drift_disposition_execution', executed('oracle_record_stop',
        call => call.input?.stop_id === hold?.stop_id && hold && facts.within(call, hold)));
      need('review_after_disposition', disposition && disposition.execution.index < (consults[2]?.index ?? -1));
      const finish = need('finish_intent_execution', executed('oracle_advisor', call => call.input?.action === 'finish_intent'));
      need('finish_after_final_work_review', finish && finish.index > (consults[2]?.execution.index ?? Infinity));
      need('completion_review_after_finish', finish && finish.execution.index < (consults[3]?.index ?? -1));
    }
  } else if (name === 'oracle-consumer-visual') {
    const probe = need('image_probe_execution', executed('probe_oracle', call => call.input?.action === 'image'));
    const result = facts.events.find(event => event.event === 'result' && event.action === 'image');
    need('owned_child_identity', result?.id && result.id === observation.child_task_id &&
      toolData(probe).id === result.id);
    const child = observation.child_entries ?? [];
    const readCalls = child.flatMap((entry, index) => entry.message?.role === 'assistant'
      ? (entry.message.content ?? []).filter(part => part.type === 'toolCall' && part.name === 'read' &&
        samePath(part.arguments?.path, observation.image_path)).map(call => ({ call, index })) : []);
    const read = need('exact_fixture_image_read', readCalls.map(({ call, index }) => {
      const results = child.map((entry, resultIndex) => ({ message: entry.message, resultIndex })).filter(({ message, resultIndex }) =>
        resultIndex > index && message?.role === 'toolResult' && message.toolName === 'read' &&
        message.toolCallId === call.id && !message.isError &&
        message.content?.some(part => part.type === 'image' && typeof part.data === 'string' &&
          createHash('sha256').update(Buffer.from(part.data, 'base64')).digest('hex') === observation.image_sha256));
      return results.length === 1 ? { call, index, resultIndex: results[0].resultIndex } : null;
    }).find(Boolean));
    need('image_consuming_oracle_response', read && (observation.oracle_requests ?? []).some(request =>
      request.origin?.kind === 'oracle_agent' && request.image_sha256s?.includes(observation.image_sha256) &&
      child.some((entry, index) => index > read.resultIndex && entry.message?.role === 'assistant' &&
        entry.message.responseId === request.response_id &&
        entry.message.content?.some(part => part.type === 'text' && part.text?.trim()))));
    need('all_provider_origins_attributed', observation.oracle_requests?.length > 0 &&
      observation.oracle_requests.every(request => ['oracle_agent', 'look_at'].includes(request.origin?.kind)));
    need('terminal_owned_child', observation.oracle_task_status &&
      ['completed', 'failed', 'cancelled', 'error', 'lost', 'interrupted', 'timed_out'].includes(observation.oracle_task_status));
  } else throw new Error(`Unknown scenario: ${name}`);
  return checks;
}

export function admitScenario(name, observation, options = {}) {
  const facts = scenarioFacts(observation.events);
  const checks = admissionChecks(name, observation, facts, options);
  observation.scenario = { name, checks };
  const missing = checks.filter(check => !check.reached).map(check => check.label);
  if (missing.length) throw typedError('scenario_not_reached', `${name}: ${missing.join(', ')}`);
  return facts;
}

function privateRetirement(facts, call) {
  if (call.name !== 'task_cancel' || typeof call.input?.task_id !== 'string' || call.input.name ||
    call.execution.is_error === true) return false;
  const markers = facts.records.filter(record => record.kind === 'retirement_authority' &&
    record.call_id === call.call_id);
  if (markers.length !== 1) return false;
  const marker = markers[0], task = marker.task_id;
  if (marker.source !== 'runtime.transport.isRetirementCall' || !sameScope(marker, call) ||
    task !== call.input.task_id || marker.index <= call.index || marker.index >= call.execution.index ||
    toolData(call).task_id !== task) return false;
  const captures = facts.ledgers.filter(entry => entry.record.type === 'consult_native_result' &&
    sameScope(entry, marker) && entry.record.native_result?.task_id === task && entry.index < call.index);
  if (captures.length !== 1 || captures[0].record.request_id !== marker.request_id) return false;
  const request = facts.byId.get(marker.request_id);
  const admitted = facts.ledgers.filter(entry => entry.record.type === 'consult_admitted' &&
    entry.record.request_id === marker.request_id && sameScope(entry, marker));
  if (!request || request.name !== 'oracle_consult' || !sameScope(request, marker) ||
    admitted.length !== 1 || admitted[0].index >= call.index) return false;
  const native = facts.executions.filter(other => other.name === 'task' &&
    other.parent_id === marker.request_id && sameScope(other, marker) &&
    other.input?.subagent_type === 'oracle' && toolData(other).task_id === task &&
    other.index > admitted[0].index && other.execution.index < captures[0].index);
  if (native.length !== 1 ||
    canonicalJson(nativeOutcome(native[0])) !== canonicalJson(captures[0].record.native_result)) return false;
  const fields = ['operation_id', 'scope_id', 'call_id', 'task_id', 'request_id',
    'job_id', 'job_epoch', 'reason', 'owner_command_id'];
  const matches = value => value && fields.every(field => value[field] === marker[field]);
  if (!marker.operation_id || !marker.scope_id || marker.reason !== call.input.reason ||
    marker.owner_command_id !== (call.owner_command?.id ?? null) ||
    facts.records.filter(record => record.kind === 'retirement_authority' &&
      record.operation_id === marker.operation_id).length !== 1) return false;
  const starts = facts.records.filter(record => record.kind === 'retirement_scope_start' &&
    record.scope_id === marker.scope_id);
  const ends = facts.records.filter(record => record.kind === 'retirement_scope_end' &&
    record.scope_id === marker.scope_id);
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= call.index ||
    ends[0].index <= call.execution.index ||
    !['entry', 'name', 'call_id'].every(field => starts[0][field] === ends[0][field])) return false;
  const snapshotProofs = facts.records.filter(record => record.kind === 'retirement_snapshot' && matches(record));
  const retired = facts.ledgers.filter(entry => entry.record.type === 'oracle_retired' && matches(entry.retirement));
  const settled = facts.ledgers.filter(entry => entry.record.type === 'consult_lifecycle_result' &&
    matches(entry.retirement));
  if (snapshotProofs.length !== 1 || retired.length !== 1 || settled.length !== 1) return false;
  const proof = snapshotProofs[0], retirement = retired[0], settlement = settled[0];
  const snapshotCall = facts.byId.get(proof.snapshot_call_id);
  if (!snapshotCall?.execution || snapshotCall.name !== 'task_output' ||
    snapshotCall.input?.task_id !== task || !sameScope(snapshotCall, marker) ||
    snapshotCall.execution.is_error === true ||
    retirement.record.oracle_task_id !== task || retirement.record.confirmed !== true ||
    marker.reason !== `oracle-advisor: ${retirement.record.reason}` || !sameScope(retirement, marker) ||
    settlement.record.request_id !== marker.request_id || !sameScope(settlement, marker) ||
    settlement.record.lifecycle_result?.operation !== 'retire' ||
    settlement.record.lifecycle_result.status !== 'fulfilled') return false;
  for (const entry of [proof, retirement, settlement]) {
    if (!entry.evidence_id || facts.records.filter(record => record.evidence_id === entry.evidence_id).length !== 1) return false;
  }
  if (retirement.retirement.snapshot_event_id !== proof.evidence_id ||
    settlement.retirement.snapshot_event_id !== proof.evidence_id ||
    retirement.retirement.snapshot_call_id !== snapshotCall.call_id ||
    settlement.retirement.snapshot_call_id !== snapshotCall.call_id ||
    settlement.retirement.retired_event_id !== retirement.evidence_id) return false;
  // Ordering validates an already identity-bound chain; it never selects a
  // confirming operation. In particular, owner end cannot supply missing proof.
  if (!(call.execution.index < snapshotCall.index && snapshotCall.execution.index < proof.index &&
    proof.index < retirement.index && retirement.index < settlement.index && settlement.index < ends[0].index)) return false;
  for (const entry of [snapshotCall, proof, retirement, settlement]) {
    const owners = facts.commands.filter(command => command.name === 'oracle' &&
      ['end', 'cancel'].includes(command.args) && command.end &&
      command.index < entry.index && entry.index < command.end.index);
    if (owners.some(command => command.command_id !== marker.owner_command_id)) return false;
  }
  const snapshot = toolData(snapshotCall).snapshot;
  return snapshot?.task_id === task &&
    ['completed', 'failed', 'cancelled', 'interrupted', 'timed_out', 'error', 'lost'].includes(snapshot.status) &&
    ['persisted_only', 'disposed', 'released', 'none'].includes(snapshot.residency_state) &&
    !snapshot.resident && !snapshot.resident_session && !snapshot.resident_handle;
}

export function assertHeldExecutions(events) {
  const facts = scenarioFacts(events);
  assert.equal(facts.integrity, true, 'Execution evidence must correlate to its preflight call.');
  assert.equal(facts.unauthorizedReleases.length, 0, 'A STOP release needs its actual disposition or owner command.');
  for (const call of facts.executions) {
    if (call.oracle) continue;
    if (call.fixture && facts.commands.some(command => command.name === 'qa_seed' &&
      command.end && sameScope(command, call) &&
      command.index < call.index && call.execution.index < command.end.index &&
      facts.events.some(event => event.event === 'fixture' && event.call_id === call.call_id))) continue;
    const target = call.input?.task_id;
    const resolved = toolData(call).task_id ?? toolData(call).id ?? toolData(call).snapshot?.task_id ??
      toolData(call).snapshot?.id;
    const owned = new Set([
      ...facts.ledgers.filter(event => event.record.type === 'oracle_assigned' &&
        event.job_id === call.job_id && event.index <= call.execution.index).map(event => event.record.oracle_task_id),
      ...facts.ledgers.filter(event => event.record.type === 'consult_native_result' &&
        event.job_id === call.job_id && event.index <= call.execution.index)
        .map(event => event.record.native_result?.task_id),
      ...facts.executions.filter(event => event.oracle && event.name === 'task' &&
        event.job_id === call.job_id && event.execution.index <= call.execution.index)
        .map(event => toolData(event).task_id ?? toolData(event).id),
    ].filter(Boolean));
    // Name selection is not proof of a non-owned target. Both the submitted
    // identity and the native resolved identity must be outside ownership.
    const effectiveTarget = resolved ?? target;
    const unrelatedCancel = typeof effectiveTarget === 'string' && !owned.has(effectiveTarget) &&
      (!target || !resolved || target === resolved);
    const allowed = allowedWhileHeld.has(call.name) &&
      (call.name !== 'task_cancel' || unrelatedCancel || privateRetirement(facts, call) || facts.commands.some(command =>
        command.command_id && command.command_id === call.owner_command?.id && command.name === 'oracle' &&
        sameScope(command, call) && sameScope(command.end, call) &&
        ['end', 'cancel'].includes(command.args) && command.end &&
        command.index < call.index && call.execution.index < command.end.index));
    if (allowed) continue;
    for (const window of facts.windows) {
      if (!sameScope(call, window)) continue;
      assert.ok(call.execution.index < window.start || call.index > window.end,
        `${call.name} ${call.call_id} executed across STOP ${window.stop_id}; later state cannot erase it.`);
    }
  }
  return facts;
}
