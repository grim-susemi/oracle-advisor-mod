# Task 4 trigger probe

`src/triggers.mjs` is a pure module, not installed extension wiring. Task 9 can
persist the `state` returned by `reduceTriggers(state, event, {cwd})` in its job
ledger and restore it using `createTriggerState({snapshot})`. New state defaults
to inactive. `createTriggerState({active:true})` opens detector tracking.

Pass real `tool_call` and `tool_result` events unchanged. The reducer snapshots
the preceding admitted eligible failure on admission, not on result arrival.
Results are deduplicated by call id. Pending/late background results cannot
replace the latest admitted operation. Parent links identify actual tool
ancestry: nested main operations count as their underlying tools, while only
`oracle_consult` and its descendants are excluded. An eligible wrapper that
delegates verification to an eligible underlying tool is not counted again.

Control events are `job_started`, `job_paused`, `job_resumed`, `job_ended`,
`seed_rebound`, `scope_changed`, `disposition_accepted`, `finish_intent`, and
`completion_covered` with the consult dossier's `progress_revision`. Send the last
event only for an answered completion consult. Scope resets invalidate pending
old calls. Reload and compaction restore state rather than opening a new job.
`finish_intent` marks its revision, and `brief` results give a secondary completion
signal. Successful `edit`, `write`, `apply_patch`, and `lsp_rename` outcomes advance
progress; so do verification outcomes, Seed/scope changes and accepted dispositions.

Failure signals are `{kind:"repeated_failure",operation_key,error_class,count:2,
tool_call_ids,progress_revision}`. Completion signals are
`{kind:"completion",source:"finish_intent"|"brief",progress_revision}`.
Task 9 owns notice caps, delivery, cooldown and ledger integration.

Machine outcome fields supported are integer `structuredContent.exit_code`,
boolean `timed_out`/`timeout` (or `status:"timed_out"`), `error.code`/`code`,
then `isError`. Cancellation is `cancelled:true` or `status:"cancelled"`.
No result prose or `details` is inspected.

## Owned real-host cases

```
npm run qa -- --case trigger-real --attempt a2
npm run qa -- --case trigger-success-between --attempt a2
npm run qa -- --case trigger-real-powershell --attempt a2
```

The additive `qa/run.mjs` dispatch routes these three cases to their driver.
They use only public harness exports and their own probe extension.
The observer does not register or replace any shell, change its exposure,
restrict the tool list, or import a core shell implementation. The installed
lead surface supplies PTY `bash` from Senpi's `<builtin:terminal>`, not the
pinned plugin. This corrects attempt 1's source attribution and substitution.
Bash's nonzero foreground result uses `isError:true` without a structured exit
code, so the expected failure class is `tool_error`. PowerShell's unmodified
core implementation returns `structuredContent.exit_code`, so its expected
failure class is `exit:1`.

The bash cases run `node -e "process.exit(1)"` twice or commands requesting
exit codes `1,0,1`. The PowerShell case runs `exit 1` twice. The real lead calls
them through its normal eval/tool bridge. Every failure's full argument object
is identical, including description and timeout. The assertions check real
isError sequences, structured outcomes when available, full argument equality
and the detector signals; they never infer an exit code from prose. Bash
receipts distinguish requested exit codes from unavailable native exit codes.
No oracle is started.

The first observation uses only the owner's cheap route,
`ollama/deepseek-v4.1-flash:off`. If that main cannot follow the exact sequence,
its failed observation and raw output remain in evidence, then a local scripted
main issues the exact tool calls through the real provider adapter and host.
The latter scripts only eval requests and removes model-choice nondeterminism;
it does not replace a tool or mock shell execution. `--main mock` selects this
deterministic route explicitly.
Each observation checks exact command arguments, native outcome channels, trigger count,
credential hashes, owned PID cleanup and deletion of its disposable home.
