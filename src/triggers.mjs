// Pure, JSON-serializable detector state. Persist `state` with the job ledger;
// restore with createTriggerState({ snapshot }) on reload/compaction. The caller
// supplies lifecycle signals and decides whether/how to deliver returned triggers.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function operationKey(logicalTool, effectiveCwd, args) {
  return canonicalJson({ logical_tool: logicalTool, effective_cwd: effectiveCwd, args });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const code = value => (typeof value === 'string' && value.trim() !== '') ||
  (typeof value === 'number' && Number.isFinite(value));

// Never inspect content/details text. exit_code=0 is authoritative success,
// including when misleading prose or an inconsistent isError accompanies it.
export function classifyOutcome(event) {
  const data = object(event.structuredContent);
  if (data.cancelled === true || data.status === 'cancelled') {
    return { outcome: 'cancelled', error_class: null };
  }
  if (Number.isSafeInteger(data.exit_code)) {
    return data.exit_code === 0
      ? { outcome: 'success', error_class: null }
      : { outcome: 'failure', error_class: `exit:${data.exit_code}` };
  }
  let errorClass;
  if (data.timed_out === true || data.timeout === true || data.status === 'timed_out') errorClass = 'timeout';
  else if (code(object(data.error).code)) errorClass = String(data.error.code);
  else if (code(data.code)) errorClass = String(data.code);
  else if (event.isError === true) errorClass = 'tool_error';
  if (errorClass) return { outcome: 'failure', error_class: errorClass };
  return { outcome: event.isError === false ? 'success' : 'unknown', error_class: null };
}

export function createTriggerState({ active = false, snapshot } = {}) {
  if (snapshot) return structuredClone(snapshot);
  return {
    active, progress_revision: 0, completion_covered_revision: null,
    finish_intent_revision: null, predecessor: null, calls: {},
  };
}

const eligible = name => name === 'bash' || name === 'powershell' || /(?:test|check)$/.test(name);
const editTools = new Set(['edit', 'write', 'apply_patch', 'lsp_rename']);
const errorExcerpt = event => {
  let tail = '';
  for (const part of event.content ?? []) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    tail = [...(tail + (tail ? '\n' : '') + part.text)].slice(-2000).join('');
  }
  return tail;
};

// Store one bounded event, not the ever-growing call-id index. The index must
// survive reload for exact dedupe, pending work and late descendant provenance.
export function triggerEvent(event, context = {}) {
  if (event.type === 'tool_call') {
    const input = object(event.input);
    return {
      type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
      parentToolCallId: event.parentToolCallId ?? null,
      operation_key: eligible(event.toolName)
        ? operationKey(event.toolName, event.effective_cwd ?? input.cwd ?? context.cwd ?? '', input) : null,
    };
  }
  if (event.type === 'tool_result') {
    const outcome = classifyOutcome(event);
    return {
      type: event.type, toolCallId: event.toolCallId,
      ...(outcome.outcome === 'failure' ? {
        structuredContent: { error: { code: outcome.error_class } },
        content: [{ type: 'text', text: errorExcerpt(event) }],
      } : outcome.outcome === 'success' ? { isError: false }
        : outcome.outcome === 'cancelled' ? { structuredContent: { cancelled: true } } : {}),
    };
  }
  return { type: event.type, ...(event.progress_revision === undefined
    ? {} : { progress_revision: event.progress_revision }) };
}
const resetChain = state => {
  state.predecessor = null;
  // Retain ids to deduplicate redelivery, but invalidate pending old-scope work.
  for (const call of Object.values(state.calls)) call.invalidated = true;
};
const advance = state => { state.progress_revision++; };

/**
 * Returns {state, triggers} without mutating either input. Host tool events use
 * toolName/toolCallId/input/parentToolCallId; context.cwd is the session cwd and
 * input.cwd (or event.effective_cwd) is the effective operation cwd.
 *
 * Control events: job_started/job_paused/job_resumed/job_ended,
 * seed_rebound/scope_changed, disposition_accepted, finish_intent, and
 * completion_covered {progress_revision}. Only successful completion consults
 * should send completion_covered, using the revision captured in their dossier.
 */
export function reduceTriggers(previousState, event, context = {}) {
  return applyTriggerEvent(structuredClone(previousState), event, context);
}

