# SessionStart Handler — Live Banner Wiring

**Task ID:** sprint-07-03
**Date:** 2026-05-10
**Specification:** specs/sprint-07-session-banners/spec-03-session-start-handler.md

## Overview

Replaces the no-op `SessionStart` stub in `src/sentinel/hook.mjs` with a live call to `summariseAuditWindow` and `composeBanner` from `session.mjs`. On every session start (startup, resume, or clear), the handler reads the trailing 7-day window of the audit log, counts `block`, `scrub`, and `ask` events, composes a one-line human-readable banner, and emits it as `additionalContext` in the `SessionStart` envelope. A `try/catch` wraps the summariser so any I/O failure falls back to a static empty-state banner — the handler is strictly fail-open.

## What Was Built

- Static ESM import of `{ summariseAuditWindow, composeBanner }` from `./session.mjs` added to `hook.mjs`
- `case 'SessionStart':` stub replaced with live banner composition inside a `try/catch`
- Static fallback banner on catch — identical text to the empty-log case for a consistent user experience
- `'session'` bucket added to the `--self-test` fixture runner with a `banner_includes` substring comparator
- Three integration tests covering: empty log, recent activity (2 blocks + 1 scrub), and stale activity (entry > 7 days old)
- Self-test fixture count floor bumped from 41 to 43

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `summariseAuditWindow`/`composeBanner` import; replaced `SessionStart` case body; added `'session'` to `fixtureDirs` and the self-test bucket dispatch with `banner_includes` comparator; bumped fixture floor assertions from 41 → 43
- `tests/hook.test.mjs`: Appended three `SessionStart` integration tests (T1: empty dir, T2: recent activity, T3: stale entry); also includes `SessionEnd` integration test from Spec 2

### Key Changes

- **Import addition** (`hook.mjs:14`): `import { summariseAuditWindow, composeBanner } from './session.mjs'` — static, matching the zero-dynamic-import convention of the module.
- **SessionStart case body** (`hook.mjs:433-444`): Scoped block (`{ }`) calls `summariseAuditWindow({ config, now: Date.now() })` then `composeBanner(summary)`; on catch, assigns the static fallback string; `emit(envelope('SessionStart', { additionalContext: banner }))` is the single exit point in both paths, using the default `decisionCtx` (`warn/allow/null`) for the audit row.
- **Self-test session bucket** (`hook.mjs:240-275`): Materialises `fixture.audit_lines` into a temp `audit.jsonl`, builds a `fixtureConfig` that overrides `audit.path`, calls `summariseAuditWindow`/`composeBanner`, then compares via the new `banner_includes` key (substring match rather than exact equality).
- **Integration tests** (`hook.test.mjs:574-719`): All three tests use `runHookEnv` with `CLAUDE_PLUGIN_DATA: dataDir` to redirect audit path resolution — the same mechanism used by Sprint 02–06 tests. T2 and T3 write a seeded `audit.jsonl` via `writeFileSync`.
- **Fail-open guarantee**: The `try/catch` in the `SessionStart` case isolates `summariseAuditWindow` and `composeBanner` calls only; `emit` is always reached regardless of summariser outcome.

## How to Use

The handler fires automatically on every `SessionStart` hook event (matched by `startup|resume|clear` in `hooks/sentinel.json`). No configuration is required.

1. Start or resume a Claude Code session — the plugin fires `SessionStart`.
2. Sentinel reads the trailing 7-day window of `audit.jsonl`.
3. If the log contains recent events, the banner reports counts: e.g. `Sentinel active — 2 blocks, 1 scrub in the last 7 days. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence.`
4. If the log is missing, empty, or all entries are older than 7 days, the banner reads: `Sentinel active — no events yet. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence.`
5. If `summariseAuditWindow` throws unexpectedly, the same empty-state banner is emitted — session startup is never blocked.

## Configuration

No new config keys. The audit log path resolution follows the same priority order as all other Sentinel modules:

1. `config.audit.path` (explicit config override)
2. `CLAUDE_PLUGIN_DATA` env var (used by integration tests)
3. Default: `~/.claude/plugins/sentinel/audit.jsonl`

## Testing

```bash
# Full test suite
node --test tests/

# Run only the three SessionStart integration tests
node --test tests/hook.test.mjs --test-name-pattern "SessionStart"

# Self-test (includes session bucket fixtures)
node src/sentinel/hook.mjs --self-test

# Manual smoke test — empty log
echo '{"session_id":"s1","cwd":"/tmp"}' | node src/sentinel/hook.mjs SessionStart

# Manual smoke test — pre-seeded log
CLAUDE_PLUGIN_DATA=/tmp/mydata node src/sentinel/hook.mjs SessionStart <<< '{"session_id":"s1","cwd":"/tmp"}'
```

Integration tests use subprocess `spawnSync` via `runHookEnv` to exercise the full wire path: stdin parse → config load → audit read → banner compose → `emit()` → stdout JSON. The `CLAUDE_PLUGIN_DATA` env var redirects audit path resolution so each test operates on an isolated temp directory.

| Test | Audit log state | Expected `additionalContext` |
|---|---|---|
| T1 | No `audit.jsonl` file | matches `/Sentinel active — no events yet/` |
| T2 | 2 blocks + 1 scrub, all ≤ 7d old | includes `"2 block"` and `"1 scrub"` |
| T3 | 1 block, 8d old (outside window) | matches `/Sentinel active — no events yet/` |

All three tests also assert `ctx.includes('next-turn-only')`.

## Notes

- **Spec 1 dependency is hard**: `session.mjs` must exist before `hook.mjs` loads — Node.js throws `ERR_MODULE_NOT_FOUND` at startup otherwise, breaking all hook calls.
- **`Date.now()` as `now`**: Passed into `summariseAuditWindow` to allow deterministic timestamp injection in unit tests (`tests/session.test.mjs`). The hook always passes wall-clock time.
- **`emit` is the correct exit path**: Unlike `PostToolUse` (which bypasses `emit` to avoid double-auditing), `SessionStart` emits exactly one audit line with `event: 'warn'`, `decision: 'allow'`, `rule: null` — intentional, as a session-start banner is not a policy decision.
- **`async: true`** in `hooks/sentinel.json` means Claude Code does not wait for this hook before showing the user prompt. The banner appears as `additionalContext` without blocking session start latency.
