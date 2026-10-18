import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONSULT_CAP, WORK_CONSULTS, RECEIPT_FIELDS } from './contracts.mjs';
import { buildDossier, buildOraclePrompt, parseVerdict, saveAdvice } from './protocol.mjs';
import { effectiveOracleTools } from '../scripts/oracle-policy.mjs';
import { consultPending } from './ledger.mjs';

const agentDirectory = () => process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
const remaining = job => CONSULT_CAP - (job?.counters.consults ?? 0);
const result = (details, text) => ({
  content: [{ type: 'text', text }], details, structuredContent: details,
});
const validArguments = args => args && typeof args === 'object' && !Array.isArray(args) &&
  Object.keys(args).every(key => ['kind', 'question', 'claims'].includes(key)) &&
  ['work', 'completion'].includes(args.kind) && typeof args.question === 'string' &&
  [...args.question].length <= 4000 && (args.claims === undefined ||
    Array.isArray(args.claims) && args.claims.length <= 5 && args.claims.every(item => typeof item === 'string'));
const artifactId = id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) &&
  !id.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(id)
  ? id : createHash('sha256').update(id).digest('hex');

export function registerConsultTool(pi, runtime, { agentDir = agentDirectory, now = Date.now, onCheckpoint } = {}) {
  const { ledger } = runtime;
  const nested = new Set();
  let pending;
  const append = (type, data, job = ledger.jobFacts) => {
    const { model_called: _called, native_result: _native, native_attempts: _attempts, ...fields } = data;
    return ledger.append({
      job_id: job?.job_id ?? null, job_epoch: job?.job_epoch ?? null, ...fields, type,
    }, { snapshot: false });
  };
  runtime.consult = {
    invalidate(status) {
      if (!pending || pending.terminal) return;
      pending.status ??= status;
      const previous = ledger.request(pending.request_id);
      if (previous && consultPending(previous)) {
        const record = { ...previous, ...pending.record, status: pending.status,
          analysis_path: null, analysis_chars: 0 };
        for (const key of ['verdict', 'reasons', 'stop_id', 'redirect_id', 'downgrade']) delete record[key];
        record.verdict_changed_direction = null;
        append('consult_finished', { ...record, response: deliver(record) });
      }
      pending.controller.abort();
    },
    cancel(ctx) {
      const operation = pending;
      if (!operation || operation.terminal) return runtime.transport.cancel(ctx);
      runtime.consult.invalidate('cancelled');
      const cancelled = { status: 'cancelled', request_id: operation.request_id };
      return runtime.transport.running
        ? runtime.transport.cancel(ctx).then(() => cancelled) : cancelled;
    },
  };
  function receipt(record, event = 'consult', checkpoint) {
    const agent = agentDir();
    if (!agent) return;
    const directory = join(agent, 'logs');
    checkpoint?.();
    try { mkdirSync(directory, { recursive: true }); }
    catch { return; }
    checkpoint?.();
    try {
      appendFileSync(join(directory, 'oracle-advisor.jsonl'), JSON.stringify({
        at: new Date(now()).toISOString(), event,
        ...Object.fromEntries(RECEIPT_FIELDS.map(field => [field, record[field] ?? null])),
        model_called: record.model_called,
        answer_chars: record.answer_chars ?? 0,
        truncated_by_provider: record.truncated_by_provider ?? false,
      }) + '\n');
    } catch { /* Optional accounting I/O must not fail the main's tool. */ }
  }
  function base(request_id, kind, job) {
    return {
      job_id: job?.job_id ?? null, job_epoch: job?.job_epoch ?? null,
      request_id, kind, trigger: 'manual', oracle_task_id: null, oracle_run_epoch: null,
      path: null, latency_ms: 0, main_cache_wait_exceeded: false,
      analysis_chars: 0, analysis_path: null, provider_stop_reason: null,
      engine_completion_chars: 0, model: null, usage_status: 'unknown',
      input_tokens: null, output_tokens: null, reasoning_tokens: null,
      verdict_changed_direction: null, same_failure_recurred_after: null,
      calls_remaining: remaining(job),
    };
  }
  function deliver(record, analysis = '') {
    const details = {
      status: record.status, calls_remaining: record.calls_remaining,
      path: record.path, analysis_path: record.analysis_path, analysis_chars: record.analysis_chars,
      ...(record.verdict ? { verdict: record.verdict, reasons: record.reasons } : {}),
      ...(record.stop_id ? { stop_id: record.stop_id } : {}),
      ...(record.redirect_id ? { redirect_id: record.redirect_id } : {}),
      ...(record.truncated_by_provider ? { truncated_by_provider: true } : {}),
    };
    let text = record.verdict
      ? `${record.verdict}${record.stop_id || record.redirect_id ? ` (${record.stop_id ?? record.redirect_id})` : ''}` +
        (record.reasons.length ? `: ${record.reasons.map(reason => reason.text).join('; ')}` : '')
      : `oracle ${record.status}; advice unavailable`;
    if (record.analysis_path && (record.status === 'invalid' || !record.engine_delivers_completion)) {
      if (record.status === 'invalid') text += `\n\nUNPARSED ADVICE (non-binding)\n${analysis}`;
      else if (analysis) text += `\n\n${analysis}`;
    }
    if (record.truncated_by_provider) text += '\ntruncated_by_provider';
    return result(details, text);
  }
  function refuse(status, request_id, kind, job) {
    const record = { ...base(request_id, kind, job), status };
    const response = result({
      status, calls_remaining: record.calls_remaining, path: null, analysis_path: null, analysis_chars: 0,
    }, status === 'oracle_not_readonly' ? 'oracle_not_readonly; no oracle started' : `oracle ${status}`);
    // Session identity guards are fail-inert, including receipts.
    if (!['child_session_refused', 'session_not_ready'].includes(status)) {
      append('consult_finished', { ...record, response }, job);
      const terminal = ledger.request(request_id);
      receipt(terminal);
      return terminal.response;
    }
    return response;
  }
  async function run(operation, args, ctx, job, slot) {
    const { request_id, signal } = operation;
    const started = now();
    const failure = job.trigger_state?.predecessor?.outcome === 'failure'
      ? job.trigger_state.predecessor : null;
    const record = {
      ...base(request_id, args.kind, job), slot,
      progress_revision: job.progress_revision,
      failure_key: failure?.key ?? null, failure_class: failure?.error_class ?? null,
      failure_call_id: failure?.tool_call_id ?? null,
      failure_digest: failure ? createHash('sha256').update(failure.key).digest('hex') : null,
    };
    operation.record = record;
    const session = ctx.sessionManager;
    const { session_id, session_file, admission_entry_id } = operation;
    let reservation_entry_id;
    let analysis = '';
    // One guard owns every live phase, including the protocol's internal awaits.
    // Abort finalization uses provenance, not dispatch eligibility: an old-epoch
    // reservation still belongs to this request and must be refunded.
    function checkpoint(stage) {
      if (!operation.terminal && stage !== 'abort') onCheckpoint?.(stage);
      const policy = !operation.terminal && stage !== 'reserve' ? effectiveOracleTools(ctx.cwd) : null;
      const current = ledger.jobFacts;
      const consult = ledger.request(request_id);
      const branch = session.getBranch();
      const sameSession = session.getSessionId() === session_id && session.getSessionFile() === session_file;
      const onBranch = sameSession && branch.some(entry => entry.id === (reservation_entry_id ?? admission_entry_id));
      const attached = !!reservation_entry_id && onBranch && current?.job_id === job.job_id &&
        consult?.job_epoch === job.job_epoch;
      // A committed result is immutable; only its synchronous receipt/return
      // remains. Cancellation can no longer find a non-terminal operation.
      if (operation.terminal && !operation.status) return { current, consult, attached };
      const expected = operation.phase === 'reserved' ? 'reserved' :
        operation.phase === 'admitted' ? 'admitted' : 'running';
      const invalid = attached && ['cancelled', 'interrupted'].includes(consult.status)
        ? consult.status : operation.status ?? (signal.aborted ? 'cancelled' :
          runtime.getSessionStatus() !== 'lead' || !onBranch ||
          current?.job_id !== job.job_id || current.job_epoch !== job.job_epoch ||
          consult?.status !== expected ? 'stale_reservation' :
          current.status !== 'active' ? 'cancelled' :
          policy && !policy.readonly ? 'oracle_not_readonly' : null);
      operation.status ??= invalid;
      if (stage === 'abort') return { current, consult, attached };
      if (operation.status) {
        operation.controller.abort();
        throw Object.assign(new Error(operation.status), { code: operation.status, consult_abort: true });
      }
      return { current, consult, attached };
    }
    try {
      checkpoint('reserve');
      append('consult_reserved', record, job);
      reservation_entry_id = session.getBranch().findLast(entry =>
        entry.customType === 'oracle-advisor' && entry.data.type === 'consult_reserved' &&
        entry.data.request_id === request_id)?.id;
      operation.phase = 'reserved';
      checkpoint('dossier');
      const dossier = await Promise.race([buildDossier(pi, {
        cwd: ctx.cwd, job, kind: args.kind, trigger: record.trigger,
        question: args.question, claims: args.claims, checkpoint,
        failure: failure ? { operation_key: failure.key, error_excerpts: failure.error_excerpts ?? [] } : null,
      }), operation.stopped.promise]);
      checkpoint('dossier_ready');
      checkpoint('start');
      append('consult_started', { request_id, started_at: new Date(started).toISOString() }, job);
      operation.phase = 'running';
      checkpoint('transport');
      const transportResult = await runtime.transport.consult({
        ctx, request_id, signal, prompt: buildOraclePrompt(dossier),
        beforeDispatch: () => {
          checkpoint('dispatch');
          append('consult_dispatched', { request_id }, job);
        },
      });
      const { answer, task: _task, ...accounting } = transportResult;
      Object.assign(record, accounting);
      checkpoint('transport_ready');
      if (record.status === 'answered') {
        const parsed = parseVerdict(answer, { seed: job.seed, provider_stop_reason: record.provider_stop_reason });
        operation.phase = 'persisting';
        checkpoint('advice');
        const saved = await saveAdvice(parsed, {
          agentDir: agentDir(), job_id: job.job_id, request_id: artifactId(request_id),
          engine_delivers_completion: record.engine_delivers_completion, checkpoint,
        });
        checkpoint('advice_ready');
        const { analysis: _analysis, advice: _advice, ...metadata } = saved;
        Object.assign(record, metadata);
        analysis = parsed.analysis;
        record.verdict_changed_direction = record.verdict && record.verdict !== 'REDIRECT' ? false : null;
        if (record.verdict === 'STOP') record.stop_id =
          `${job.job_id}-${createHash('sha256').update(request_id).digest('hex').slice(0, 16)}`;
        if (record.verdict === 'REDIRECT') record.redirect_id =
          `${job.job_id}-redirect-${createHash('sha256').update(request_id).digest('hex').slice(0, 16)}`;
      }
      operation.phase = 'publishing';
      checkpoint('publish');
      record.latency_ms ??= Math.max(0, now() - started);
      const events = record.verdict ? [{
        type: 'verdict_recorded', job_id: job.job_id, job_epoch: job.job_epoch,
        request_id, verdict: record.verdict, reasons: record.reasons,
        ...(record.stop_id ? { stop_id: record.stop_id } : {}),
        ...(record.redirect_id ? { redirect_id: record.redirect_id } : {}),
      }, ...(record.stop_id ? [{
        type: 'stop_opened', job_id: job.job_id, job_epoch: job.job_epoch,
        request_id, stop_id: record.stop_id, reasons: record.reasons,
      }] : [])] : [];
      // This is the linearization point: one synchronous ledger write publishes
      // the completion and its verdict/STOP together. No await follows it.
      operation.terminal = true;
      const response = deliver(record, analysis);
      append('consult_finished', { ...record, events, response }, job);
      const terminal = ledger.request(request_id);
      receipt(terminal, 'consult', () => checkpoint('publish'));
      checkpoint('publish');
      return terminal.response;
    } catch (error) {
      if (operation.terminal) throw error;
      checkpoint('abort');
      record.status = operation.status ?? (['timed_out', 'cancelled', 'quota'].includes(error.code)
        ? error.code : 'unavailable');
      record.latency_ms = Math.max(0, now() - started);
      record.analysis_path = null;
      record.analysis_chars = 0;
      for (const key of ['verdict', 'reasons', 'stop_id', 'redirect_id', 'downgrade']) delete record[key];
      record.verdict_changed_direction = null;
      operation.terminal = true;
      const previous = ledger.request(request_id);
      if (previous && !consultPending(previous)) {
        receipt(previous, 'consult',
          () => checkpoint('abort'));
        return previous.response ?? deliver(previous);
      }
      const response = deliver(record);
      append('consult_finished', { ...record, response }, job);
      const terminal = ledger.request(request_id);
      receipt(terminal, 'consult', () => checkpoint('abort'));
      checkpoint('abort');
      return terminal.response;
    }
  }
  // Trigger state and dispositions already cross a durable ledger boundary.
  // Observe those machine fields rather than interpreting prose or duplicating
  // the detector. Effect updates are append-only in both ledger and receipts.
  ledger.subscribe(data => {
    if (!['trigger_state_recorded', 'stop_disposition', 'redirect_disposition', 'job_ended'].includes(data.type)) return;
    const job = ledger.jobFacts;
    if (!job) return;
    for (const consult of ledger.effectCandidates(data)) {
      if (consultPending(consult)) continue;
      const effect = {};
      const failure = data.state?.predecessor;
      if (consult.same_failure_recurred_after === null && consult.failure_key) {
        if (data.type === 'job_ended') effect.same_failure_recurred_after = false;
        else if (failure?.outcome === 'failure' && failure.key === consult.failure_key &&
            failure.error_class === consult.failure_class && failure.tool_call_id !== consult.failure_call_id) {
          effect.same_failure_recurred_after = true;
        }
      }
      if (data.type === 'stop_disposition' && data.stop_id === consult.stop_id &&
          data.decision === 'redirect' && job.stops[data.stop_id]?.status === 'disposed' &&
          !consult.verdict_changed_direction) effect.verdict_changed_direction = true;
      if (data.type === 'redirect_disposition' && data.redirect_id === consult.redirect_id &&
          consult.verdict === 'REDIRECT' &&
          job.dispositions.some(disposition => disposition.redirect_id === data.redirect_id &&
            disposition.decision === data.decision)) {
        receipt(consult, 'consult_effect');
      }
      if (Object.keys(effect).length) {
        append('consult_effect_recorded', { request_id: consult.request_id, ...effect });
        receipt({ ...consult, ...effect }, 'consult_effect');
      }
    }
  });
  pi.on('tool_call', event => {
    if (runtime.getSessionStatus() !== 'lead') return;
    if (event.toolName === 'oracle_consult' || nested.has(event.parentToolCallId)) {
      nested.add(event.toolCallId);
      return;
    }
    const job = ledger.jobFacts;
    if (job?.status !== 'active') return;
    const target = event.toolName === 'task_send' ? event.input?.to :
      event.toolName === 'task_cancel' ? event.input?.task_id : null;
    if (target && job.oracle_task_ids.includes(target)) {
      const reason = 'Owned oracle: use oracle_consult for advice or /oracle end to retire it.';
      return runtime.stopGate?.block(event, reason) ?? { block: true, reason };
    }
  });
  runtime.registerTool({
    name: 'oracle_consult', label: 'Consult oracle',
    description: 'Request read-only advice for work or completion in an active oracle job.',
    parameters: {
      type: 'object', properties: {
        kind: { type: 'string', enum: ['work', 'completion'] },
        question: { type: 'string', maxLength: 4000 },
        claims: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      }, required: ['kind', 'question'], additionalProperties: false,
    },
    execute(request_id, args, signal, _update, ctx) {
      const session = runtime.getSessionStatus();
      const job = ledger.jobFacts;
      if (session !== 'lead') return refuse(session === 'child' ? 'child_session_refused' :
        'session_not_ready', request_id, args?.kind, job);
      if (pending?.request_id === request_id) return pending.promise;
      const previous = ledger.request(request_id);
      if (previous && !consultPending(previous)) return previous.response ?? deliver(previous);
      const valid = validArguments(args);
      const slot = args?.kind === 'completion' && job?.counters.completion === 0 ? 'completion' : 'work';
      const refusal = !valid ? 'invalid_arguments' : job?.status !== 'active' ? 'no_active_job' :
        pending || runtime.transport.running ? 'busy' :
          remaining(job) <= 0 || slot === 'work' && job.counters.work >= WORK_CONSULTS ? 'cap_exhausted' : null;
      // One synchronous admission reserves an eligible slot before scheduling.
      // Refused identities are durable too, but never reserve a slot.
      if (!previous) append('consult_admitted', {
        ...base(request_id, args?.kind, job), status: 'admitted', slot: refusal ? null : slot,
      }, job);
      if (refusal) return refuse(refusal, request_id, args?.kind, job);
      const controller = new AbortController();
      const current = { request_id, controller, ctx, phase: 'admitted', stopped: Promise.withResolvers(),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
        admission_entry_id: ctx.sessionManager.getBranch().at(-1)?.id };
      const onAbort = () => {
        current.stopped.resolve(null);
        runtime.consult.invalidate(current.status ?? 'cancelled');
      };
      current.signal.addEventListener('abort', onAbort, { once: true });
      pending = current;
      // A microtask establishes the in-flight id before any user-supplied host
      // callback can re-enter the tool.
      current.promise = Promise.resolve().then(() => run(current, args, ctx, job, slot)).finally(() => {
        current.signal.removeEventListener('abort', onAbort);
        if (pending === current) pending = undefined;
      });
      return current.promise;
    },
  });
}
