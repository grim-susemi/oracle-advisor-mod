# R3 Seam Contracts

This document formalizes the runtime seam contracts introduced by R3 for the PiOMO Oracle Advisor mod.
It specifies the interfaces, schemas, rules, and invariants across driver inspection (J1), advisor routing (J2), task nature classification (J11), auto-job lifecycle (J3), status hub publishing, accounting receipt fields, status reporting, and installer lifecycle.

---

## 1. J1 Driver Entry Contract (Must have 5)

### 1.1 Custom Session Entry
Primary-agents writes identity entries to the session branch. The advisor reads them via `readDriver(branch)` to identify the active driver agent without importing external packages.

- **Entry Type:** `custom`
- **Custom Type:** `primary-agent/v1`
- **Schema Version:** `1`
- **Valid Agent IDs:** `sisyphus`, `hephaestus`, `prometheus`, `atlas`

```json
{
  "type": "custom",
  "customType": "primary-agent/v1",
  "data": {
    "schemaVersion": 1,
    "agentId": "atlas"
  }
}
```

### 1.2 Inspection Rules
1. `readDriver(branch)` scans the entries on `branch` in reverse chronological order (newest to oldest).
2. The first valid entry where:
   - `entry.type === 'custom'`
   - `entry.customType === 'primary-agent/v1'`
   - `entry.data` is an object with `schemaVersion === 1`
   - `entry.data.agentId` is one of `sisyphus`, `hephaestus`, `prometheus`, `atlas`
   is returned as `{ schemaVersion: 1, agentId }`.
3. If no entry matches, or if all entries are malformed (e.g. unknown agent ID, wrong schema version, missing data), `readDriver` returns `null`.
4. The driver entry never supplies a model; model information comes from `ctx.model`.
5. Cached at each non-preview `before_agent_start`.

---

## 2. J2 Routing Table Contract (Must have 2, 3, 11)

### 2.1 Schema & Location
- **Path:** `<agentDir>/oracle-advisor/routing.json` (where `<agentDir>` is `SENPI_CODING_AGENT_DIR ?? OMO_CODING_AGENT_DIR`).
- **Read Semantics:** Read synchronously at each admission. No in-memory cache across turns.
- **Admission Timing:** Decided once inside `oracle_consult.execute` before `consult_admitted` is appended (src/consult.mjs:320-338) and stored with it; never recomputed for that request. Refused admissions record `advisor: null`.
- **Degradation:**
  - Absent file: Fallback to today's dispatch (`legacy` source, `table_absent` reason) silently.
  - Invalid JSON / schema: Fallback to today's dispatch (`legacy` source, `table_invalid` reason) plus exactly one `ctx.ui.notify` per session.

