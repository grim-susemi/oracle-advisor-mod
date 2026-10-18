# Oracle policy fixtures

`live-omo.jsonc` is an immutable byte copy of the live config, captured by the
policy test setup on October 17, 2026. `source.json` records its source and hash.
Tests read this copy and write only disposable files. They never install against
the live config. If this snapshot is absent, the setup captures it once and marks
it read-only; existing snapshots are never refreshed by a test run.

Hostile JSONC variants are inline test inputs so their BOM, CRLF, escaped quotes,
comments and trailing commas are explicit.
