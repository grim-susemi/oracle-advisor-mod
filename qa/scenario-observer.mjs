import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Register before the product: attempts must be visible even when a later gate
// blocks. The host emits tool_result only for calls that entered execution,
// unlike tool_execution_start/end, which also describe rejected preflights.
export function observeScenario(pi, emit, { getRuntime } = {}) {
  const owner = new AsyncLocalStorage();
  const invocation = new AsyncLocalStorage();
  const identity = operation => ({
    operation_id: operation.operation_id, scope_id: operation.scope_id,
    call_id: operation.call_id, task_id: operation.task_id,
    request_id: operation.request_id, job_id: operation.job_id,
    job_epoch: operation.job_epoch, reason: operation.reason,
    owner_command_id: operation.owner_command_id,
  });
  const invoke = (entry, name, call_id, action) => {
    const scope = { id: randomUUID(), active: true, operations: [] };
    emit('evidence', { kind: 'retirement_scope_start', scope_id: scope.id, entry, name, call_id });
    return invocation.run(scope, async () => {
      try { return await action(); }
      finally {
        scope.active = false;
        emit('evidence', { kind: 'retirement_scope_end', scope_id: scope.id, entry, name, call_id });
      }
    });
  };
  pi.on('session_start', (_event, ctx) => emit('evidence', {
    kind: 'session_start',
    entries: ctx.sessionManager.getBranch().filter(entry =>
      entry.type === 'custom' && entry.customType === 'oracle-advisor').map(entry => entry.data),
  }));
  pi.on('tool_call', (event, ctx) => {
    emit('evidence', {
      kind: 'attempt', call_id: event.toolCallId, name: event.toolName,
      parent_id: event.parentToolCallId ?? null, input: event.input, cwd: ctx.cwd,
      owner_command: owner.getStore()?.active ? { ...owner.getStore(), active: undefined } : null,
    });
    const scope = invocation.getStore();
    if (scope?.active && event.toolName === 'task_output') {
      const candidates = scope.operations.filter(operation => operation.executed &&
        !operation.snapshot_call_id && operation.task_id === event.input?.task_id);
      if (candidates.length === 1) candidates[0].snapshot_call_id = event.toolCallId;
    }
    const runtime = getRuntime?.();
    if (runtime?.transport?.isRetirementCall(event) !== true) return;
    // Projected oracle_task_id fields are not native ownership facts. Only a
    // unique canonical request with the actual captured task id can identify
    // this private call; the verdict must still confirm execution and release.
    const requests = Object.values(runtime.ledger.state.requests).filter(record =>
      Object.values(record.native_attempts ?? {}).some(fact => fact.task_id === event.input.task_id));
    if (requests.length !== 1) return;
    const request = requests[0];
    const operation = {
      operation_id: randomUUID(), scope_id: scope?.active ? scope.id : null,
      call_id: event.toolCallId, task_id: event.input.task_id,
      request_id: request.request_id, job_id: request.job_id, job_epoch: request.job_epoch,
      reason: event.input.reason, owner_command_id: owner.getStore()?.active ? owner.getStore().id : null,
    };
    if (scope?.active) scope.operations.push(operation);
    emit('evidence', {
      kind: 'retirement_authority', ...identity(operation),
      source: 'runtime.transport.isRetirementCall',
    });
  });
  pi.on('tool_result', event => {
    emit('evidence', {
      kind: 'executed', call_id: event.toolCallId, name: event.toolName,
      parent_id: event.parentToolCallId ?? null, is_error: event.isError,
      result: { content: event.content, details: event.details, structuredContent: event.structuredContent },
    });
    const scope = invocation.getStore();
    if (!scope?.active) return;
    for (const operation of scope.operations) {
      if (event.toolName === 'task_cancel' && operation.call_id === event.toolCallId) {
        operation.executed = event.isError === false &&
          (event.structuredContent ?? event.details)?.task_id === operation.task_id;
      } else if (event.toolName === 'task_output' && operation.snapshot_call_id === event.toolCallId &&
          operation.executed && event.isError === false) {
        operation.snapshot_event_id = randomUUID();
        emit('evidence', { kind: 'retirement_snapshot', ...identity(operation),
          evidence_id: operation.snapshot_event_id, snapshot_call_id: event.toolCallId });
      }
    }
  });
  pi.on('agent_end', () => emit('evidence', { kind: 'agent_end' }));
  return new Proxy(pi, {
    get(target, key) {
      if (key === 'appendEntry') return (customType, data) => {
        const result = target.appendEntry(customType, data);
        if (customType === 'oracle-advisor') {
          const evidence_id = randomUUID(), scope = invocation.getStore();
          let retirement;
          if (scope?.active && data.type === 'oracle_retired' && data.confirmed === true) {
            const matches = scope.operations.filter(operation => operation.executed &&
              operation.snapshot_event_id && !operation.retired_event_id &&
              operation.task_id === data.oracle_task_id && operation.reason === `oracle-advisor: ${data.reason}` &&
              operation.job_id === data.job_id && operation.job_epoch === data.job_epoch);
            if (matches.length === 1) {
              const operation = matches[0];
              operation.retired_event_id = evidence_id;
              retirement = { ...identity(operation), snapshot_event_id: operation.snapshot_event_id,
                snapshot_call_id: operation.snapshot_call_id };
            }
          } else if (scope?.active && data.type === 'consult_lifecycle_result' &&
              data.lifecycle_result?.operation === 'retire' && data.lifecycle_result.status === 'fulfilled') {
            const matches = scope.operations.filter(operation => operation.retired_event_id &&
              !operation.settled && operation.request_id === data.request_id);
            if (matches.length === 1) {
              const operation = matches[0];
              operation.settled = true;
              retirement = { ...identity(operation), snapshot_event_id: operation.snapshot_event_id,
                snapshot_call_id: operation.snapshot_call_id, retired_event_id: operation.retired_event_id };
            }
          }
          emit('evidence', { kind: 'ledger', record: data, evidence_id, ...(retirement ? { retirement } : {}) });
        }
        return result;
      };
      if (key === 'registerTool') return definition => target.registerTool({
        ...definition,
        execute(...args) {
          return invoke('tool', definition.name, args[0], () => definition.execute.apply(this, args));
        },
      });
      if (key === 'on') return (name, handler) => target.on(name,
        ['session_start', 'session_tree', 'session_shutdown'].includes(name)
          ? (...args) => invoke('hook', name, null, () => handler(...args)) : handler);
      if (key === 'registerCommand') return (name, definition) => target.registerCommand(name, {
        ...definition,
        async handler(args, ctx) {
          const scope = { id: randomUUID(), name, args, active: true };
          emit('evidence', { kind: 'command_start', command_id: scope.id, name, args });
          return owner.run(scope, () => invoke('command', name, scope.id, async () => {
            try {
              const result = await definition.handler(args, ctx);
              emit('evidence', { kind: 'command_end', command_id: scope.id, name, args, result });
              return result;
            } finally { scope.active = false; }
          }));
        },
      });
      return Reflect.get(target, key);
    },
  });
}
