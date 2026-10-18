# Oracle advisor product rules

Independent, removable PiOMO extension. Node >=24, ESM `.mjs`, built-ins only.
Runtime code uses only the supplied `pi` ExtensionAPI, never an SDK import.
`qa/` is test-only: its local provider is not a product provider call.

## Required behavior

- Lead sessions only: return immediately unless `pi.sessionKind === "interactive"`;
  also reject session paths under `senpi-task/children/`. Consults refuse in task children.
- `OMO_ORACLE_ADVISOR=0` registers no hooks or tools and writes one
  `disabled-by-env` receipt.
- Interactive lead `session_start` opens a job by default only when none exists,
  with `opened_by: "session-default"`; command opens use `"command"`.
  Opening never spawns or calls a model. `/oracle off` pauses for the session;
  `OMO_ORACLE_ADVISOR=0` disables globally. Reload preserves paused/closed jobs.
- Commands: `/oracle on`, `off` (pause, retain state), `end` (close and retire),
  `status`, `cancel` (owner abort), `override <stop_id> <reason>`.
  No nudge, gate or consult without an active job.
- Tools: `oracle_consult({kind:"work"|"completion",question,claims?})`,
  `oracle_advisor({action:"finish_intent"})`,
  `oracle_record_stop({stop_id,decision:"proceed"|"redirect"|"halt",reason,next_step,evidence_refs?})`,
  `oracle_bind_seed({seed_yaml})`.
- Persist job id/epoch, owned oracle ids, consults, verdicts, STOPs, dispositions,
  overrides, Seed pin and counters via `pi.appendEntry("oracle-advisor", data)`.
  Rebuild from the current branch on `session_start` and `session_tree`.
  Reload marks an in-flight consult interrupted, never replays it.
- Append accounting events to `<agentDir>/logs/oracle-advisor.jsonl`, where
  agentDir is `SENPI_CODING_AGENT_DIR ?? OMO_CODING_AGENT_DIR`.
  `src/contracts.mjs` owns the complete receipt field list. No secrets or full transcript.
- One owned resident oracle per job when the capability probe proves polling-free
  revival completion. Spawn via native `task`, revive via `task_send`. Revival
  failure gets exactly one fresh run with the full dossier, a `revival_failed`
  entry, a visible notice, and retirement of the old id. If residency is unproven,
  use fresh runs with full prior records and say "live residency unavailable on this build".
- Retire means cancel a non-terminal owned oracle, or release a terminal resident
  through `task_cancel`'s `released` path; confirm terminal and no resident handle.
  Retire on end, revival failure, answered-but-running record, branch switch,
  owner abort that did not reach the child, and shutdown with a consult in flight.
  Never retire between normal consults of a live resident.
- Guard direct main `task_send`/`task_cancel` to job oracle ids; point to
  `oracle_consult` or `/oracle end`. Nested calls exempt by `parentToolCallId`.
- Oracle is read-only. Only a capability-proven exclusive boolean `tools` map is
  acceptable, never a deny-list substitute. The later installer backs up and
  drift-checks effective oracle ranges and restores on uninstall. At job open
  and fresh spawn check the actual surface; write/exec/spawn means refuse with
  visible `oracle_not_readonly`.
- Four consults per job: three work plus one reserved completion; one concurrent.
  Three nudges: two failure plus one completion. No automatic retries or model
  fallback. **No consult time limit.** End a wait only on answer, confirmed death,
  host provider error (host timeout recorded `timed_out`), or owner abort
  (`cancelled`). Keep a visible running status while waiting.
- Optional coordination API is
  `globalThis[Symbol.for("omo.agent-coordination.api.v1")]`: require version 1 and
  `getClient`; only `peers`/`onPeersChanged` for presence/liveness. Errors mean absent.
- STOP gates tool actions until disposition/owner override. It cannot block a
  plain-text final answer; show `STOP unresolved` at settle time instead.

## Boundaries

- Never patch PiOMO/Senpi/omo-ai, other mods or the coordination mod.
  No settings edits beyond the later managed installer shim; the only approved
  config delta is the later oracle allowlist in `omo.jsonc`, with separate live approval.
- No direct model/provider calls from product runtime, no fallback, retries,
  timers or polling loops. Native `task`/`task_send` only.
  Never force follow-up nudges (`deliverAs:"followUp", triggerTurn:true`).
- No prose keywords as failure/completion triggers; never infer failure from text.
- Unavailable, timed-out or invalid oracle answers never become STOP or CONTINUE;
  they are unavailable. An existing STOP stays held.
- Never cancel non-owned tasks. Never copy credentials. Never touch the owner's
  conversation, panes, workers, games or live agent configuration during QA.
- No taste charter, blueprint board, main-model changes, coordination changes,
  live installation, commit or push without separate owner approval.

## Verification

TDD: failing contract first. `npm test`, `npm run check`; real host cases via
`npm run qa -- --case <name> --attempt <name> [--oracle mock]`.
No dependencies. Async tests subscribe before triggering and await bounded events;
no sleeps or timing luck. Pure prose gets no assertion tests.
Keep all failed receipts. Success requires receipts plus exit codes, not stdout.
QA deadlines bound only the harness, never product consult thinking.
Real oracle calls are limited to 24 per attempt. Hash live `auth.json` and
`credential-pool-state.json` before/after real-model QA; a change blocks further
real-model QA pending owner decision. Do not overwrite a changed baseline.