// The ledger owns this state exclusively during replay, so replay can advance
// its call-id index in place instead of cloning the whole index for every entry.
export function applyTriggerEvent(state, event, context = {}) {
  const triggers = [];
  const completion = source => {
    if (state.completion_covered_revision !== state.progress_revision) {
      triggers.push({ kind: 'completion', source, progress_revision: state.progress_revision });
    }
  };
  if (event.type === 'job_started') {
    resetChain(state);
    state.active = true;
    state.completion_covered_revision = null;
    state.finish_intent_revision = null;
  } else if (event.type === 'job_paused') {
    state.active = false;
  } else if (event.type === 'job_resumed') {
    state.active = true;
  } else if (event.type === 'job_ended') {
    resetChain(state);
    advance(state);
    state.active = false;
  } else if (state.active) {
    if (event.type === 'seed_rebound' || event.type === 'scope_changed') {
      resetChain(state);
      advance(state);
    } else if (event.type === 'disposition_accepted') {
      advance(state);
    } else if (event.type === 'completion_covered') {
      state.completion_covered_revision = event.progress_revision;
    } else if (event.type === 'finish_intent') {
      state.finish_intent_revision = state.progress_revision;
      completion('finish_intent');
    } else if (event.type === 'tool_call') {
      const id = event.toolCallId;
      if (typeof id === 'string' && !Object.hasOwn(state.calls, id)) {
        const name = event.toolName;
        const parent = Object.hasOwn(state.calls, event.parentToolCallId)
          ? state.calls[event.parentToolCallId] : null;
        const oracleDescendant = name === 'oracle_consult' ||
          parent?.tool_name === 'oracle_consult' || parent?.oracle_descendant === true;
        const isEligible = !oracleDescendant && !parent?.invalidated && eligible(name);
        const input = object(event.input);
        if (isEligible) {
          // A wrapper's result is not another verification when an eligible
          // underlying tool performs the work. Preserve the pre-wrapper chain.
          for (let ancestor = parent; ancestor; ancestor =
            Object.hasOwn(state.calls, ancestor.parent_tool_call_id)
              ? state.calls[ancestor.parent_tool_call_id] : null) {
            if (ancestor.eligible) {
              ancestor.delegated = true;
              if (state.predecessor?.tool_call_id === ancestor.tool_call_id) {
                state.predecessor = structuredClone(ancestor.predecessor);
              }
            }
          }
        }
        const call = {
          tool_call_id: id, tool_name: name, eligible: isEligible, completed: false,
          parent_tool_call_id: event.parentToolCallId ?? null, oracle_descendant: oracleDescendant,
          invalidated: parent?.invalidated === true,
          key: isEligible ? event.operation_key ??
            operationKey(name, event.effective_cwd ?? input.cwd ?? context.cwd ?? '', input) : null,
          // Snapshot, never a live link: a concurrent predecessor that fails
          // later must not retroactively make this admission a serial retry.
          predecessor: isEligible && state.predecessor?.outcome === 'failure'
            ? structuredClone(state.predecessor) : null,
        };
        Object.defineProperty(state.calls, id, { value: call, enumerable: true, configurable: true, writable: true });
        if (isEligible) state.predecessor = { tool_call_id: id, outcome: 'pending' };
      }
    } else if (event.type === 'tool_result') {
      const call = Object.hasOwn(state.calls, event.toolCallId) ? state.calls[event.toolCallId] : null;
      if (call && !call.completed && !call.invalidated && !call.oracle_descendant) {
        call.completed = true;
        const outcome = classifyOutcome(event);
        if (call.eligible && !call.delegated) {
          advance(state);
          const predecessor = call.predecessor;
          const same = outcome.outcome === 'failure' && predecessor?.key === call.key &&
            predecessor.error_class === outcome.error_class;
          const summary = {
            tool_call_id: call.tool_call_id, key: call.key, ...outcome,
            count: same ? predecessor.count + 1 : outcome.outcome === 'failure' ? 1 : 0,
            emitted: same ? predecessor.emitted : false,
            ...(outcome.outcome === 'failure' ? {
              error_excerpts: [...(same ? predecessor.error_excerpts ?? [] : []), errorExcerpt(event)].slice(-2),
            } : {}),
          };
          if (same && summary.count === 2 && !summary.emitted) {
            summary.emitted = true;
            triggers.push({
              kind: 'repeated_failure', operation_key: call.key,
              error_class: outcome.error_class, count: 2,
              tool_call_ids: [predecessor.tool_call_id, call.tool_call_id],
              progress_revision: state.progress_revision,
            });
          }
          // Late completion of older/background work cannot replace the latest
          // admitted operation or erase its already-established retry chain.
          if (state.predecessor?.tool_call_id === call.tool_call_id) state.predecessor = summary;
        } else if (editTools.has(call.tool_name) && outcome.outcome === 'success') {
          advance(state);
        } else if (call.tool_name === 'brief') {
          completion('brief');
        }
      }
    }
  }
  return { state, triggers };
}
