import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ROOT, OwnedProcess, cleanupDisposableState, discoverHost,
  disposableEnvironment, hostArgs, sourceHash, writeJson, readJson,
} from '../harness.mjs';
import { startMockProvider } from '../mock-provider.mjs';

const isEvent = name => event =>
  event.type === 'extension_event' &&
  event.name === 'oracle-qa.probe-r3-seams' &&
  event.data.event === name;

export async function runProbeR3SeamsCase(values) {
  if (isAbsolute(values.attempt) || !/^[a-zA-Z0-9_-]+$/.test(values.attempt)) {
    throw new Error('Attempt must be a simple name');
  }

  const host = discoverHost();
  const attemptDir = join(ROOT, '.omo/evidence', values.attempt);
  const evidenceDir = join(attemptDir, 'task-2-piomo-oracle-advisor-mod');
  mkdirSync(evidenceDir, { recursive: true });
  const runDir = mkdtempSync(join(evidenceDir, 'probe-r3-seams-'));

  // Per required_fixes #5: write to a per-attempt path, NEVER directly overwrite <ev>/task-2/probe.json
  const perAttemptEvidenceDir = join('C:/Users/USER/orca/projects/기타 작업/.omo/evidence/r3-advisor-seams/task-2/runs', values.attempt);
  mkdirSync(perAttemptEvidenceDir, { recursive: true });

  const receipt = {
    case: 'probe-r3-seams',
    status: 'running',
    exit_code: null,
    source_hash: sourceHash(),
    started_at: new Date().toISOString(),
    run_dir: runDir,
    cleanup: {},
    pids_started: [],
    pids_exited: [],
    temp_dirs_created: [],
    temp_dirs_removed: [],
  };

  let mock;
  let child1, sandbox1;
  let child2, sandbox2;

  try {
    mock = await startMockProvider();

    // -------------------------------------------------------------
    // RUN 1: Default host (--no-skills --no-prompt-templates)
    // Measures P1, P2 (default variant), P3, P4, P5, P6, P7
    // -------------------------------------------------------------
    const dir1 = join(runDir, 'host-default');
    mkdirSync(dir1);
    sandbox1 = disposableEnvironment(host, dir1, {
      ORACLE_QA_MOCK_URL: mock.baseUrl,
      ORACLE_QA_ATTEMPT: values.attempt,
      OMO_ORACLE_ADVISOR: '1',
      SENPI_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
      OMO_RPC_CLIENT_CAPABILITIES: 'extension_events,interactive_user',
    });
    receipt.temp_dirs_created.push(sandbox1.stateDir);

    // Disposable omo.jsonc with astra-high alias defined under [native].models
    const taskState1 = join(sandbox1.stateDir, 'senpi-task');
    writeJson(join(sandbox1.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: taskState1, default_execution_mode: 'in-process' },
        agents: { oracle: { model: 'oracle-qa-mock/oracle', tools: { read: true } } },
        models: {
          'astra-high': {
            model: 'oracle-qa-mock/gpt-6-astra',
            variant: 'high',
          },
        },
      },
    });

    const candidate = join(ROOT, 'qa/cases/probe-r3-seams-extension.mjs');
    const args1 = [
      ...hostArgs(host, sandbox1, candidate, { main: 'mock' }),
      '--tools', 'probe_tool,oracle_consult,oracle_bind_seed,oracle_advisor,oracle_record_stop,task,task_send,task_cancel,task_output,read',
      '--system-prompt', 'Owned R3 seams probe session. Call requested tools then reply.',
    ];

    child1 = new OwnedProcess(process.execPath, args1, {
      cwd: sandbox1.workDir,
      env: sandbox1.env,
      rawPrefix: join(dir1, 'host'),
      deadlineMs: 600000,
    });
    receipt.pids_started.push(child1.metadata.pid);

    await child1.rpc('get_state');
    await child1.rpc('set_client_info', {
      capabilities: ['interactive_user', 'extension_events'],
    });
    await child1.waitFor(isEvent('ready'), 'extension ready');

    // --- P2: send slash commands over RPC ---
    const p2DefaultResults = [];
    for (const text of ['/ulw-execute probe', '/skill:ulw-execute probe', '/skill:ulw-plan probe']) {
      const from = child1.history.length;
      const seenPromise = child1.waitFor(e => isEvent('input_seen')(e) && (e.data.text === text || e.data.text?.includes(text.slice(1))), `P2 input ${text}`, { from, timeoutMs: 10000 }).catch(err => ({ error: err.message }));
      await child1.prompt(text);
      const seen = await seenPromise;
      p2DefaultResults.push({
        text,
        source: seen.data?.source ?? null,
        reached: Boolean(seen.data),
        data: seen.data ?? seen,
      });
    }

    // --- P3: check system prompt order and preview pass ---
    // Observed prompts from events:
    const p3SafeEvent = child1.history.find(e => isEvent('before_agent_start_preview_safe')(e));
    const p3NormalEvent = child1.history.find(e => isEvent('before_agent_start_normal')(e));
    // Check if normal event input prompt includes [PROMPT_PART_1]
    const part1ObservedInNormal = Boolean(p3NormalEvent?.data?.systemPrompt?.includes('[PROMPT_PART_1]'));
    const observedOrder = part1ObservedInNormal ? ['previewSafe:true', 'previewSafe:false'] : ['unknown'];

    const previewRanSafe = Boolean(child1.history.some(e => e.data?.preview && e.data?.event === 'before_agent_start_preview_safe'));
    const previewRanNormal = Boolean(child1.history.some(e => e.data?.preview && e.data?.event === 'before_agent_start_normal'));

    // --- P4: branch entry append and observation in same turn ---
    const fromP4 = child1.history.length;
    const p4Seen = child1.waitFor(isEvent('p4_branch_check'), 'p4 branch check', { from: fromP4, timeoutMs: 15000 });
    await child1.prompt('probe-p4-atlas trigger');
    const p4Res = await p4Seen;

    // --- P5: ctx.model in before_agent_start and tool execute ---
    const p5BeforeAgent = child1.history.findLast(e => isEvent('p5_before_agent_start_model')(e))?.data?.model ?? null;
    const p5ToolExecPromise = child1.waitFor(isEvent('p5_tool_execute_model'), 'p5 tool model');
    mock.steps.push({
      tool: 'probe_tool',
      arguments: { action: 'ping' },
    });
    await child1.prompt('Run probe_tool ping');
    const p5ToolRes = await p5ToolExecPromise;
    const p5ToolExec = p5ToolRes?.data?.model ?? null;

    // --- P1: Test native task spawn with forms (control, a, b, c, d, e) ---
    // Required fix #1: add a real no-model control (same oracle task call without model).
    // Required fix #2: persist raw child provider-request records, set readonly by exact equality with oracle allow-list.
    const p1Forms = [
      { id: 'control', form: null, description: 'oracle task without model override', decisive: false },
      { id: 'a', form: 'oracle-qa-mock/gpt-6-astra:high', decisive: true },
      { id: 'b', form: 'oracle-qa-mock/gpt-6-astra', decisive: true },
      { id: 'c', form: 'astra-high', decisive: true },
      { id: 'd', form: 'chatgpt-subscription/gpt-6-astra:high', decisive: false },
      { id: 'e', form: 'no-such/model', decisive: false },
    ];

    // Read-only tools defined for oracle in disposable config: ['read']
    const expectedReadOnlyTools = ['read'];

    const p1Results = [];
    for (const item of p1Forms) {
      const fromRequests = mock.requests.length;
      const fromEvents = child1.history.length;

      const label = item.form ?? 'no-model-control';
      const spawnResultPromise = child1.waitFor(e => isEvent('task_spawn_result')(e) || isEvent('task_spawn_error')(e), `P1 spawn ${label}`, { from: fromEvents, timeoutMs: 20000 }).catch(err => ({ error: err.message }));

      mock.steps.push({
        tool: 'probe_tool',
        arguments: { action: 'task_spawn', params: { ...(item.form ? { model: item.form } : {}), prompt: `QA test prompt for ${label}` } },
      });

      await child1.prompt(`Execute task_spawn for ${label}`);
      const spawnEvent = await spawnResultPromise;

      // Find matching child provider request(s)
      const childReqs = mock.requests.slice(fromRequests).filter(r => r.model === 'oracle' || r.model === 'gpt-6-astra' || r.model?.includes('astra'));
      const matchingReq = childReqs.at(-1) ?? null;

      let accepted = false;
      let error = null;
      let childModel = null;
      let thinking = null;
      let readonly = null;

      if (spawnEvent?.data?.outcome) {
        const out = spawnEvent.data.outcome;
        const details = out.details ?? {};
        const isErr = spawnEvent.data.isError || out.isError || details.status === 'error' || details.status === 'plan_error';
        if (!isErr) {
          accepted = true;
          childModel = matchingReq?.model ?? details.resolved_model?.model_id ?? details.model ?? null;
          thinking = matchingReq?.reasoning ?? matchingReq?.thinking ?? details.resolved_model?.variant ?? null;
          if (matchingReq?.body?.tools) {
            const toolNames = matchingReq.body.tools.map(t => t.function?.name ?? t.name).filter(Boolean).sort();
            readonly = JSON.stringify(toolNames) === JSON.stringify(expectedReadOnlyTools);
          }
        } else {
          accepted = false;
          error = details.error?.message ?? details.error?.code ?? details.reason ?? out.content?.[0]?.text ?? 'unknown_error';
        }
      } else if (spawnEvent?.data?.error) {
        accepted = false;
        error = spawnEvent.data.error.message ?? spawnEvent.data.error.code ?? 'spawn_error';
      } else {
        accepted = false;
        error = spawnEvent?.error ?? 'timeout';
      }

      // Map refusal status according to src/transport.mjs:20-43
      let mappedStatus = null;
      if (!accepted && spawnEvent?.data?.outcome) {
        const out = spawnEvent.data.outcome;
        const details = out.details ?? {};
        const codes = [out.kind, out.status, out.code, details.kind, details.status, details.code, details.error?.code].filter(Boolean);
        if (codes.includes('lane_capacity')) mappedStatus = 'unavailable';
        else if (['not_continuable', 'not_found', 'no_resident_session'].some(c => codes.includes(c))) mappedStatus = 'oracle_dead';
        else if (codes.includes('timed_out')) mappedStatus = 'timed_out';
        else if (['quota', 'rate_limit', 429, '429'].some(c => codes.includes(c))) mappedStatus = 'quota';
        else if (['cancelled', 'oracle_dead'].some(c => codes.includes(c))) mappedStatus = codes.includes('cancelled') ? 'cancelled' : 'oracle_dead';
        else mappedStatus = 'unavailable';
      }

      // Raw child provider request persistence
      const rawRequest = matchingReq ? {
        index: matchingReq.index,
        model: matchingReq.model,
        reasoning: matchingReq.reasoning,
        thinking: matchingReq.thinking,
        tools: (matchingReq.body?.tools ?? []).map(t => t.function?.name ?? t.name).filter(Boolean).sort(),
        rawBodyLength: matchingReq.rawBody?.length ?? 0,
      } : null;

      p1Results.push({
        id: item.id,
        form: item.form,
        decisive: item.decisive,
        accepted,
        error,
        mappedStatus,
        childModel,
        thinking,
        readonly,
        rawRequest,
      });
    }

    // --- P6: switch main model over RPC set_model ---
    const p6Switches = [];
    for (const targetModel of ['oracle-qa-mock/gpt-qa', 'oracle-qa-mock/claude-qa']) {
      const [provider, modelId] = targetModel.split('/');
      let accepted = false;
      let switchRes = null;
      try {
        switchRes = await child1.rpc('set_model', { provider, modelId });
        accepted = true;
      } catch (err) {
        accepted = false;
        switchRes = { error: err.message, code: err.code };
      }

      // Check ctx.model on next turn
      const nextTurnModelPromise = child1.waitFor(isEvent('p5_before_agent_start_model'), `P6 next model for ${targetModel}`, { from: child1.history.length, timeoutMs: 15000 });
      await child1.prompt(`Turn after switch to ${targetModel}`);
      const nextTurnEvent = await nextTurnModelPromise;
      const nextModelId = nextTurnEvent?.data?.model?.id ?? null;

      p6Switches.push({
        model: targetModel,
        accepted,
        switchResult: switchRes,
        nextModelId,
      });
    }

    // --- P7: owner Stop during a running consult ---
    // Start /oracle on
    const fromCmd = child1.history.length;
    const oracleOnPromise = child1.waitFor(e => isEvent('command')(e) && e.data.name === 'oracle' && e.data.args === 'on', 'oracle on', { from: fromCmd });
    await child1.rpc('prompt', { message: '/oracle on' });
    await oracleOnPromise;

    // Start oracle_consult with hold in mock provider
    const consultToolPromise = child1.waitFor(isEvent('tool_executed'), 'consult tool executed', { from: child1.history.length, timeoutMs: 30000 }).catch(err => ({ error: err.message }));

    mock.steps.push({
      tool: 'oracle_consult',
      arguments: { kind: 'work', question: 'QA_HOLD: Is this plan sound?' },
    });

    const holdArrivalPromise = mock.awaitHold(15000);
    const promptAbortPromise = child1.rpc('prompt', { message: 'Run oracle consult with QA_HOLD' }).catch(err => ({ error: err.message }));

    // Await mock provider hold arrival: Stop fires ONLY AFTER the mock provider has actually received and is holding the request
    await holdArrivalPromise;

    // Send RPC abort (stop intent)
    let abortResult = null;
    try {
      abortResult = await child1.rpc('abort', { intent: 'stop' });
    } catch (err) {
      abortResult = { error: err.message, code: err.code };
    }

    const consultToolRes = await consultToolPromise;
    const parentEnded = await promptAbortPromise;

    // Check task records under senpi-task/tasks/
    const tasksDir = join(taskState1, 'tasks');
    let childRecords = [];
    if (existsSync(tasksDir)) {
      for (const f of readdirSync(tasksDir)) {
        if (f.endsWith('.json')) {
          try {
            childRecords.push(JSON.parse(readFileSync(join(tasksDir, f), 'utf8')));
          } catch {}
        }
      }
    }

    // Measure afterRelease: release mock provider hold and record observation
    const releaseObservation = mock.releaseHold();

    // Inspect raw host events for sessionHoldObserved and interruptedResultObserved
    const sessionPausedEvent = child1.history.find(e => e.type === 'session_paused' && e.kind === 'session_hold');
    const sessionHoldEntry = child1.history.find(e => e.type === 'entry_appended' && e.entry?.customType === 'session-hold');
    const sessionHoldObserved = Boolean(sessionPausedEvent || sessionHoldEntry);

    const interruptedToolEnd = child1.history.find(e => e.type === 'tool_execution_end' && e.toolName === 'oracle_consult' && e.result?.details?.interrupted);
    const interruptedResultObserved = Boolean(interruptedToolEnd);

    // Follow-up consult measurement: derive observedHostBehavior from actual events
    const nextConsultDispatched = child1.waitFor(e => isEvent('native_tool_call')(e) && e.data.name === 'task', 'follow up task dispatch', { from: child1.history.length, timeoutMs: 8000 }).catch(err => ({ error: err.message }));

    const nextConsultFinished = child1.waitFor(e => isEvent('tool_executed')(e) && e.data.name === 'oracle_consult', 'next consult finished', { from: child1.history.length, timeoutMs: 8000 }).catch(err => ({ error: err.message }));

    mock.steps.push({
      tool: 'oracle_consult',
      arguments: { kind: 'work', question: 'Follow-up question after Stop' },
    });

    // Send follow up prompt
    const followUpPrompt = child1.rpc('prompt', { message: 'Run follow up oracle consult' }).catch(err => ({ error: err.message }));

    const dispatchedResult = await nextConsultDispatched;
    const finishedResult = await nextConsultFinished;

    // Find follow-up task tool execution end event and task_output event in history
    const followUpTaskSpawnEnd = child1.history.find(e => e.type === 'tool_execution_end' && e.toolName === 'task' && e.result?.details?.status === 'paused');
    const followUpTaskOutputEnd = child1.history.find(e => e.type === 'tool_execution_end' && e.toolName === 'task_output' && e.result?.details?.kind === 'not_found');

    const spawnDetails = followUpTaskSpawnEnd?.result?.details ?? {};
    const outputDetails = followUpTaskOutputEnd?.result?.details ?? {};

    const followUpPausedAdmission = {
      task_id: spawnDetails.task_id ?? null,
      status: spawnDetails.status ?? null,
      pause_seq: spawnDetails.pause_seq ?? null,
      message: followUpTaskSpawnEnd?.result?.content?.[0]?.text ?? null,
    };

    const derivedHostBehavior = `Task spawn returned status "${spawnDetails.status ?? 'unknown'}" (pause_seq ${spawnDetails.pause_seq ?? 'unknown'}, text: "${followUpTaskSpawnEnd?.result?.content?.[0]?.text ?? ''}"); task_output returned kind "${outputDetails.kind ?? 'unknown'}" (${outputDetails.reason ?? ''}); consult finishedWithinTimeout: ${!finishedResult?.error}`;

    const p7Result = {
      toolReturn: consultToolRes?.data?.result ?? consultToolRes,
      childRecord: childRecords.find(r => r.task_id === child1.history.find(e => e.type === 'entry_appended' && e.entry?.data?.type === 'oracle_assigned')?.entry?.data?.oracle_task_id) ?? childRecords.at(-1) ?? null,
      parentEnded: Boolean(parentEnded),
      afterRelease: releaseObservation,
      hostEventsObserved: {
        abortResult,
        sessionHoldObserved,
        interruptedResultObserved,
        interruptedDetails: interruptedToolEnd?.result?.details?.interrupted ?? null,
      },
      nextConsult: {
        dispatched: !dispatchedResult?.error,
        dispatchedDetails: dispatchedResult?.data ?? dispatchedResult,
        finishedWithinTimeout: !finishedResult?.error,
        finishedResult: finishedResult?.data?.result ?? finishedResult,
        observedHostBehavior: derivedHostBehavior,
        followUpPausedAdmission,
        followUpTaskOutputResult: outputDetails,
      },
    };

    // Stop child1
    await child1.stop({ force: true });
    receipt.pids_exited.push(child1.metadata.pid);
    const clean1 = cleanupDisposableState(sandbox1);
    receipt.temp_dirs_removed.push(clean1.path);

    // -------------------------------------------------------------
    // RUN 2: Skills loaded variant for P2
    // -------------------------------------------------------------
    const dir2 = join(runDir, 'host-skills');
    mkdirSync(dir2);
    sandbox2 = disposableEnvironment(host, dir2, {
      ORACLE_QA_MOCK_URL: mock.baseUrl,
      ORACLE_QA_ATTEMPT: `${values.attempt}-sk`,
      OMO_ORACLE_ADVISOR: '0',
    });
    receipt.temp_dirs_created.push(sandbox2.stateDir);

    const taskState2 = join(sandbox2.stateDir, 'senpi-task');
    writeJson(join(sandbox2.home, '.omo/omo.jsonc'), {
      '[native]': {
        task: { state_dir: taskState2, default_execution_mode: 'in-process' },
        agents: { oracle: { model: 'oracle-qa-mock/oracle' } },
      },
    });

    // Run host args WITHOUT --no-skills
    const baseArgs2 = hostArgs(host, sandbox2, candidate, { main: 'mock' })
      .filter(arg => arg !== '--no-skills');

    child2 = new OwnedProcess(process.execPath, baseArgs2, {
      cwd: sandbox2.workDir,
      env: sandbox2.env,
      rawPrefix: join(dir2, 'host'),
      deadlineMs: 300000,
    });
    receipt.pids_started.push(child2.metadata.pid);

    await child2.rpc('get_state');
    await child2.waitFor(isEvent('ready'), 'extension ready');

    const p2SkillsResults = [];
    for (const text of ['/ulw-execute probe', '/skill:ulw-execute probe', '/skill:ulw-plan probe']) {
      const from = child2.history.length;
      const seenPromise = child2.waitFor(e => isEvent('input_seen')(e) && (e.data.text === text || e.data.text?.includes(text.slice(1))), `P2 skills input ${text}`, { from, timeoutMs: 10000 }).catch(err => ({ error: err.message }));
      await child2.prompt(text);
      const seen = await seenPromise;
      p2SkillsResults.push({
        text,
        source: seen.data?.source ?? null,
        reached: Boolean(seen.data),
        data: seen.data ?? seen,
      });
    }

    await child2.stop({ force: true });
    receipt.pids_exited.push(child2.metadata.pid);
    const clean2 = cleanupDisposableState(sandbox2);
    receipt.temp_dirs_removed.push(clean2.path);

    // -------------------------------------------------------------
    // Synthesize P1-P7 and Decision
    // -------------------------------------------------------------
    const formA = p1Results.find(r => r.id === 'a');
    const formB = p1Results.find(r => r.id === 'b');
    const formC = p1Results.find(r => r.id === 'c');

    let decision = 'UNKNOWN';
    let defaultPin = '';
    let isBlocked = false;
    let blockReason = '';

    if (formA?.accepted && (formA.thinking === 'high' || formA.rawRequest?.reasoning === 'high' || formA.rawRequest?.thinking === 'high')) {
      decision = 'provider/model:level';
      defaultPin = 'chatgpt-subscription/gpt-6-astra:high';
    } else if (formA?.accepted && !formA.thinking && !formA.rawRequest?.reasoning) {
      decision = 'BLOCKED';
      isBlocked = true;
      blockReason = 'form (a) accepted but request carries no level';
    } else if (!formA?.accepted && formB?.accepted) {
      decision = 'BLOCKED';
      isBlocked = true;
      blockReason = 'form (a) refused while (b) accepted; cannot pin level';
    } else if (!formA?.accepted && !formB?.accepted && formC?.accepted) {
      decision = 'alias';
      defaultPin = 'astra-high';
    } else {
      decision = 'BLOCKED';
      isBlocked = true;
      blockReason = 'none of (a)-(c) accepted or readonly lost';
    }

    const controlRow = p1Results.find(r => r.id === 'control');

    const probeEvidence = {
      pins: {
        omo: host.versions.omo_ai,
        senpi: host.versions.senpi,
        launcher: host.launcher,
        engine: host.engine,
        plugin: host.plugin,
      },
      P1: {
        forms: p1Results.filter(r => r.id !== 'control'),
        control: controlRow,
      },
      P2: {
        variants: [
          { skills: false, inputs: p2DefaultResults },
          { skills: true, inputs: p2SkillsResults },
        ],
      },
      P3: {
        order: observedOrder,
        previewRan: { safe: previewRanSafe, normal: previewRanNormal },
        senpiPreviewRule: 'In Senpi chunk-J2U5VDG7.js: preview is skipped entirely if any before_agent_start handler lacks previewSafe',
      },
      P4: {
        seen: Boolean(p4Res?.data?.entriesCount > 0),
        data: p4Res?.data ?? null,
      },
      P5: {
        beforeAgentStart: p5BeforeAgent,
        toolExecute: p5ToolExec,
      },
      P6: {
        switches: p6Switches,
      },
      P7: p7Result,
      decision: {
        grammar: decision,
        defaultPin,
        isBlocked,
        blockReason,
      },
      receipt_path: join(runDir, 'receipt.json'),
    };

    // Write to per-attempt path: <ev>/task-2/runs/<attempt>/probe.json and pin-grammar.txt
    writeJson(join(perAttemptEvidenceDir, 'probe.json'), probeEvidence);
    writeFileSync(join(perAttemptEvidenceDir, 'pin-grammar.txt'), isBlocked ? `BLOCKED: ${blockReason}\n` : `${decision}\n`);

    receipt.status = isBlocked ? 'blocked' : 'passed';
    receipt.exit_code = isBlocked ? 1 : 0;
    receipt.probe = probeEvidence;
  } catch (error) {
    receipt.status = 'failed';
    receipt.exit_code = 1;
    receipt.error = { message: error.message, stack: error.stack };
  } finally {
    if (child1 && !receipt.pids_exited.includes(child1.metadata.pid)) {
      try { await child1.stop({ force: true }); receipt.pids_exited.push(child1.metadata.pid); } catch {}
    }
    if (child2 && !receipt.pids_exited.includes(child2.metadata.pid)) {
      try { await child2.stop({ force: true }); receipt.pids_exited.push(child2.metadata.pid); } catch {}
    }
    if (mock) {
      await mock.close();
    }
    if (sandbox1 && existsSync(sandbox1.stateDir)) {
      try { const c = cleanupDisposableState(sandbox1); receipt.temp_dirs_removed.push(c.path); } catch {}
    }
    if (sandbox2 && existsSync(sandbox2.stateDir)) {
      try { const c = cleanupDisposableState(sandbox2); receipt.temp_dirs_removed.push(c.path); } catch {}
    }
    receipt.finished_at = new Date().toISOString();
    writeJson(join(runDir, 'receipt.json'), receipt);
    console.log(JSON.stringify({
      receipt: join(runDir, 'receipt.json'),
      status: receipt.status,
      exit_code: receipt.exit_code,
      decision: receipt.probe?.decision,
      error: receipt.error?.message,
    }));
    process.exitCode = receipt.exit_code;
  }
}
