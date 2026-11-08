# Oracle advisor

An independent PiOMO extension for read-only oracle advice. Requires Node 24 or
later; no runtime packages or Senpi SDK import. The main remains in control.

## Build and install

```sh
npm run check
node scripts/install.mjs --agent-dir "<agentDir>" --dry-run
node scripts/install.mjs --agent-dir "<agentDir>"
```

The agent directory must already exist. Its parent must contain `omo.jsonc`
with a root `[native].agents.oracle` definition. Installation is an explicit
operation; obtain the owner's approval before targeting a live profile.
The installer never edits `settings.json`.

The build starts at `src/extension.mjs` and follows local imports and literal
`new URL(..., import.meta.url)` resources. It packages the oracle prompt and
policy resolver at their original relative paths. Every JavaScript file passes
`node --check` before the staged build replaces `dist/`.

Each install creates a new, immutable
`<agentDir>/oracle-advisor/integration/generation-NNNNNN/`. The managed
`extensions/omo-oracle-advisor.js` shim loads that generation;
`oracle-advisor/current.json` records the entry and every runtime file's SHA-256.
A default routing table (`config/routing.default.json`) is installed to
`<agentDir>/oracle-advisor/routing.json` when absent; an existing table is preserved
byte for byte and reported in `current.json`.
A same-named foreign shim is refused before any change.

Installation also applies the exclusive read-only oracle tools policy to the
root and native profile oracle definitions in that `omo.jsonc`. The policy
retains an exact backup and per-range delta manifest. A project override can
still introduce unsafe tools; consults then refuse with `oracle_not_readonly`.
This policy affects other uses of those oracle definitions too.

## Use

- `/oracle on`: open or resume a job.
- `/oracle off`: pause nudges and gates, retaining the job.
- `/oracle status`: show the job, counters, open STOPs, Seed and residency.
- `/oracle cancel`: cancel the running consult.
- `/oracle end`: close the job and retire its owned oracle tasks.
- `/oracle override <stop_id> <reason>`: record an owner override (20-800 characters).

The main uses `oracle_consult` for work or completion advice,
`oracle_advisor` with `finish_intent` before handoff, `oracle_bind_seed` to pin
acceptance criteria, and `oracle_record_stop` to record a STOP disposition.
There are four consult slots per job (three work plus one reserved completion),
one concurrent consult and at most three nudges. No automatic retries, fallback
models, background polling or consult time limit.

This measured host build uses fresh oracle runs with prior job records, not
live residency. STOP prevents mutating tool calls until a disposition or owner
override; it cannot block a plain-text final answer, so unresolved STOPs also
produce a visible settle warning. No job means no nudges, gates or consults.
Task child sessions are excluded. Briefing-like hooks compose in either load
order; both handlers' settle entries, prompt blocks and brief result edits survive.

Set `OMO_ORACLE_ADVISOR=0` before starting the host to disable every advisor
hook and tool. One `disabled-by-env` receipt is written.
Set `OMO_ORACLE_AUTO_ATLAS=0` to disable automatic advisor jobs when Atlas runs
interactive `/ulw-execute` or `/skill:ulw-execute` commands (manual `/oracle on|off|end`
remains fully functional; `/skill:ulw-plan` ends a run with reason plan_request).
Normal event receipts are in `<agentDir>/logs/oracle-advisor.jsonl`.

The optional `purpose` field records why the caller is asking:

```js
oracle_consult({ kind: "work", question: "Review this change.", purpose: "scope" })
```

Allowed values are `scope`, `correctness`, and `mixed`. Omit the property for
undeclared purpose; responses and receipts expose `consult_purpose: null`.
Other supplied values are rejected without spending a consult slot. The first
admission fixes the value, including across replay of the same request ID.
Accounting receipts let an auditor compare this declaration with `task_nature`
and the selected advisor. Purpose does not change routing or enter the advisor
prompt. Task nature still describes prior task signals, not the current question.
This adds traceability, not evidence of better allocation or lower cost.
Residency remains disabled; any future per-consult model switching would also
need to respect the model of an already resident task.

## Routing table

Advisor routing is configured via `<agentDir>/oracle-advisor/routing.json`.
When absent or invalid (which logs a notice per session with receipt reason
`table_invalid`), the advisor defaults to standard Claude dispatch.
When present, consults pick an advisor profile based on:
1. Task nature (`by_nature.design` or `by_nature.lowlevel`).
2. Per-agent override (`by_agent[driver_agent][kind]`).
3. Main-model family (`by_family[mainFamily][kind]`).
4. Fallback to default dispatch.

To edit routing, modify `<agentDir>/oracle-advisor/routing.json` directly. The JSON
schema defines profiles (such as `claude` and `gpt`), family mappings, and nature
overrides. Edits survive generation upgrades and uninstall (a modified table is kept
as `routing_kept_modified`).

## Remove

```sh
node scripts/install.mjs --agent-dir "<agentDir>" --uninstall --dry-run
node scripts/install.mjs --agent-dir "<agentDir>" --uninstall
```

Removal restores only unchanged managed oracle-policy ranges and removes only
the managed shim. Policy drift refuses removal without deleting the shim.
If `<agentDir>/oracle-advisor/routing.json` matches the installed default SHA-256,
it is removed; if it has been modified, it is preserved and reported as
`routing_kept_modified`. Unrelated configuration edits survive. Generations,
`current.json`, receipts, policy manifests and backups remain for inspection.
Reload or restart the host after installation or removal.

## Verification

```sh
node --test --test-isolation=none test/coexistence.test.mjs
npm run check
npm run qa -- --case install-roundtrip --attempt a1 --main mock --oracle mock
npm run qa -- --case install-foreign-shim --attempt a1 --main mock --oracle mock
```

These installer cases require mock modes, run only in OS-temp agent directories,
remove their disposable state, and preserve evidence under
`.omo/evidence/a1/task-12-piomo-oracle-advisor-mod/`. The roundtrip loads the actual
generated shim in an owned installed host and runs `/oracle status` without a
provider call. Uninstall must restore every pre-existing file hash, including
the exact `omo.jsonc` bytes. The foreign-shim case requires the entire temporary
tree to stay unchanged.

## 한국어 요약

`/oracle on`으로 작업을 켜고 `/oracle off`로 일시 정지합니다.
`/oracle status`는 상태, `/oracle cancel`은 진행 중 자문 취소,
`/oracle end`는 작업 종료입니다. `OMO_ORACLE_ADVISOR=0`이면 비활성화됩니다.
설치기는 오라클 읽기 전용 설정을 백업하며 `settings.json`은 바꾸지 않습니다.
제거는 위 `--uninstall` 명령으로 합니다. 관리 대상 설정이 변경되었다면
덮어쓰지 않고 거부합니다. 실사용 프로필 설치는 소유자 승인 후에만 하세요.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 grim-susemi.
