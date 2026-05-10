# Sprint 02: Config Loader & Audit Log

**Band**: core · **Blocked by**: 01

## Goal
Give every later sprint two shared services: a merged JSON config (with shipped defaults the user can override) and a JSONL audit log that records every Sentinel decision. Without these, the protective sprints have nowhere to read rules from and nowhere to write outcomes to.

## What we're building
Two small modules, both stdlib-only:

1. **Config loader.** Two-layer merge: user defaults at `~/.claude/sentinel.json` are overlaid by project overrides at `.claude/sentinel.json`. Shipped defaults live in a JSON file inside the plugin and are the base of the merge. Unknown keys are preserved so future fields don't break old installs.
2. **Audit log writer.** Appends one JSON object per line to a JSONL file. Each entry has a ULID (vendored — ~30 LOC, no dep), a timestamp, the event class, the hook + tool that triggered, the matched rule, and a **summarised** input — never the verbatim input, because the audit log itself must not become a leak channel. Enforces a size cap by rotating the file when it exceeds the configured maximum.

Both modules are invoked from the Sprint 01 entry script so subsequent sprints can read config and write audit lines with no extra wiring.

## Acceptance criteria
1. Calling the hook entry with a synthetic event writes exactly one valid JSON line to the audit log.
2. Config merge: project value wins over user value; user value applies where project omits; defaults apply where both omit; unknown keys round-trip unchanged.
3. Size cap: writing past `audit.maxSizeMb` rotates the file to `audit.jsonl.1` (overwriting any prior rotation); the active log keeps appending recent entries.
4. A fixture event containing a fake secret in its input produces an audit line whose `input_summary` field does **not** contain the secret verbatim.
5. `node --test tests/` covers config-merge precedence, ULID monotonicity, and audit-line schema.

## Context & constraints

**Audit-log storage location.** The PRD §10 example uses `~/.claude/sentinel/audit.jsonl`, but Claude Code exposes a stable per-plugin data directory via `${CLAUDE_PLUGIN_DATA}` — files there survive plugin updates. Default the audit log path to `${CLAUDE_PLUGIN_DATA}/audit.jsonl`. Project config can still override via `audit.path`.

**Audit entry schema** (from PRD §10 — match these field names exactly so later sprints and the investigator agent can rely on them):
```
id, ts, session_id, cwd, event, hook, tool, rule, matched, input_summary, decision, metadata
```
`event` ∈ `{block, ask, scrub, warn}`. `decision` ∈ `{deny, ask, allow}`. `metadata` is a free-form object for rule-specific fields (e.g. `{package, ecosystem, age_days}` for a registry decision).

**Input summarisation.** The audit log must never contain raw `tool_input` or `tool_response` bodies. Summarisation rules per tool:
- `Read`/`Edit`/`Grep`/`Glob`: log the path and the matched glob, not the file contents.
- `Bash`: log the command's first 80 chars and the matched segment, not the full pipeline if it contains user-supplied strings.
- `PostToolUse` scrub events: log the redaction family and the count of redactions, never the redacted text.

**Config shape.** The shipped defaults file must include all of `paths`, `bash`, `registry`, `ecosystems`, `scrubber`, `audit` keys from PRD §9 so each later sprint can read its section without inventing new top-level keys.

**ULID generation.** Vendor a minimal ULID implementation (lexicographically sortable, time-prefixed, monotonic within the same millisecond). PRD §10 specifies ULID; do not substitute UUIDv4.

## Dependencies
- Sprint 01: Hook entry script exists and is invoked by the hook config — this sprint hangs the config + audit modules off it.

## Open questions
—
