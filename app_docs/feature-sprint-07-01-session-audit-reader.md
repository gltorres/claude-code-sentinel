# Session Audit Reader and Banner Composer

**Task ID:** sprint-07-session-banners/spec-01-session-audit-reader
**Date:** 2026-05-10
**Specification:** specs/sprint-07-session-banners/spec-01-session-audit-reader.md

## Overview

This feature introduces `src/sentinel/session.mjs`, a pure read-only module that scans the last 7 days of audit log activity via a reverse-chunk file reader and composes the one-line `Sentinel active — …` banner string shown at `SessionStart`. It also promotes `resolveAuditPath` in `src/sentinel/audit.mjs` to a named export so the reader can share identical path-resolution logic without duplication.

## What Was Built

- `src/sentinel/session.mjs` — new module exporting `summariseAuditWindow` and `composeBanner`
- `export` keyword added to `resolveAuditPath` in `src/sentinel/audit.mjs` (one-word additive change)
- `tests/session.test.mjs` — 11 `node:test` cases covering all acceptance criteria
- `tests/fixtures/session/empty.json` and `tests/fixtures/session/mixed.json` — fixture files for the self-test bucket (wired in Spec 04)

## Technical Implementation

### Files Modified

- `src/sentinel/audit.mjs:11` — added `export` to `resolveAuditPath`; function body unchanged
- `src/sentinel/session.mjs` — new file (120 lines); zero runtime npm dependencies
- `tests/session.test.mjs` — new file (167 lines); 11 deterministic unit tests
- `tests/fixtures/session/empty.json` — self-test fixture for the missing/empty log case
- `tests/fixtures/session/mixed.json` — self-test fixture with mixed event types
- `tests/hook.test.mjs` — updated to cover session self-test bucket dispatch

### Key Changes

- **Reverse-chunk scan** — `summariseAuditWindow` reads the audit log from the end in 8 KiB chunks using low-level `openSync`/`readSync`, processing lines newest-first and stopping as soon as a `ts` field falls before the 7-day cutoff. The carry-buffer pattern handles line fragments that straddle chunk boundaries.
- **Fail-open I/O** — every `statSync`, `openSync`, `readSync`, and `closeSync` call is inside a `try/catch`; any I/O error returns `{ counts: { block: 0, scrub: 0, ask: 0 }, hasAny: false }`. The file descriptor is always closed in `finally`.
- **Event filtering** — only `block`, `scrub`, and `ask` events are counted. `warn` is explicitly excluded because it is written for every hook invocation (including benign ones) and would over-report activity.
- **Injectable `now`** — the 7-day cutoff is computed from a `now` parameter (defaults to `Date.now()`) so test suites can inject a fixed epoch and get deterministic results regardless of wall-clock time.
- **Pure `composeBanner`** — accepts `{ counts, hasAny }` and returns a string always under 500 characters. No config access, no I/O. Includes a `plural(n, noun)` helper for correct singular/plural English output.

## How to Use

```js
import { summariseAuditWindow, composeBanner } from './src/sentinel/session.mjs'

const summary = summariseAuditWindow({ config })
// → { counts: { block: 2, scrub: 1, ask: 0 }, hasAny: true }

const banner = composeBanner(summary)
// → "Sentinel active — last 7d: 2 blocks, 1 scrub, 0 asks. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence."
```

`summariseAuditWindow` accepts:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config` | object | — | Merged Sentinel config (from `loadConfig`) |
| `now` | number | `Date.now()` | Epoch ms; injectable for deterministic tests |

`composeBanner` accepts the object returned by `summariseAuditWindow`.

Banner strings:

- With events: `"Sentinel active — last 7d: N blocks, N scrubs, N asks. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence."`
- Without events: `"Sentinel active — no events yet. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence."`

## Configuration

No new config keys. The module reads only `config.audit.path` (via `resolveAuditPath`), which resolves through the existing three-priority order: `config.audit.path` → `CLAUDE_PLUGIN_DATA` env → `~/.claude/sentinel/audit.jsonl`.

## Testing

```bash
node --test tests/session.test.mjs  # 11 unit tests, all synchronous
node --test tests/                  # full suite, zero regressions
make validate
```

Tests use real file I/O against `mkdtempSync` temp directories — no mocking. Each test creates a fresh temp directory, writes a synthetic `audit.jsonl`, and injects a fixed `now` value.

## Notes

- Hook wiring (SessionStart calling `summariseAuditWindow` → `composeBanner` → `additionalContext`) is Spec 03's concern. Until then, the SessionStart stub continues to emit `additionalContext: ''`.
- The self-test bucket (`'session'` in `fixtureDirs` and the `else if (bucket === 'session')` dispatch branch) is Spec 04's concern.
- Rotated log scanning (`audit.jsonl.1`) is out of scope for v1. A `// TODO: rotation-aware scanning` comment marks the gap in `session.mjs`.
- The reverse-scan is correct only because `writeAuditLine` always appends (oldest-first). Stopping at the first out-of-window `ts` is safe under this assumption.
