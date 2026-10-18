# Installed host QA

Discovery on 2026-10-17:

- Owner lane: `C:/Users/USER/.omo-stable-500`.
- Launcher from this session's `OMO_BIN` / `OMO_STABLE_REENTRY`:
  `C:/Users/USER/.omo-stable-500/staging/omo-memory-selector-entry-r19.mjs`.
- `node <launcher> --help` exits 0 and advertises `--extension, -e <path>`,
  `--mode rpc`, `--session`, `--session-dir`, and `--no-extensions`.
- Engine: `C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`
  (Senpi 2026.10.16). Pinned PiOMO plugin:
  `C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.34-r1/package/plugin`
  (omo-ai 5.1.34).

## Loading mechanism and ownership

Chosen mechanism: **cli-extension-flag**, on an **owned-stdio-rpc** child.
The stable wrapper intentionally rejects foreign state roots and pins live roots.
After its read-only help probe, the harness directly starts that wrapper's exact
installed engine and pinned plugin, adding the candidate using `--extension`.
Discovery is disabled, while explicit plugin, mock-provider and candidate paths
still load. It never changes the wrapper or any installed file.

Each invocation makes a unique log/receipt directory inside
`.omo/evidence/<attempt>/task-1-piomo-oracle-advisor-mod/`, even on rerun.
Its owned home and working directory instead live under
`os.tmpdir()/oracle-advisor-qa-<attempt>-<random>/`. HOME, USERPROFILE, XDG roots
and all three branded agent directories use this temporary root. Only the owned
session JSONL, probe JSONL, raw logs and receipts are retained in evidence.
The temporary root is removed after each owned host exits, before starting the
next host, and cleanup records its file count, byte count and verified absence.
Inherited current-session, goal, host and stable-lane
state variables are cleared. No credential file is copied. The real smoke's cheap
main route reads its configured live key through an environment-supplied path,
without opening a writable credential store. The configured native-cmd-glm-deepseek explore/quick physical
route is `ollama/deepseek-v4.1-flash`; smoke uses thinking off and records every
provider request without recording headers or payloads.
Disposable settings disable compaction, retries and model fallback; `DO_NOT_TRACK`
disables plugin telemetry. The smoke exposes only the candidate probe tool to its
main model.
The live route's catalog is discovered dynamically and cached in
`<live agentDir>/models-store.json`; a fresh offline host has no Ollama catalog.
`qa/main-provider.mjs` registers just the public metadata for this one model and
the live profile's `off -> none` thinking mapping. The inherited environment key
received HTTP 401 in one retained failed run, so the fixture now reads the
configured Ollama API key through the read-only guard's key API. The harness
passes that single key to the host through its environment. Registration keeps
the key in memory, without refresh, file copy or persisted credentials.
No credential or header is written to evidence. The initial unknown-provider
a1 run records zero calls; the rejected environment-key run records one call.

RPC `prompt` runs `/qa_probe`; RPC `reload` re-runs `session_start` in the same
session. These are observed through candidate-authored JSONL receipts and
`extension_event`s, loaded surfaces, session ids, persisted user messages, actual
tool execution and child exit codes. Human "success" text is not proof.
The RPC client advertises the engine's `extension_events` capability through
both `SENPI_RPC_CLIENT_CAPABILITIES` and its `OMO_` brand alias.
No Herdr fallback or owner-pane interaction is needed when these RPC commands work.

## Commands

```
npm run qa -- --case host-smoke --attempt a1
npm run qa -- --case host-missing-ext --attempt a1
npm run qa -- --case host-smoke --attempt mock-a1 --main mock --oracle mock
```

Missing-extension QA deliberately exits 1 with `extension_not_loaded`; the
receipt separately records the engine exit, owned PID and verified PID removal.
Raw logs and every prior failed run stay in the unique run directories.

## Stand-in oracle hook for later todos

`--oracle mock` (default) starts `qa/mock-provider.mjs` on an ephemeral loopback
port. `qa/mock-extension.mjs` registers `oracle-qa-mock/main` and
`oracle-qa-mock/oracle` through the real `pi.registerProvider` API using
OpenAI-compatible SSE. A disposable `home/.omo/omo.json` points native
`agents.oracle.model` at `oracle-qa-mock/oracle`. This does not alter the live
oracle definition. The harness exports `startMockProvider({steps})`; steps are
`{tool, arguments}` or `{text}`, including a JSON verdict string. With no script,
oracle requests return a CONTINUE verdict and the mock main calls the probe tool
when prompted with a `QA_TOOL_<marker>`. Later task drivers can share this listener
and extension with the native task engine. This todo does not probe oracle
transport, revival or allowlist behavior.

