import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLedger } from './ledger.mjs';
import { CHILD_SESSION_MESSAGE, openAdvisorJob, registerCommands } from './commands.mjs';
import { registerSeedTool } from './seed.mjs';
import { createTransport } from './transport.mjs';
import { registerConsultTool } from './consult.mjs';
import { registerNudger } from './nudger.mjs';
import { registerStopGate } from './stop-gate.mjs';

export const REGISTRATION_KEY = Symbol.for('omo.oracle-advisor.v1');

export function isLeadSession(pi, ctx) {
  if (pi.sessionKind !== 'interactive') return false;
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file === undefined) return true;
    let canonical = resolve(file);
    try { canonical = realpathSync.native(canonical); } catch { /* The session file may not exist yet. */ }
    canonical = canonical.replace(/\\/g, '/');
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    return !/(?:^|\/)senpi-task\/children(?:\/|$)/.test(canonical);
  } catch {
    return false;
  }
}

function disabledReceipt() {
  const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR;
  if (!agentDir) return;
  const directory = join(agentDir, 'logs');
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, 'oracle-advisor.jsonl'), JSON.stringify({
    at: new Date().toISOString(), event: 'disabled-by-env', status: 'disabled-by-env',
  }) + '\n');
}

export default function extension(pi) {
  if (pi.sessionKind !== 'interactive') return;
  const registration = globalThis[REGISTRATION_KEY] ??= {
    generation: 0, liveGenerations: 0, runtime: null, disabled: false,
  };
  if (process.env.OMO_ORACLE_ADVISOR === '0') {
    if (!registration.disabled) {
      disabledReceipt();
      registration.disabled = true;
    }
    return;
  }
  if (registration.runtime) return registration.runtime;
  const generation = ++registration.generation;
  registration.liveGenerations++;
  const ledger = createLedger(pi);
  let identity = 'unknown';
  const runtime = {
    generation, ledger,
    getSessionStatus,
    registerTool(definition) {
      pi.registerTool({
        ...definition,
        async execute(...args) {
          const sessionStatus = getSessionStatus();
          if (sessionStatus === 'child') return {
            content: [{ type: 'text', text: CHILD_SESSION_MESSAGE }],
            details: { status: 'child_session_refused' },
            structuredContent: { status: 'child_session_refused' },
          };
          if (sessionStatus !== 'lead') return {
            content: [], details: { status: 'session_not_ready' },
            structuredContent: { status: 'session_not_ready' },
          };
          return definition.execute(...args);
        },
      });
    },
  };
  registration.runtime = runtime;
  const isCurrent = () => registration.runtime === runtime;
  function getSessionStatus() {
    if (identity === 'child') return 'child';
    return registration.runtime === runtime ? identity : 'inactive';
  }
  const release = () => {
    runtime.transport.dispose();
    registration.runtime = null;
    registration.liveGenerations--;
  };
  runtime.transport = createTransport(pi, { ledger, getSessionStatus });
  registerCommands(pi, runtime);
  registerSeedTool(pi, runtime);
  registerConsultTool(pi, runtime);
  registerStopGate(pi, runtime);
  registerNudger(pi, runtime);
  const rebuild = async (ctx, branchSwitch = false) => {
    const previousJob = ledger.state.job;
    runtime.consult.invalidate(branchSwitch ? 'stale_reservation' : 'interrupted');
    // Reconstruct before cleanup can suspend or fail. Each continuation reads
    // the selected path again, never reinstating the abandoned branch's state.
    let path;
    const refresh = () => {
      const branch = ctx.sessionManager.getBranch();
      const entries = ctx.sessionManager.getEntries();
      const selected = [branch.length, branch.at(-1)?.id, entries.length, entries.at(-1)?.id];
      if (!path || selected.some((value, index) => value !== path[index])) {
        ledger.rebuild(branch, entries);
        // rebuild may append an interruption; a subsequent refresh must see it.
        path = selected;
      }
    };
    refresh();
    const failed = (phase, error) => {
      ledger.append({ type: 'transport_failed', phase, status: 'unavailable',
        code: error.code ?? 'native_error' });
      pi.sendMessage({
        customType: 'oracle-advisor-transport', content: `oracle ${phase}: advice unavailable`,
        display: true, details: { status: 'unavailable', code: error.code ?? 'native_error' },
      }, { triggerTurn: false });
    };
    try {
      if (branchSwitch) await runtime.transport.branchSwitch(ctx, previousJob);
      else if (runtime.transport.running) await runtime.transport.cancel();
    } catch (error) { failed('rebuild_cancel', error); }
    refresh();
    try { await runtime.transport.restore(ctx); }
    catch (error) { failed('rebuild_restore', error); }
    finally { refresh(); }
  };
  pi.on('session_start', async (event, ctx) => {
    if (!isCurrent()) return;
    if (identity === 'unknown') {
      identity = isLeadSession(pi, ctx) ? 'lead' : 'child';
      if (identity === 'child') {
        release();
        return;
      }
    }
    await rebuild(ctx);
    if (!ledger.state.job) openAdvisorJob(ledger, 'session-default');
  });
  pi.on('session_tree', async (event, ctx) => {
    if (getSessionStatus() !== 'lead') return;
    await rebuild(ctx, true);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (getSessionStatus() !== 'lead') return;
    runtime.consult.invalidate('interrupted');
    try { await runtime.transport.shutdown(ctx); }
    finally { release(); }
  });
  return runtime;
}
