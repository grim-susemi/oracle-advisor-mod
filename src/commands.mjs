import { CONSULT_CAP, OVERRIDE_MIN_REASON, REASON_MAX } from './contracts.mjs';
import { openStops } from './ledger.mjs';

const USAGE = '/oracle on|off|end|status|cancel|override <stop_id> <reason>';
export const CHILD_SESSION_MESSAGE = 'not available in task child sessions';

function coordinationSnapshot(ctx) {
  const absent = { coordination: 'absent', coordination_roster: [] };
  try {
    const api = globalThis[Symbol.for('omo.agent-coordination.api.v1')];
    if (api?.version !== 1 || typeof api.getClient !== 'function') return absent;
    const client = api.getClient(ctx);
    if (typeof client?.peers !== 'function') return absent;
    return { coordination: 'present', coordination_roster: client.peers() };
  } catch {
    return absent;
  }
}

export function coordinationPresence(ctx) {
  return coordinationSnapshot(ctx).coordination;
}

export function statusSnapshot(ledger, ctx) {
  const { job } = ledger.state;
  return {
    job, calls_remaining: CONSULT_CAP - (job?.counters.consults ?? 0),
    open_stops: openStops(job).map(stop => stop.stop_id),
    ...coordinationSnapshot(ctx),
  };
}

function statusText(snapshot) {
  const { job, calls_remaining, open_stops, coordination, coordination_roster } = snapshot;
  const presence = `coordination ${coordination}; roster ${JSON.stringify(coordination_roster)}`;
  if (!job) return `oracle: no job; ${presence}; live residency unavailable on this build`;
  const running = Object.values(job.consults).find(consult => consult.status === 'running');
  const elapsed = running?.started_at
    ? `; consult started ${running.started_at}, elapsed ${Math.max(0, Date.now() - Date.parse(running.started_at))}ms`
    : '';
  return `oracle ${job.job_id} epoch ${job.job_epoch}: ${job.status}; ` +
    `consults ${job.counters.consults}/${CONSULT_CAP} (${calls_remaining} remaining); ` +
    `nudges ${job.counters.nudges}; open STOPs ${open_stops.join(', ') || 'none'}; ` +
    `Seed ${job.seed?.hash ?? 'none'} (${job.seed?.source ?? 'unbound'}); ` +
    `oracle task ${job.oracle_task_id ?? 'none'}; residency ${job.residency}; ` +
    `${presence}${elapsed}` +
    (job.residency === 'unavailable' ? '; live residency unavailable on this build' : '');
}

export function registerCommands(pi, runtime) {
  const { ledger, getSessionStatus, transport } = runtime;
  const show = (status, text, extra = {}) => {
    const result = { status, ...extra };
    pi.sendMessage({
      customType: 'oracle-advisor-status', content: text, display: true, details: result,
    }, { triggerTurn: false });
    return result;
  };
  pi.registerCommand('oracle', {
    description: 'Manage the oracle advisor job: on, off, end, status, cancel, override.',
    async handler(args, ctx) {
      const sessionStatus = getSessionStatus();
      if (sessionStatus === 'child') {
        ctx.ui.notify(CHILD_SESSION_MESSAGE, 'warning');
        return { status: 'child_session_refused', message: CHILD_SESSION_MESSAGE };
      }
      if (sessionStatus !== 'lead') return;
      const input = args.trim();
      const [action, ...rest] = input.split(/\s+/);
      const invalid = () => show('invalid_arguments', USAGE);
      if (!['on', 'off', 'end', 'status', 'cancel', 'override'].includes(action)) return invalid();
      if (action !== 'override' && rest.length) return invalid();
      let job = ledger.state.job;
      if (action === 'override') {
        const match = /^override\s+(\S+)\s+(.+)$/s.exec(input);
        const reason = match?.[2].trim();
        if (!match || /[\r\n]/.test(reason) ||
            [...reason].length < OVERRIDE_MIN_REASON || [...reason].length > REASON_MAX ||
            job?.stops[match[1]]?.status !== 'open') return invalid();
        ledger.append({
          type: 'stop_override', job_id: job.job_id, job_epoch: job.job_epoch,
          stop_id: match[1], reason, actor: 'owner',
        });
        return show('overridden', `oracle STOP ${match[1]} overridden by owner`);
      }
      if (action === 'status') {
        const snapshot = statusSnapshot(ledger, ctx);
        return show('status', statusText(snapshot), snapshot);
      }
      if (action === 'cancel') {
        try {
          const result = await (runtime.consult ?? transport)?.cancel(ctx) ?? { status: 'no_consult_running' };
          await transport?.retire(ctx, 'owner_cancel');
          return show(result.status, result.status === 'cancelled' ? 'oracle consult cancelled' : 'no consult running');
        } catch (error) {
          const code = error.code ?? 'oracle_retirement_unconfirmed';
          return show('unavailable', `oracle cancel: ${code}; retirement unconfirmed`, { code });
        }
      }
      if (action === 'on') {
        if (!job || job.status === 'closed') {
          ledger.append({
            type: 'job_opened', job_id: `J${ledger.state.next_job_number}`,
            job_epoch: 1, at: new Date().toISOString(),
          });
        } else if (job.status === 'paused') {
          ledger.append({ type: 'job_resumed', job_id: job.job_id });
        }
      } else if (action === 'off' && job?.status === 'active') {
        ledger.append({ type: 'job_paused', job_id: job.job_id });
      } else if (action === 'end' && job && job.status !== 'closed') {
        try {
          await (runtime.consult ?? transport)?.cancel(ctx);
          await transport?.retire(ctx, 'job_end');
        } catch (error) {
          const code = error.code ?? 'oracle_retirement_unconfirmed';
          return show('unavailable', `oracle end: ${code}; retirement unconfirmed`, { code });
        }
        ledger.append({ type: 'job_ended', job_id: job.job_id, retire_pending: !transport });
      }
      job = ledger.state.job;
      return show(job?.status ?? 'no_job', statusText(statusSnapshot(ledger, ctx)));
    },
  });
}