`--main mock` exercises the real HTTP provider adapter, model stream, tool
validation, command/reload handling and transcript without a paid call.
The default smoke uses the cheap real main for the two requested prompts; the
counter records zero real oracle calls because no oracle is invoked in todo 1.
Every real main HTTP request is recorded by the candidate provider-request hook.

## Spend and login safety

`reserveRealOracleRuns(attemptDir, count)` in `qa/harness.mjs` reserves native
oracle dispatches before execution, refuses beyond 24, never refunds failed
runs, and uses an exclusive attempt lock. Later real-oracle cases must call it
immediately before dispatch. A new attempt has a separate budget.

`guardAuth` hashes the live credential files with SHA-256
before and after host QA. Missing files are represented by null, not created.
The first hashes stay pinned in `real-model-safety.json`. Any change sets a
persistent block that also rejects further reservations; the harness does not
reset it or retry with another credential. Owner decision is required to proceed.

Strict whole-file comparison remains the default. `ORACLE_QA_AUTH_GUARD=scoped`
opts a fresh attempt into per-provider-entry comparison. Under owner decision
#123 A, `admitAuth` ignores earlier strict whole-file blocks for scoped admission.
Only an earlier scoped block with a changed guarded auth or pool entry latches
a later scoped attempt. The current attempt's block is never cleared, and strict
real-model admission still honors every earlier block. Historical records are
read-only; all real-capable case drivers use this same admission function before
dispatch, with `guardAuth` retaining the per-entry checks during and after QA.
The current real QA main and oracle routes read only `ollama`; cases using a
different real route must pass its provider key in `guardAuth`'s `providers` option
at every check. A mock-only smoke passes an empty set. Guarded auth or pool entry
changes and unparseable files persist the same block. Other provider changes
produce `concurrent_external_change` events with provider names and numeric
expiry timestamps, never credential values. The attempt-level
`auth-guard-receipt.json` records the guarded set and these events. Provider
hashes remain pinned in `real-model-safety.json`; JSON key order is ignored in
scoped mode. An attempt cannot switch modes or provider sets in place.
All auth comparisons live in `qa/auth-guard.mjs`; real-capable case finalizers
use its decision, not whole-file equality. Mock-only cases that do not read
credentials retain their previous strict-mode outcomes: static policy and
dossier cases report `auth_changed` with exit 1 on a whole-file change; lifecycle, Seed and transport mock
cases only observe hashes. Scoped mode does not fail those observation-only cases.
`qa/safety-state.mjs` and the harness own attempt-state/receipt I/O. Only
`qa/auth-guard.mjs` captures the credential directory once, then removes every
environment key or value containing it. The harness also filters the actual
environment supplied to every owned process. Child hosts receive an IPC channel
for parent-owned hash verdicts, never the locator. Host discovery exposes only
installation metadata. The guard imports only named read-only filesystem APIs;
its results do not expose credential paths.
The unchanged static test covers accidental source references across `src/`,
`qa/` and `scripts/`. Runtime-built names and decoded paths use the amended
runtime threat model instead: locator lookups return undefined, and guarded
entry mutations persistently stop QA. Static mutation copies are scanned only;
runtime repro copies execute against synthetic files. The dedicated parity
test executes the dossier's original strict branch from the independent review;
trigger finalization consistently reports `auth_changed` with exit 1.

## Deadlines and cleanup

The 180-second harness process deadline is an owned QA limit, not a product
consult limit. RPC/event observations have bounded deadlines and subscribe before
the triggering request. Timeout kills only the owned process tree, using its PID
(`taskkill /PID <pid> /T /F` on Windows). After successful host proofs the harness
also intentionally kills its owned tree; this avoids depending on installed
plugin shutdown hooks. Its engine exit is recorded as planned termination,
separately from the QA case exit (0 only after all proofs). Helper commands
must exit naturally with the expected code. Every process
receipt verifies PID absence after its close event. The loopback listener closes
and all disposable directories are listed in evidence but removed from disk.

Smoke also probes a hung owned command, misleading success output, fresh state,
and an owned host killed after admitting a mock prompt followed by a fresh owned
session. Git status records the new, deliberately uncommitted worktree.
Other product adversarial classes are not applicable until their respective todos.
LSP is not installed on this workstation; Node tests and `node --check` are used.
