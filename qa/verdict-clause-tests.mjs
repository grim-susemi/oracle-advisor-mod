// Unit proofs are exact existing test titles, including expanded generated titles.
// A test pass proves only the Acceptance clauses that explicitly name it here.
export const clauseTests = {
  "t03.acceptance.ledger-rebuild": [
    {
      "file": "test/ledger.test.mjs",
      "name": "reducer is pure and replay preserves every durable job field"
    }
  ],
  "t03.acceptance.rebuild-interrupted": [
    {
      "file": "test/ledger.test.mjs",
      "name": "rebuild durably interrupts in-flight consults once and never dispatches tools"
    }
  ],
  "t03.acceptance.killswitch-registration": [
    {
      "file": "test/commands.test.mjs",
      "name": "kill switch registers nothing and writes one receipt even after duplicate loads"
    }
  ],
  "t03.acceptance.noninteractive-registration": [
    {
      "file": "test/commands.test.mjs",
      "name": "non-interactive sessions register no hooks, tools or commands"
    }
  ],
  "t03.acceptance.child-handlers": [
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: x/senpi-task/children/a/session.jsonl"
    },
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: C:\\x\\senpi-task\\children\\a.jsonl"
    }
  ],
  "t03.acceptance.child-ledger-writes": [
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: x/senpi-task/children/a/session.jsonl"
    },
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: C:\\x\\senpi-task\\children\\a.jsonl"
    }
  ],
  "t03.acceptance.child-receipts": [
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: x/senpi-task/children/a/session.jsonl"
    },
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: C:\\x\\senpi-task\\children\\a.jsonl"
    }
  ],
  "t03.acceptance.child-command-refusal": [
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: x/senpi-task/children/a/session.jsonl"
    },
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: C:\\x\\senpi-task\\children\\a.jsonl"
    }
  ],
  "t03.acceptance.child-tool-refusal": [
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: x/senpi-task/children/a/session.jsonl"
    },
    {
      "file": "test/commands.test.mjs",
      "name": "interactive child remains inert after identity is latched: C:\\x\\senpi-task\\children\\a.jsonl"
    }
  ],
  "t03.acceptance.prestart-handlers": [
    {
      "file": "test/commands.test.mjs",
      "name": "hooks, commands and tools are inert before the first session_start"
    }
  ],
  "t04.acceptance.serial-repeat": [
    {
      "file": "test/triggers.test.mjs",
      "name": "same command fails serially twice -> one trigger; third failure does not repeat"
    }
  ],
  "t04.acceptance.concurrent-duplicate": [
    {
      "file": "test/triggers.test.mjs",
      "name": "concurrent duplicate failures do not count as a serial pair"
    }
  ],
  "t04.acceptance.different-operation": [
    {
      "file": "test/triggers.test.mjs",
      "name": "different flags, cwd, logical tool or class start a new chain"
    }
  ],
  "t04.acceptance.success-reset": [
    {
      "file": "test/triggers.test.mjs",
      "name": "success between failures resets the episode even with misleading output"
    }
  ],
  "t04.acceptance.read-edit-preserves": [
    {
      "file": "test/triggers.test.mjs",
      "name": "read and edit between failures keep the chain"
    }
  ],
  "t04.acceptance.missing-background-result": [
    {
      "file": "test/triggers.test.mjs",
      "name": "a background result never arriving does not block a later serial pair"
    }
  ],
  "t04.acceptance.result-deduplication": [
    {
      "file": "test/triggers.test.mjs",
      "name": "duplicate result notifications and duplicate admission are counted once"
    }
  ],
  "t04.acceptance.successful-prose": [
    {
      "file": "test/triggers.test.mjs",
      "name": "success between failures resets the episode even with misleading output"
    },
    {
      "file": "test/triggers.test.mjs",
      "name": "missing or odd structuredContent is safe and prose never supplies a failure class"
    }
  ],
  "t04.acceptance.third-failure-deduplication": [
    {
      "file": "test/triggers.test.mjs",
      "name": "same command fails serially twice -> one trigger; third failure does not repeat"
    }
  ],
  "t04.acceptance.nested-consult-ignored": [
    {
      "file": "test/triggers.test.mjs",
      "name": "only actual oracle_consult descendants are excluded, including grandchildren"
    }
  ],
  "t06.acceptance.spawn": [
    {
      "file": "test/transport.test.mjs",
      "name": "measured decision is fresh-only even though snapshot awaiting exists"
    }
  ],
  "t06.acceptance.revival": [
    {
      "file": "test/transport.test.mjs",
      "name": "future live mode revives the same id and subscribes before send"
    }
  ],
  "t06.acceptance.revival-failure-fallback": [
    {
      "file": "test/transport.test.mjs",
      "name": "revival refusal not_continuable falls back exactly once even with isError false"
    },
    {
      "file": "test/transport.test.mjs",
      "name": "revival refusal not_found falls back exactly once even with isError false"
    },
    {
      "file": "test/transport.test.mjs",
      "name": "revival refusal no_resident_session falls back exactly once even with isError false"
    },
    {
      "file": "test/transport.test.mjs",
      "name": "a dead resident before revival falls back once; fresh-only never attempts revival"
    }
  ],
  "t06.acceptance.unbounded-thinking": [
    {
      "file": "test/transport.test.mjs",
      "name": "promotion and arbitrarily long simulated thought remain event-driven with no deadline"
    }
  ],
  "t06.acceptance.terminal-without-answer": [
    {
      "file": "test/transport.test.mjs",
      "name": "terminal without an answer never retries"
    }
  ],
  "t06.acceptance.roster-drop": [
    {
      "file": "test/transport.test.mjs",
      "name": "coordination roster drop aborts the owned wait and never uses ask or notify"
    }
  ],
  "t06.acceptance.owner-abort": [
    {
      "file": "test/transport.test.mjs",
      "name": "owner cancel aborts once and retires when abort_propagates=true"
    },
    {
      "file": "test/transport.test.mjs",
      "name": "owner cancel aborts once and retires when abort_propagates=false"
    }
  ],
  "t06.acceptance.lane-capacity": [
    {
      "file": "test/transport.test.mjs",
      "name": "lane capacity is unavailable without fallback or model charge"
    }
  ],
  "t06.acceptance.background-promotion": [
    {
      "file": "test/transport.test.mjs",
      "name": "promotion and arbitrarily long simulated thought remain event-driven with no deadline"
    }
  ],
  "t06.acceptance.branch-retirement": [
    {
      "file": "test/transport.test.mjs",
      "name": "branch switch retires old ids and next consult spawns with the new dossier"
    }
  ],
  "t06.acceptance.reload-interrupted": [
    {
      "file": "test/transport.test.mjs",
      "name": "reload marks interrupted, retires the old child, and never replays it"
    }
  ],
  "t06.acceptance.retire-running": [
    {
      "file": "test/transport.test.mjs",
      "name": "retirement handles running, completed resident, and already gone; refuses unowned ids"
    }
  ],
  "t06.acceptance.release-completed-resident": [
    {
      "file": "test/transport.test.mjs",
      "name": "retirement handles running, completed resident, and already gone; refuses unowned ids"
    }
  ],
  "t06.acceptance.retire-already-gone": [
    {
      "file": "test/transport.test.mjs",
      "name": "retirement handles running, completed resident, and already gone; refuses unowned ids"
    }
  ],
  "t06.acceptance.stuck-answer-once": [
    {
      "file": "test/transport.test.mjs",
      "name": "stuck revival answer is returned once and retired; next consult spawns"
    }
  ],
  "t06.acceptance.stuck-next-fresh": [
    {
      "file": "test/transport.test.mjs",
      "name": "stuck revival answer is returned once and retired; next consult spawns"
    }
  ],
  "t08.acceptance.explicit-allowlist": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "HELD uses exact tool names and exempts only oracle_consult descendants"
    }
  ],
  "t08.acceptance.nested-exemption": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "HELD uses exact tool names and exempts only oracle_consult descendants"
    }
  ],
  "t08.acceptance.disposition-validation": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "dispositions validate exact open ids, decisions, lengths, evidence, and unknown keys"
    }
  ],
  "t08.acceptance.persistence-failure-held": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "append failure cannot release STOP and a failed gate receipt cannot fail open"
    }
  ],
  "t08.acceptance.continue-keeps-held": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "later CONTINUE, forged override text, reload and epoch change preserve open STOP"
    }
  ],
  "t08.acceptance.owner-override": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "every open STOP must be disposed; halt stays overridable by owner"
    }
  ],
  "t08.acceptance.terminate-fifth": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "five consecutive blocks terminate only that run, with allowed-call and run resets"
    },
    {
      "file": "test/stop-gate.test.mjs",
      "name": "all held blocks share escalation and non-blocked calls reset it: ownership-first"
    },
    {
      "file": "test/stop-gate.test.mjs",
      "name": "all held blocks share escalation and non-blocked calls reset it: stop-first"
    }
  ],
  "t08.acceptance.settle-append": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "prompt and settle hooks append to existing extension data without forcing continuation"
    }
  ],
  "t08.acceptance.prompt-append": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "prompt and settle hooks append to existing extension data without forcing continuation"
    }
  ],
  "t08.acceptance.failure-policy": [
    {
      "file": "test/stop-gate.test.mjs",
      "name": "unavailable advice fails open without a STOP and stays held with one"
    }
  ],
  "t09.acceptance.caps": [
    {
      "file": "test/nudger.test.mjs",
      "name": "two completed tool-bearing turns separate failure notices; completion bypasses cooldown"
    }
  ],
  "t09.acceptance.cooldown": [
    {
      "file": "test/nudger.test.mjs",
      "name": "two completed tool-bearing turns separate failure notices; completion bypasses cooldown"
    },
    {
      "file": "test/nudger.test.mjs",
      "name": "empty turns do not advance failure cooldown"
    }
  ],
  "t09.acceptance.episode-deduplication": [
    {
      "file": "test/nudger.test.mjs",
      "name": "second serial failure preserves content, structuredContent and details identities"
    }
  ],
  "t09.acceptance.structured-preserved": [
    {
      "file": "test/nudger.test.mjs",
      "name": "second serial failure preserves content, structuredContent and details identities"
    }
  ],
  "t09.acceptance.brief-notice": [
    {
      "file": "test/nudger.test.mjs",
      "name": "brief result uses the completion notice once and preserves other result fields"
    }
  ],
  "t09.acceptance.inactive-no-nudge": [
    {
      "file": "test/nudger.test.mjs",
      "name": "inactive, paused, child, pending and exhausted jobs never nudge"
    }
  ],
  "t10.acceptance.example-and-real-fixtures": [
    {
      "file": "test/seed.test.mjs",
      "name": "offline SKILL example and two labeled hand-written fixtures parse with stable ids"
    },
    {
      "file": "test/seed.test.mjs",
      "name": "seed-ouroboros-1 is an exact captured generator output and binds with tool provenance"
    },
    {
      "file": "test/seed.test.mjs",
      "name": "seed-ouroboros-2 is an exact captured generator output and binds with tool provenance"
    }
  ],
  "t10.acceptance.assigned-ids": [
    {
      "file": "test/seed.test.mjs",
      "name": "offline SKILL example and two labeled hand-written fixtures parse with stable ids"
    }
  ],
  "t10.acceptance.missing-goal": [
    {
      "file": "test/seed.test.mjs",
      "name": "missing required fields and ambiguous or unsupported YAML fail closed"
    }
  ],
  "t10.acceptance.ambiguous-yaml": [
    {
      "file": "test/seed.test.mjs",
      "name": "missing required fields and ambiguous or unsupported YAML fail closed"
    }
  ],
  "t10.acceptance.rebind-epoch": [
    {
      "file": "test/seed.test.mjs",
      "name": "changed hash advances epoch and scope once without resetting consult caps"
    }
  ],
  "t10.acceptance.same-hash-idempotence": [
    {
      "file": "test/seed.test.mjs",
      "name": "bind pins raw text durably, reports source/hash, and is hash-idempotent"
    }
  ],
  "t10.acceptance.held-refuses-bind": [
    {
      "file": "test/seed.test.mjs",
      "name": "STOP hold refuses bind and replayed Seed changes cannot erase open STOPs"
    }
  ],
  "t10.acceptance.stop-survives-rebind": [
    {
      "file": "test/seed.test.mjs",
      "name": "STOP hold refuses bind and replayed Seed changes cannot erase open STOPs"
    }
  ],
  "t11.acceptance.comments-preserved": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "scanner preserves BOM, CRLF, comments, escaped strings and trailing commas"
    },
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "existing tools value replacement preserves surrounding comments and restores exactly"
    },
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "T11-COMMENTS: retained internal comments survive replacement and exact uninstall"
    }
  ],
  "t11.acceptance.target-ranges-only": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "only managed tool ranges change and uninstall restores exact live-copy bytes"
    }
  ],
  "t11.acceptance.byte-identical-uninstall": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "only managed tool ranges change and uninstall restores exact live-copy bytes"
    }
  ],
  "t11.acceptance.restore-after-unrelated-edit": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "uninstall relocates ranges after unrelated prefix edit and retains that edit"
    }
  ],
  "t11.acceptance.unrelated-edit-preserved": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "uninstall relocates ranges after unrelated prefix edit and retains that edit"
    }
  ],
  "t11.acceptance.drift-reported": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "changed managed range is reported and left untouched"
    }
  ],
  "t11.acceptance.drift-untouched": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "changed managed range is reported and left untouched"
    }
  ],
  "t11.acceptance.unproven-key-refused": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "unproven key refuses before any file write"
    }
  ],
  "t11.acceptance.dry-run-no-write": [
    {
      "file": "test/oracle-policy.test.mjs",
      "name": "dry-run does not write backup, manifest or config; lists all oracle definitions"
    }
  ],
  "t17.acceptance.prior-probe-regressions": [
    {
      "file": "test/consult.test.mjs",
      "name": "consult-branch-switch-reserved prevents dispatch and releases the unused slot"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "consult-reload-reserved prevents dispatch and releases the unused slot"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "consult-cancel-reserved prevents dispatch and releases the unused slot"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-policy-change terminates without a verdict or stranded reservation"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-cancel-save terminates without a verdict or stranded reservation"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-seed-rebind terminates without a verdict or stranded reservation"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-admission-replay: cancel before the first microtask stays terminal after reloads"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-admission-replay: reload before the first microtask stays terminal after reloads"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: cancel resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: reload resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: reload-other resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: branch resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    }
  ],
  "t17.acceptance.boundary-injection": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    }
  ],
  "t17.acceptance.at-most-once-dispatch": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-terminal-branch-replay: an answered id dispatches once across five pre-admission branches"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "idempotent replay works after rebuild without another call or receipt"
    }
  ],
  "t17.acceptance.terminal-never-answer-stop": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "an answer arriving after interruption cannot overwrite it or publish a verdict"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-admission-replay: cancel before the first microtask stays terminal after reloads"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-admission-replay: reload before the first microtask stays terminal after reloads"
    }
  ],
  "t17.acceptance.total-rebuild": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: cancel resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: reload resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: reload-other resolves and reconstructs the selected branch"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "probe-native-rejection: branch resolves and reconstructs the selected branch"
    }
  ],
  "t17.acceptance.reserved-slot-invariant": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "returning to a branch with an abandoned pre-model reservation refunds it without replay"
    }
  ],
  "t18.acceptance.free-refusal": [
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=false, rejects=false"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=false, rejects=true"
    }
  ],
  "t18.acceptance.paid-charge": [
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=true, rejects=false"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=true, rejects=true"
    }
  ],
  "t18.acceptance.no-fifth-paid": [
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=true, rejects=false"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "native fact survives cleanup rejection: paid=true, rejects=true"
    }
  ],
  "t18.acceptance.cleanup-envelope-properties": [
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    }
  ],
  "t18.acceptance.immutable-native-facts": [
    {
      "file": "test/ledger.test.mjs",
      "name": "native facts are frozen, write-once and isolated from lifecycle metadata"
    },
    {
      "file": "test/ledger.test.mjs",
      "name": "absent native model_called stays absent through finish, release and rebuild"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    }
  ],
  "t18.acceptance.canonical-charge-equation": [
    {
      "file": "test/ledger.test.mjs",
      "name": "slot usage is derived only from canonical native facts and pending reservations"
    },
    {
      "file": "test/consult.test.mjs",
      "name": "lifecycle property covers all admission, physical await and rebuild boundaries with repeated replay"
    }
  ]
};

// These obligations require the owned host flow and its observed effect summary.
export const hostAcceptanceClauses = [
  "t13.acceptance.acceptance-exit",
  "t13.acceptance.observed-effect-fields"
];

// npm test alone cannot prove npm run check (which also performs a build).
export const commandAcceptanceClauses = {
  "t17.acceptance.check-exit": "npm run check",
  "t18.acceptance.check-exit": "npm run check"
};

