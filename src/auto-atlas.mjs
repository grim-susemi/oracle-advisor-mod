import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStops } from './ledger.mjs';
import { noteJobOpen } from './nature.mjs';

// Atlas sessions open automatically; execution commands may start a new run.
export const AUTO_TRIGGER = Object.freeze({
  commands: Object.freeze(['/skill:ulw-execute', '/ulw-execute']),
});
const PLAN_COMMANDS = Object.freeze(['/skill:ulw-plan', '/ulw-plan']);
const OWNER_SOURCES = new Set(['interactive', 'rpc']);
const RESTART_REASONS = new Set(['resume', 'fork']);
const REASON_TEXT = Object.freeze({
  driver_left_atlas: 'Atlas 아님',
  session_restarted: '세션 재개',
  superseded: '새 실행',
  plan_request: '/ulw-plan 요청',
  no_active_run: '실행 없음',
});

function matchesAny(text, commands) {
  if (typeof text !== 'string') return false;
  return commands.some(command => text === command || text.startsWith(`${command} `));
}

function readSafestAtlasDriver(branch) {
  if (!Array.isArray(branch)) return false;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === 'custom' && entry.customType === 'primary-agent/v1') {
      const data = entry.data;
      if (data && typeof data === 'object' && !Array.isArray(data) &&
          data.schemaVersion === 1 && data.agentId === 'atlas') {
        return true;
      }
      // If the newest primary-agent/v1 entry is malformed or not atlas,
      // it treats that as sisyphus (not atlas); an older atlas entry is NOT kept alive or opened.
      return false;
    }
  }
  return false;
}

function disabledReceipt() {
  const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
  if (!agentDir) return;
  const directory = join(agentDir, 'logs');
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, 'oracle-advisor.jsonl'), JSON.stringify({
    at: new Date().toISOString(), event: 'auto-disabled-by-env', status: 'auto-disabled-by-env',
  }) + '\n');
}

