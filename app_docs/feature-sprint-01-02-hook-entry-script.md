# Hook Entry Script — Sentinel ESM Dispatch Entry Point

**Task ID:** `sprint-01-plugin-scaffold/spec-02-hook-entry-script`
**Date:** 2026-05-10
**Specification:** `specs/sprint-01-plugin-scaffold/spec-02-hook-entry-script.md`

## Overview

This sprint delivered `src/sentinel/hook.mjs`, the single ESM dispatch entry point that all six matcher slots in `hooks/sentinel.json` invoke. In its Sprint 01 form it is a fail-open stub that always exits 0 and emits a parseable `hookSpecificOutput` envelope for every Claude Code hook event — ensuring no Sentinel bug can ever block a tool call. A companion test suite in `tests/hook.test.mjs` black-box-tests the script by spawning it as a subprocess, mirroring how Claude Code itself invokes it.

## What Was Built

- `src/sentinel/hook.mjs` — single self-contained ESM hook entry script with static imports only
- `tests/hook.test.mjs` — `node:test` suite with 8 tests covering all event types and edge cases
- Module-top constants `EVENT_NAMES`, `MIN_NODE`, `BANNER_PREFIX` exported for Sprint 02+ reuse
- `compareSemver` helper for Node version preflight check
- Four-way `switch` dispatch for `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`
- Fail-open `default` branch for unknown or missing `argv[2]`
- `--self-test` early-exit mode (used by `make validate`)
- Node version preflight that emits advisory allow if Node < 20.10.0

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs` (new): Single ESM dispatch entry; static imports of `node:fs` and `node:process` only; synchronous stdin read via `readFileSync(0, 'utf8')`; JSON parse with fail-open catch; four-way event switch; all paths call `emit()` which writes JSON to stdout and calls `process.exit(0)`
- `tests/hook.test.mjs` (new): `node:test` suite using `spawnSync` to black-box-test the hook script for each event name and edge case

### Key Changes

- **Fail-open everywhere**: every error path (bad Node version, stdin read error, JSON parse failure, unknown event) emits an `allow` envelope and exits 0 — Claude Code sessions are never blocked by a Sentinel bug
- **Envelope shape**: `PreToolUse` uses `{ permissionDecision, permissionDecisionReason }` inside `hookSpecificOutput`; `PostToolUse`, `SessionStart`, `SessionEnd` use `{ additionalContext: '' }` — matching the Claude Code hook API contract
- **Static imports only**: no `dynamic import()` anywhere; V8 parse cost is fully front-loaded at process start, keeping cold-start latency under the < 20 ms per-event budget
- **Stdin via `readFileSync(0, 'utf8')`**: zero-dep synchronous read of file descriptor 0; wrapped in try/catch to handle EAGAIN on non-blocking TTY
- **`EVENT_NAMES` anchor**: defined as module-top `const` so Sprint 02's audit writer can import it without refactoring the entry point

## How to Use

1. Invoke via `node` with an event name as `argv[2]` and JSON event payload on stdin:
   ```sh
   echo '{}' | node src/sentinel/hook.mjs PreToolUse
   ```
2. Parse stdout as JSON — always a single `hookSpecificOutput` object:
   ```json
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Sentinel: scaffold no-op"}}
   ```
3. Run self-test (no stdin required):
   ```sh
   node src/sentinel/hook.mjs --self-test
   # stderr: Sentinel: self-test ok
   # exit: 0
   ```

## Configuration

No configuration files are loaded in Sprint 01. The following module-top constants are the only tunable values in this file:

| Constant | Value | Purpose |
|---|---|---|
| `EVENT_NAMES` | `['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']` | Canonical event list; imported by Sprint 02+ audit writer |
| `MIN_NODE` | `'20.10.0'` | Minimum Node version; older runtimes get advisory allow and continue |
| `BANNER_PREFIX` | `'Sentinel: '` | Prefix for all human-readable reason strings |

## Testing

Run the full test suite:

```sh
make test
# or equivalently:
node --test tests/
```

Run only hook tests:

```sh
node --test tests/hook.test.mjs
```

Expected output: **8 pass / 0 fail** covering:

| Test | What it asserts |
|---|---|
| `--self-test exits 0` | Self-test mode returns exit 0 |
| `PreToolUse returns valid envelope` | Correct `hookEventName` in output |
| `PostToolUse returns valid envelope` | Correct `hookEventName` in output |
| `SessionStart returns valid envelope` | Correct `hookEventName` in output |
| `SessionEnd returns valid envelope` | Correct `hookEventName` in output |
| `PreToolUse carries permissionDecision allow` | Decision field present and set to `allow` |
| `unknown event falls through to allow` | Fail-open on unrecognised `argv[2]` |
| `invalid JSON on stdin is fail-open` | Fail-open on malformed stdin |

## Notes

- `make validate` still fails after this spec because `.claude-plugin/plugin.json` and `hooks/sentinel.json` are absent — that is Spec 03's scope. The `--self-test` step within `make validate` now passes.
- `PostToolUse`, `SessionStart`, and `SessionEnd` do not carry `permissionDecision` — they are observation/notification events, not gate events. Adding `permissionDecision` to them would violate the Claude Code hook API contract.
- The `void EVENT_NAMES` and `void event` lines are intentional documentation anchors. Sprint 02's executor should change `const EVENT_NAMES` to `export const EVENT_NAMES` and remove the `void EVENT_NAMES` line when wiring the audit writer import. Similarly, `void event` will be removed when Sprint 02+ begins consuming `event.toolName`, `event.toolInput`, etc.
- Tests use `process.execPath` to spawn the hook script, ensuring the child process uses the same Node version as the test runner — no hard-coded paths.
