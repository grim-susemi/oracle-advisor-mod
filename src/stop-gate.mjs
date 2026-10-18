import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONSULT_CAP, GATE_TERMINATE_AFTER, OVERRIDE_MIN_REASON, REASON_MAX, RECEIPT_FIELDS } from './contracts.mjs';
import { openStops } from './ledger.mjs';

// Exact installed tool names only. In particular, lsp_rename is a write tool.
export const STOP_ALLOWED_TOOLS = Object.freeze([
  'read', 'find', 'grep', 'ls', 'lsp_diagnostics', 'lsp_goto_definition',
  'lsp_find_references', 'lsp_symbols', 'lsp_prepare_rename',
  'oracle_consult', 'oracle_record_stop', 'oracle_advisor', 'brief', 'plan_brief',
  'question', 'request_user_input', 'task_output', 'task_cancel',
  'coordination_inspect', 'coordination_notify',
]);
const allowed = new Set(STOP_ALLOWED_TOOLS);
const bounded = text => typeof text === 'string' &&
  [...text.trim()].length >= OVERRIDE_MIN_REASON && [...text.trim()].length <= REASON_MAX;
const held = job => openStops(job).length > 0 || ['HELD', 'HALTED'].includes(job?.gate_state);
const stopText = job => openStops(job).map(stop =>
  `${stop.stop_id}: ${(stop.reasons ?? []).map(reason =>
    `${reason.criterion_id ? `[${reason.criterion_id}] ` : ''}${reason.text}`).join('; ')}`,
).join('\n') || 'Oracle job halted.';
const result = (status, text, extra = {}) => {
  const details = { status, ...extra };
  return { content: [{ type: 'text', text }], details, structuredContent: details };
};