export function registerAutoAtlas(pi, runtime) {
  if (process.env.OMO_ORACLE_AUTO_ATLAS === '0') {
    disabledReceipt();
    return { noteSessionStart() {}, noteSessionReady() {} };
  }
  const { ledger, getSessionStatus } = runtime;
  let run = null; // latest owner /ulw-execute run: { run_id }
  let pending = false; // run still waits for its first Atlas turn
  let restarted = false; // resume or fork: the next turn settles the auto job
  const usedRuns = new Set(); // run IDs that were already opened; never reopen for the same run id
  let planEnd = false; // A4: a plan_request end waiting for an open STOP or consult to clear
  let startup = false;
  let awaitingFirstTurn = false;
  let trigger = 'atlas_ulw_execute';

  const openJob = () => {
    const job = ledger.state.job;
    return job && job.status !== 'closed' ? job : null;
  };
  const notify = (ctx, text) => ctx.ui?.notify?.(text, 'info');
  const blockedBy = job => openStops(job).length > 0 || ledger.hasPendingConsult;
  const endAuto = (ctx, job, reason) => {
    ledger.append({ type: 'job_ended', job_id: job.job_id, by: 'auto', reason });
    notify(ctx, `고문 자동 작업 ${job.job_id} 종료: ${REASON_TEXT[reason]}`);
  };
  const pauseAuto = (ctx, job, reason) => {
    ledger.append({ type: 'job_paused', job_id: job.job_id, by: 'auto', reason });
    notify(ctx, `고문 자동 작업 ${job.job_id} 일시정지: ${REASON_TEXT[reason]}`);
  };

  pi.on('input', (event, ctx) => {
    if (!OWNER_SOURCES.has(event?.source)) return;
    if (matchesAny(event?.text, AUTO_TRIGGER.commands)) {
      // The opening execution command belongs to the job just opened at startup.
      if (awaitingFirstTurn && openJob()?.auto?.trigger === 'atlas_session_start') return;
      run = { run_id: randomUUID() };
      pending = true;
      trigger = 'atlas_ulw_execute';
      return;
    }
    // A4: the two end events are plan_request (/ulw-plan) and session_restarted (A1); both end the job and neither pauses it.
    if (matchesAny(event?.text, PLAN_COMMANDS)) {
      const job = openJob();
      if (job?.auto) {
        if (blockedBy(job)) planEnd = true;
        else endAuto(ctx, job, 'plan_request');
      }
      run = null;
      pending = false;
    }
  });

  const beforeStart = (event, ctx) => {
    if (event?.preview === true) return;
    if (getSessionStatus() !== 'lead') return;
    if (startup) {
      startup = false;
      // Never auto-create for any identity except the latest valid Atlas entry.
      // Persisted jobs (including owner-ended jobs) retain owner precedence.
      if (!ledger.state.job && !run && readSafestAtlasDriver(ctx.sessionManager.getBranch())) {
        run = { run_id: randomUUID() };
        pending = true;
        trigger = 'atlas_session_start';
      }
    }
    let job = openJob();
    if (planEnd) { // A4: deferred end waits until no STOP is open and no consult runs
      const held = openJob();
      if (held && blockedBy(held)) return;
      if (held) endAuto(ctx, held, 'plan_request');
      planEnd = false;
      return;
    }
    // a reload does NOT re-seed job-open (horizons restart neutral after a reload)
    if (!run && job?.auto?.run_id) {
      // Rebuild the run from the ledger's auto.run_id on session start / reload
      run = { run_id: job.auto.run_id };
      usedRuns.add(job.auto.run_id);
    }
    if (!pending && !run && !restarted) {
      if (job?.auto && job.status === 'active') {
        // If run was lost after reload, J3 would incorrectly treat it as no run
        pauseAuto(ctx, job, 'no_active_run');
      }
      return;
    }
    if (getSessionStatus() !== 'lead') return;
    const atlas = readSafestAtlasDriver(ctx.sessionManager.getBranch());
    job = openJob();
    if (job && (!job.auto || job.owner_touched)) { // A0, A7
      pending = false;
      restarted = false;
      return;
    }
    if (job) {
      const blocked = openStops(job).length > 0 || ledger.hasPendingConsult;
      if (restarted) { // A1
        if (blocked) return;
        restarted = false;
        endAuto(ctx, job, 'session_restarted');
        return;
      }
      const runId = run?.run_id ?? job.auto.run_id;
      if (pending && atlas && runId !== job.auto.run_id) { // A3
        if (blocked) return; // keep the new run pending until the STOP clears and no consult runs
        endAuto(ctx, job, 'superseded');
        job = null;
      } else if (!atlas) { // A5
        if (job.status === 'active' && !blocked) pauseAuto(ctx, job, 'driver_left_atlas');
        return;
      } else { // A6
        if (job.status === 'paused' && job.paused_by === 'auto') {
          ledger.append({ type: 'job_resumed', job_id: job.job_id, by: 'auto' });
          notify(ctx, `고문 자동 작업 ${job.job_id} 재개: Atlas 복귀`);
        }
        return;
      }
    }
    restarted = false;
    if (!pending || !atlas || !run) return; // A2
    if (usedRuns.has(run.run_id)) {
      pending = false;
      return;
    }
    pending = false;
    usedRuns.add(run.run_id);
    const job_id = `J${ledger.state.next_job_number}`;
    ledger.append({
      type: 'job_opened', job_id, job_epoch: 1, at: new Date().toISOString(),
      auto: { run_id: run.run_id, trigger },
    });
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId) noteJobOpen(sessionId);
    notify(ctx, `고문 자동 작업 ${job_id} 시작 (${trigger === 'atlas_session_start' ? 'Atlas 세션 시작' : 'Atlas /ulw-execute'})`);
  };
  pi.on('before_agent_start', (event, ctx) => {
    beforeStart(event, ctx);
    if (event?.preview !== true) awaitingFirstTurn = false;
  });
  // Called from the extension's existing session_start handler: an extra
  // handler would shift microtask ordering in the consult reload races.
  return {
    noteSessionStart(event) {
      if (RESTART_REASONS.has(event?.reason)) restarted = true;
    },
    noteSessionReady(ctx) {
      startup = !ledger.state.job;
      if (startup && readSafestAtlasDriver(ctx.sessionManager.getBranch())) {
        beforeStart({}, ctx);
        awaitingFirstTurn = true;
      }
    },
  };
}