### 2.2 Schema Definition
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["v", "profiles", "by_family", "by_agent", "by_nature"],
  "properties": {
    "v": { "type": "integer", "const": 1 },
    "profiles": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": [],
        "properties": {
          "model": { "type": "string" },
          "family": { "type": "string", "enum": ["claude", "gpt", "other"] }
        },
        "additionalProperties": false
      }
    },
    "by_family": {
      "type": "object",
      "required": ["claude", "gpt", "other"],
      "properties": {
        "claude": { "$ref": "#/definitions/kindMapping" },
        "gpt": { "$ref": "#/definitions/kindMapping" },
        "other": { "$ref": "#/definitions/kindMapping" }
      },
      "additionalProperties": false
    },
    "by_agent": {
      "type": "object",
      "additionalProperties": { "$ref": "#/definitions/kindMapping" }
    },
    "by_nature": {
      "type": "object",
      "required": ["design", "lowlevel"],
      "properties": {
        "design": { "type": "string" },
        "lowlevel": { "type": "string" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false,
  "definitions": {
    "kindMapping": {
      "type": "object",
      "required": ["work", "completion"],
      "properties": {
        "work": { "type": "string" },
        "completion": { "type": "string" }
      },
      "additionalProperties": false
    }
  }
}
```

### 2.3 Strict Validation Constraints
- **Profile Names:** Must match `^[a-z][a-z0-9-]{0,31}$`.
- **Profile Models:**
  - Must conform to `provider/model[:level]` grammar (e.g. `chatgpt-subscription/gpt-6-astra:high`).
  - If a model is specified, `family` is required. The model ID portion (after `/` and before `:`) must strictly classify to the declared profile `family` under `familyOf(modelId)`. There is no `other` family bypass for Claude or GPT model IDs.
  - Omo aliases (e.g. `astra-high`) are NOT accepted as valid task pins and must be rejected by `validateRouting`.
  - An empty profile object `{}` indicates the default Claude Oracle role without overrides.
- **Reference Integrity:** Every profile referenced in `by_family`, `by_agent`, or `by_nature` must exist in `profiles`.
- **Agent Keys in `by_agent`:** Must be valid agent IDs (`sisyphus`, `hephaestus`, `prometheus`, `atlas`).
- **Nature Keys in `by_nature`:** Must contain exactly `design` and `lowlevel`.

### 2.4 Default Routing Table (`config/routing.default.json`)
```json
{
  "v": 1,
  "profiles": {
    "claude": {},
    "gpt": {
      "model": "chatgpt-subscription/gpt-6-astra:high",
      "family": "gpt"
    }
  },
  "by_family": {
    "claude": {
      "work": "gpt",
      "completion": "gpt"
    },
    "gpt": {
      "work": "claude",
      "completion": "claude"
    },
    "other": {
      "work": "claude",
      "completion": "gpt"
    }
  },
  "by_agent": {},
  "by_nature": {
    "design": "claude",
    "lowlevel": "gpt"
  }
}
```

---

## 3. Main Family & Routing Resolution (Must have 2, 4)

### 3.1 Main Family Detection (`familyOf`)
Extracted from `ctx.model` (the model running the turn).
- The ID used is the provider model ID (`ctx.model.id`, e.g. `claude-opus-5-5`, `gpt-6-astra`), never an omo alias like `astra-high`.
- Lower-cased model ID:
  - Contains `'claude'` -> `'claude'`
  - Starts with `'gpt-'` -> `'gpt'`
  - Empty or absent `ctx.model` -> `'unknown'` -> today's dispatch
  - Anything else -> `'other'`

### 3.2 Resolution Order
Evaluated once at consult admission:
1. **Task Nature:** If nature is `'design'` or `'lowlevel'`, use `by_nature[nature]`.
   - `source = 'by_nature'`, `reason = nature`
   - Nature strictly takes precedence over `by_agent` and `by_family`.
2. **Per-Agent Override:** If `driver` is non-null and `by_agent[driver]?.[kind]` is configured:
   - `source = 'by_agent'`, `reason = `${driver}:${kind}``
3. **Main Family:** If `mainFamily` is `'claude'`, `'gpt'`, or `'other'` and `by_family[mainFamily]?.[kind]` is configured:
   - `source = 'by_family'`, `reason = `${mainFamily}:${kind}``
4. **Fallback:** If `mainFamily === 'unknown'` or no rule matched:
   - `profile = null`, `model = null`, `source = 'legacy'`, `reason = 'family_unknown'` (or `'fallback'`)

---

## 4. J11 Task Nature Classification & Freshness (Must have 6)

### 4.1 Nature Config (`config/task-nature.json`)
```json
{
  "v": 1,
  "design": {
    "categories": ["visual-engineering"],
    "skills": ["visual-qa"]
  },
  "lowlevel": {
    "categories": [],
    "skills": ["debugging"]
  }
}
```

### 4.2 Classification Rules (`classifyNature`)
Observes lead `task` tool calls (single and batch `tasks[]`).
- **Items with a string `category` only:** Any item lacking a string `category` is ignored and returns `'neutral'`.
- **Skills:** Extracted ONLY from the prompt's `Loadout:` line (Arsenal arming rule, C:/Users/USER/orca/projects/piomo-oracle-arsenal-mod/src/arming.mjs:33-60).
  - The first line whose first non-whitespace token is `Loadout:`.
  - Line breaks are split matching Arsenal: `\r\n`, `\n`, `\r`, `\u2028`, `\u2029`.
  - Backticks are stripped; values are comma-separated.
  - If `Loadout: none` or `Loadout: none - <reason>`, skills list is empty.
  - If multiple `Loadout:` lines appear, the first line wins.
  - **`load_skills` parameter is explicitly ignored** (it may have been armed by category tables).
- **Classification:**
  - An item is `design` if its category matches `design.categories` or any skill matches `design.skills`.
  - An item is `lowlevel` if its category matches `lowlevel.categories` or any skill matches `lowlevel.skills`.
  - If an item matches both design and lowlevel: item is `mixed`.
  - Batch of items:
    - If all classified items are design -> `design`
    - If all classified items are lowlevel -> `lowlevel`
    - If items contain both design and lowlevel, or any item is mixed -> `mixed`
    - If no items match either -> `neutral`

### 4.3 Freshness Horizons
Nature records are stored in a ring buffer (size 64) per session.
- **Work consult:** Uses the newest record created after `max(session_start, last_owner_input, job_open)`.
- **Completion consult:** Requires that ALL records created since `job_open` share one non-neutral value (`design` or `lowlevel`). If there are mixed records, conflicting records, or ring eviction occurred since job open, no override is applied (`neutral`).

---

## 5. J3 Auto-Job Rules & Ledger Additions (Must have 7, 8)

### 5.1 Trigger & Activation
- Owner input matching `^/(?:skill:)?ulw-execute(?:\s|$)` whose source is the owner (`interactive` or `rpc`; never `extension`) creates a pending auto-run.
- The reconcile handler reads the driver itself with `readDriver(ctx.sessionManager.getBranch())` and is registered before the STOP gate and the nudger, so the oracle rule reaches the first Atlas turn.
- When `readDriver(branch)` observes `atlas` on a non-preview `before_agent_start`, an auto-job opens:
  `job_opened.auto = { run_id, trigger: 'atlas_ulw_execute' }`.
- The pending/active run is rebuilt from the ledger's `auto.run_id` in the `session_start` rebuild, so the first turn after reload does not read as "no run".
- A1 reads `event.reason` (`resume` or `fork`) on `session_start`.
- Owner input matching `^/(?:skill:)?ulw-plan(?:\s|$)` terminates the active auto-run (`plan_request`).
- Commands `/oracle on|off|end` on an auto job set `owner_touched` so J3 never touches it again. `/oracle on` on an active or auto-paused job appends `job_resumed { by: 'owner' }`.
- State transitions notify through `ctx.ui.notify`.

### 5.2 Rules A0–A7
- **A0:** Kill switch (`OMO_ORACLE_AUTO_ATLAS=0`), manual job, or owner-touched job -> no auto-job actions.
- **A1:** First turn after `resume` or `fork` start with an active auto-job -> end it (`session_restarted`), unless a STOP is open or consult is running (wait, as in A5).
- **A2:** Atlas driver + pending/active run + no open job + run ID never used -> open auto-job.
- **A3:** Open auto-job of another run -> end previous (`superseded`), then open new run.
- **A4:** Run ended -> end the auto-job.
- **A5:** Driver is not Atlas or no run active -> pause (`by: 'auto'`), unless a STOP is open or consult is running (wait).
- **A6:** Auto-paused + Atlas driver again + same active run -> resume (`by: 'auto'`).
- **A7:** A manual job exists -> never open a second job.

### 5.3 Ledger Extensions
- `job_opened.auto`: `{ run_id: string, trigger: string }`
- `job_paused`: gains `by: 'auto' | 'owner'` and `reason`
- `job_resumed`: gains `by: 'auto' | 'owner'` and `reason`
- `job_ended`: gains `by: 'auto' | 'owner'` and `reason`
- Old ledger entries replay cleanly as manual jobs without auto fields.
- Reducer tracks: `auto`, `paused_by`, `owner_touched`.

---

## 6. Status Hub Contract (Must have 10)

Exposed globally at `globalThis[Symbol.for('omo.oracle-advisor.status.v1')]`:
```typescript
interface StatusHub {
  v: 1;
  sessions: Record<string, SessionSnapshot>; // Object.create(null) null-prototype object
}

interface SessionSnapshot {
  job_id: string | null;
  status: 'active' | 'paused' | 'closed' | null; // Ledger job status (src/ledger.mjs:14, 160-163)
  gate_state: 'ACTIVE' | 'HELD' | 'HALTED' | 'CLOSED' | null; // STOP gate state (src/ledger.mjs:14, 165, 202, 211)
  auto: { run_id: string } | null;
  consults_remaining: number | null;
  open_stops: number;
  last_advisor: {
    profile: string | null;
    source: string;
  } | null;
}
```
- Replaced on every ledger change with a frozen data-only snapshot.
- A lead session without a job publishes the no-job snapshot:
  `{ job_id: null, status: null, gate_state: null, auto: null, consults_remaining: null, open_stops: 0, last_advisor: null }`
  (which Arsenal renders as `설치됨 · 작업 없음`).
- The existing `globalThis[Symbol.for('omo.oracle-advisor.v1')]` runtime registration remains byte-compatible.

---

## 7. Accounting Receipt Fields (Must have 9)

`RECEIPT_FIELDS` in `src/contracts.mjs` is extended with 8 additional fields:
1. `session_id`
2. `advisor_profile`
3. `advisor_source`
4. `advisor_reason`
5. `driver_agent`
6. `main_family`
7. `task_nature`
8. `auto_run_id`

All consumers across consult (`src/consult.mjs:67`), nudger (`src/nudger.mjs:86`), stop-gate (`src/stop-gate.mjs`), contracts (`src/contracts.mjs:26-32`), test suites, and QA verdicts (`qa/verdict-aux.mjs:502`, `qa/verdict-primary.mjs:374`) are updated in lockstep in Todo 4.

---

## 8. Status Reporting & Installer Seams (Must have 12, 13)

### 8.1 Status Command (Must have 12; Todo 4 scope)
- `/oracle status` (src/commands.mjs:24-48) reports:
  - Table state: `absent | valid | invalid: <reason>`
  - Auto state of the job (`auto.run_id`, `paused_by`, `owner_touched`)
  - Last advisor choice (`profile`, `source`, `reason`)

### 8.2 Installer Lifecycle (Must have 13; Todo 9 scope)
- Installs next generation (`generation-000002` on live dir).
- Writes default `routing.json` only when none exists (existing file preserved byte-for-byte and recorded in manifest with sha256).
- `--uninstall` removes it only after policy drift check passes and only when bytes match installed default.
- `--dry-run` prints actions without writing.
