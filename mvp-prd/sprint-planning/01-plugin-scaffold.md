# Sprint 01: Plugin Scaffold & Validation Harness

**Band**: scaffold · **Blocked by**: —

## Goal
Stand up the zero-runtime-dependency Node project, the Claude Code plugin manifest, the hook config skeleton, and the validation harness so a fresh clone loads cleanly in Claude Code and `make validate` runs green with no protective logic yet. This is the floor every later sprint builds on.

## What we're building
A Node ≥ 20.10 LTS project using ESM (`.mjs`) with **no runtime dependencies**. The "zero deps" stance is a deliberate security posture: a defensive plugin must not itself widen the supply-chain attack surface.

The scaffold ships:

- A plugin manifest at `.claude-plugin/plugin.json`.
- A single hook config file at `hooks/sentinel.json` that registers matchers for all six events (`PreToolUse` Read-family, `PreToolUse` Bash, `PreToolUse` Bash install, `PostToolUse`, `SessionStart`, `SessionEnd`) — every matcher invokes the same Node script with the event name as `process.argv[2]`.
- A single Node entry script that reads the event JSON from stdin, dispatches on `process.argv[2]`, and (for now) returns `allow` for everything. Real protection arrives in later sprints.
- A `Makefile` with `validate`, `test`, `demo` targets and a `--self-test` mode on the entry script.
- A `node --test tests/` harness with at least one placeholder test so the runner is wired.
- A `package.json` declaring `"type": "module"` and dev scripts only — no `dependencies`, no `devDependencies` at runtime cost.

## Acceptance criteria
1. From a fresh clone with Node ≥ 20.10 available, `make validate` exits 0 — manifest JSON parses, hook config JSON parses, `node --test tests/` reports zero failures.
2. `node src/sentinel/hook.mjs --self-test` exits 0 (no fixtures yet — exits 0 on no-op).
3. Invoking the entry script with each of `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd` (event JSON piped on stdin) returns a valid hook-envelope JSON on stdout and exits 0.
4. The plugin loads in Claude Code via the dev install flow (`/plugin marketplace add ./<clone>` → `/plugin install <name>@<marketplace>` → `/reload-plugins`) with no schema errors visible.
5. No `npm install` step is required for any of the above.

## Context & constraints

**Architectural decisions already made by the PRD:**
- Node ≥ 20.10 LTS, ESM-only (`.mjs`). Floor is non-negotiable so `fetch`, `node:test`, and `AbortSignal.timeout()` are all stable.
- Zero runtime dependencies. Everything we need (HTTP, test runner, file I/O, time) is in stdlib.
- Config format is JSON, not TOML — Node has no stdlib TOML parser.

**Claude Code plugin API constraints (verified against current docs — these correct several wrong claims in the PRD):**
- Hook config references the entry script via `${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs`, **not** a relative path. Relative paths are not resolved reliably across sessions.
- Every hook entry in `hooks/sentinel.json` must set an explicit `"timeout": 5` (seconds). The default is **600 seconds**, which would hang a tool call for ten minutes on a stuck Node process.
- **Hook decision protocol** (this is the single most error-prone part of the API): exit code **0** with the decision JSON on stdout is how you deny, ask, or allow. Exit code 1 does **not** block — it is treated as a soft error. Exit code 2 is the alternative deny path via stderr. Never use `process.exit(1)` to block.
- The decision envelope:
  ```json
  {"hookSpecificOutput": {
    "hookEventName": "<event>",
    "permissionDecision": "deny|ask|allow",
    "permissionDecisionReason": "Sentinel: <reason>"
  }}
  ```
  The older top-level `decision`/`reason` shape is deprecated for PreToolUse.
- **Local dev install flow** (the PRD's `/plugin install ./path` does not exist):
  ```
  /plugin marketplace add ./<clone-dir>
  /plugin install <plugin-name>@<marketplace-name>
  /reload-plugins
  ```
  README and onboarding docs must reflect this.
- Multiple matchers in one hook file pointing at the same script is fully supported. The single-entry-script + `process.argv[2]` dispatch pattern is the right shape.

**Latency context:** Node cold-start is ~30 ms per invocation. The entry script must avoid dynamic `import()` so V8 parse cost stays predictable.

## Dependencies
—

## Open questions
- The Claude Code marketplace expects a specific manifest shape; the scaffold should match whatever schema fields are currently required (verify against `code.claude.com/docs/en/plugins-reference` during research).
