import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONSULT_CAP, WORK_CONSULTS, NUDGE_CAP, FAILURE_NUDGES, RECEIPT_FIELDS } from './contracts.mjs';
import { applyTriggerEvent, createTriggerState, triggerEvent } from './triggers.mjs';

const agentDirectory = () => process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
const rule = 'Consult the oracle with oracle_consult when stuck or before final handoff. ' +
  'Call oracle_advisor with action "finish_intent" before the final answer. ' +
  'For a REDIRECT, record followed or declined through oracle_record_stop using its redirect_id.';
const completionNotice = 'Oracle advisor: before final handoff, call oracle_consult with kind "completion" ' +
  'to review the current progress revision.';
const toolResult = (status, text = '') => ({
  content: text ? [{ type: 'text', text }] : [],
  details: { status }, structuredContent: { status },
});

export function registerNudger(pi, runtime, { agentDir = agentDirectory } = {}) {
  const { ledger } = runtime;
  let detector, detectorRevision;
  const activeJob = () => {
    if (runtime.getSessionStatus() !== 'lead') return null;
    const job = ledger.jobFacts;
    return job?.status === 'active' ? job : null;
  };
  const append = (type, data, job) => {
    try {
      return ledger.append({
        type, job_id: job.job_id, job_epoch: job.job_epoch, ...data,
      }, { snapshot: false });
    } catch (error) {
      detector = undefined;
      throw error;
    }
  };
  const stateFor = job => {
    if (!detector || detectorRevision !== ledger.triggerRevision) {
      detector = createTriggerState({ active: true, snapshot: ledger.triggerState });
      detectorRevision = ledger.triggerRevision;
    }
    detector.active = true;
    detector.progress_revision = job.progress_revision;
    return detector;
  };
  function persist(state, job, event, context) {
    if (state.progress_revision !== job.progress_revision) {
      append('progress_recorded', { revision: state.progress_revision }, job);
    }
    const { calls: _calls, ...summary } = state;
    append('trigger_state_recorded', { state: summary, event: triggerEvent(event, context) }, job);
    detectorRevision = ledger.triggerRevision;
  }
  function notice(trigger, state, job) {
    const kind = trigger.kind === 'repeated_failure' ? 'failure' : 'completion';
    const pending = runtime.transport.running || ledger.hasPendingConsult;
    if (pending || job.counters.consults >= CONSULT_CAP || job.counters.nudges >= NUDGE_CAP) return;
    if (kind === 'failure' && (job.counters.failure_nudges >= FAILURE_NUDGES ||
        job.counters.work >= WORK_CONSULTS)) return;
    if (kind === 'completion' && job.nudges.some(nudge => nudge.kind === 'completion')) return;
    const episode = kind === 'failure' ? JSON.stringify(trigger.tool_call_ids) : 'completion';
    if (job.nudges.some(nudge => nudge.episode_id === episode)) return;
    const turn = state.nudger_tool_turn ?? 0;
    if (kind === 'failure' && state.nudger_last_failure_turn !== undefined &&
        turn - state.nudger_last_failure_turn < 2) return;
    const text = kind === 'failure'
      ? `Oracle advisor: repeated ${trigger.error_class} in calls ${trigger.tool_call_ids.join(' and ')}. ` +
        'Call oracle_consult with kind "work" before repeating this operation.'
      : completionNotice;
    const record = {
      kind, episode_id: episode, progress_revision: state.progress_revision,
      tool_turn: turn, source: trigger.source ?? 'repeated_failure',
      ...(kind === 'failure' ? {
        tool_call_ids: trigger.tool_call_ids, error_class: trigger.error_class,
        operation_key: trigger.operation_key,
        failure_digest: createHash('sha256').update(trigger.operation_key).digest('hex'),
      } : {}),
    };
    append('nudge_recorded', record, job);
    if (kind === 'failure') state.nudger_last_failure_turn = turn;
    const directory = agentDir();
    if (directory) {
      const { operation_key: _operationKey, ...accounting } = record;
      try {
        mkdirSync(join(directory, 'logs'), { recursive: true });
        appendFileSync(join(directory, 'logs/oracle-advisor.jsonl'), JSON.stringify({
          ...Object.fromEntries(RECEIPT_FIELDS.map(field => [field, null])),
          at: new Date().toISOString(), event: 'nudge', status: 'nudged',
          job_id: job.job_id, job_epoch: job.job_epoch,
          calls_remaining: CONSULT_CAP - job.counters.consults, ...accounting,
        }) + '\n');
      } catch { /* Optional accounting I/O must not fail the main's tool. */ }
    }
    return text;
  }
  ledger.subscribe(data => {
    const job = activeJob();
    if (!job) return;
    if (data.type === 'consult_finished' && data.kind === 'completion' &&
        data.status === 'answered' && data.verdict) {
      const event = {
        type: 'completion_covered', progress_revision: data.progress_revision,
      };
      const reduced = applyTriggerEvent(stateFor(job), event);
      persist(reduced.state, job, event);
    } else if (data.type === 'stop_disposition') {
      const state = stateFor(job);
      if (job.dispositions.length > (state.nudger_disposition_count ?? 0)) {
        const event = { type: 'disposition_accepted' };
        const reduced = applyTriggerEvent(state, event);
        reduced.state.nudger_disposition_count = job.dispositions.length;
        persist(reduced.state, job, event);
      }
    }
  });
  pi.on('before_agent_start', event => {
    if (activeJob()) return { systemPrompt: `${event.systemPrompt}\n\n${rule}` };
  });
  pi.on('tool_call', (event, ctx) => {
    const job = activeJob();
    if (!job) return;
    persist(applyTriggerEvent(stateFor(job), event, { cwd: ctx.cwd }).state, job, event, { cwd: ctx.cwd });
  });
  pi.on('tool_result', (event, ctx) => {
    const job = activeJob();
    if (!job) return;
    const state = stateFor(job);
    const completed = state.calls[event.toolCallId]?.completed;
    const reduced = applyTriggerEvent(state, event, { cwd: ctx.cwd });
    const call = reduced.state.calls[event.toolCallId];
    if (call?.completed && !completed && !call.oracle_descendant && !call.invalidated) {
      reduced.state.nudger_turn_has_tools = true;
    }
    let text;
    for (const trigger of reduced.triggers) text ??= notice(trigger, reduced.state, job);
    persist(reduced.state, job, event, { cwd: ctx.cwd });
    if (text) return {
      content: [...event.content, { type: 'text', text }],
      structuredContent: event.structuredContent, details: event.details,
    };
  });
  pi.on('turn_end', () => {
    const job = activeJob();
    if (!job) return;
    const state = stateFor(job);
    if (!state.nudger_turn_has_tools) return;
    state.nudger_tool_turn = (state.nudger_tool_turn ?? 0) + 1;
    state.nudger_turn_has_tools = false;
    persist(state, job, { type: 'turn_end' });
  });
  runtime.registerTool({
    name: 'oracle_advisor', label: 'Oracle completion intent',
    description: 'Declare final handoff intent and check whether current progress has completion advice.',
    parameters: {
      type: 'object', properties: { action: { type: 'string', enum: ['finish_intent'] } },
      required: ['action'], additionalProperties: false,
    },
    async execute(_id, args) {
      if (args?.action !== 'finish_intent' || Object.keys(args).length !== 1) {
        return toolResult('invalid_arguments');
      }
      const job = activeJob();
      if (!job) return toolResult('no_nudge');
      const event = { type: 'finish_intent' };
      const reduced = applyTriggerEvent(stateFor(job), event);
      const text = reduced.triggers.length ? notice(reduced.triggers[0], reduced.state, job) : undefined;
      persist(reduced.state, job, event);
      return toolResult(text ? 'nudge' : 'no_nudge', text);
    },
  });
}