export function registerStopGate(pi, runtime) {
  const { ledger } = runtime;
  const nested = new Set();
  let consecutive = 0;
  const activeJob = () => {
    if (runtime.getSessionStatus() !== 'lead') return null;
    const job = ledger.jobFacts;
    return job?.status === 'active' ? job : null;
  };
  function receipt(event, job, extra) {
    const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
    if (!agentDir) return;
    const directory = join(agentDir, 'logs');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'oracle-advisor.jsonl'), JSON.stringify({
      ...Object.fromEntries(RECEIPT_FIELDS.map(field => [field, null])),
      at: new Date().toISOString(), event, job_id: job.job_id, job_epoch: job.job_epoch,
      status: job.gate_state, calls_remaining: CONSULT_CAP - job.counters.consults, ...extra,
    }) + '\n');
  }
  pi.on('agent_start', () => {
    if (runtime.getSessionStatus() === 'lead') consecutive = 0;
  });
  function block(event, guardReason) {
    // The ownership guard also delegates here. A private owned-release permit
    // allows this exact host call without resetting or incrementing its counter.
    if (runtime.transport?.isRetirementCall?.(event)) return { block: false };
    const job = activeJob();
    if (!job || !held(job)) { consecutive = 0; return { block: true, reason: guardReason }; }
    consecutive++;
    let reason = `${guardReason ? `${guardReason}\n` : ''}${stopText(job)}\n` +
      'change course and consult again, or call oracle_record_stop with a reason';
    try {
      ledger.append({
        type: 'gate_blocked', job_id: job.job_id, job_epoch: job.job_epoch,
        request_id: event.toolCallId, tool_name: event.toolName,
      }, { snapshot: false });
      receipt('gate_blocked', job, {
        request_id: event.toolCallId, tool_name: event.toolName,
        stop_ids: openStops(job).map(stop => stop.stop_id), consecutive_blocked: consecutive,
      });
    } catch {
      // Logging failure cannot turn an enforced STOP into permission to mutate.
      reason += '\nGate event persistence failed; STOP remains held.';
    }
    return { block: true, reason, terminate: consecutive >= GATE_TERMINATE_AFTER };
  }
  // All mod guards use this one counter, including a guard that returns before
  // the STOP hook under the host's first-block-return dispatch.
  runtime.stopGate = { block };
  pi.on('tool_call', event => {
    if (runtime.getSessionStatus() !== 'lead') return;
    if (event.toolName === 'oracle_consult' || nested.has(event.parentToolCallId)) {
      consecutive = 0;
      nested.add(event.toolCallId);
      return;
    }
    const job = activeJob();
    if (!job || !held(job)) { consecutive = 0; return; }
    const cancelAllowed = event.toolName !== 'task_cancel' ||
      typeof event.input?.task_id === 'string' && !event.input.name &&
      !job.oracle_task_ids.includes(event.input.task_id);
    if (allowed.has(event.toolName) && cancelAllowed) { consecutive = 0; return; }
    return block(event);
  });
  pi.on('before_agent_start', event => {
    const job = activeJob();
    if (!job || !held(job)) return;
    return { systemPrompt: `${event.systemPrompt}\n\nORACLE STOP (${job.gate_state})\n${stopText(job)}\n` +
      'Change course and consult again, or record an explicit disposition with oracle_record_stop.' };
  });
  pi.on('agent_before_settle', event => {
    const job = activeJob();
    if (!job || !held(job)) return;
    return { entries: [...event.entries, {
      type: 'custom_message', customType: 'oracle-advisor-stop',
      content: `STOP unresolved\n${stopText(job)}`, display: true,
      details: { job_id: job.job_id, stop_ids: openStops(job).map(stop => stop.stop_id) },
    }] };
  });
  pi.on('tool_result', event => {
    const job = activeJob();
    if (!job || event.toolName !== 'oracle_consult' ||
        !['unavailable', 'timed_out', 'oracle_dead', 'quota', 'invalid', 'oracle_not_readonly']
          .includes(event.structuredContent?.status)) return;
    return {
      content: [...(event.content ?? []), { type: 'text',
        text: `advice unavailable; ${held(job) ? 'existing STOP remains held' : 'work may continue'}` }],
      structuredContent: event.structuredContent, details: event.details,
    };
  });
  runtime.registerTool({
    name: 'oracle_record_stop', label: 'Record oracle STOP disposition',
    description: 'Record an open STOP disposition, or optionally record a REDIRECT as followed or declined using its redirect_id. REDIRECT never holds the job.',
    parameters: {
      type: 'object', properties: {
        stop_id: { type: 'string' },
        redirect_id: { type: 'string' },
        decision: { type: 'string', enum: ['proceed', 'redirect', 'halt', 'followed', 'declined'] },
        reason: { type: 'string', minLength: OVERRIDE_MIN_REASON, maxLength: REASON_MAX },
        next_step: { type: 'string', maxLength: REASON_MAX },
        evidence_refs: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      }, required: ['decision', 'reason', 'next_step'],
      anyOf: [{ required: ['stop_id'] }, { required: ['redirect_id'] }], additionalProperties: false,
    },
    async execute(_callId, args) {
      const job = activeJob();
      if (!job) return result('no_active_job', 'No active oracle job.');
      const redirect = typeof args?.redirect_id === 'string' && args.stop_id === undefined &&
        job.verdicts.some(verdict => verdict.redirect_id === args.redirect_id && verdict.verdict === 'REDIRECT') &&
        !job.dispositions.some(disposition => disposition.redirect_id === args.redirect_id) &&
        ['followed', 'declined'].includes(args.decision);
      const stop = typeof args?.stop_id === 'string' && args.redirect_id === undefined &&
        Object.hasOwn(job.stops, args.stop_id) && job.stops[args.stop_id].status === 'open' &&
        ['proceed', 'redirect', 'halt'].includes(args.decision);
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some(key => !['stop_id', 'redirect_id', 'decision', 'reason', 'next_step', 'evidence_refs'].includes(key)) ||
          (!stop && !redirect) || !bounded(args.reason) ||
          typeof args.next_step !== 'string' || [...args.next_step.trim()].length > REASON_MAX ||
          (args.decision !== 'halt' && !bounded(args.next_step)) ||
          (args.evidence_refs !== undefined && (!Array.isArray(args.evidence_refs) ||
            args.evidence_refs.length > 3 || args.evidence_refs.some(ref => typeof ref !== 'string' || !ref.trim())))) {
        return result('invalid_arguments', 'Use an exact open stop_id, a valid decision, and a 20-800 character reason and next_step.');
      }
      try {
        ledger.append({
          type: redirect ? 'redirect_disposition' : 'stop_disposition', job_id: job.job_id, job_epoch: job.job_epoch,
          ...(redirect ? { redirect_id: args.redirect_id } : { stop_id: args.stop_id }),
          decision: args.decision, reason: args.reason.trim(),
          next_step: args.next_step.trim(), evidence_refs: args.evidence_refs ?? [], actor: 'main',
        }, { snapshot: false });
      } catch {
        return result('persistence_failed', 'Disposition was not recorded; STOP remains held.');
      }
      if (!redirect) consecutive = 0;
      return result('recorded', `Oracle ${redirect ? 'REDIRECT' : 'STOP'} ${args.redirect_id ?? args.stop_id}: ${args.decision} recorded.`,
        { ...(redirect ? { redirect_id: args.redirect_id } : { stop_id: args.stop_id }),
          gate_state: ledger.jobFacts.gate_state });
    },
  });
}
