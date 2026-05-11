# Audit Writer

**Task ID:** sprint-02-03
**Date:** 2026-05-10
**Specification:** specs/sprint-02-config-and-audit/spec-03-audit-writer.md

## Overview

Implements `src/sentinel/audit.mjs` — a fail-open JSONL audit writer that appends one structured line per hook event to a size-capped rotating log file. The module never throws; all I/O errors are silently swallowed so that disk or permissions failures cannot crash the hook. It depends on Spec 1's `loadConfig` shape for path/size config and Spec 2's `ulid()` for per-record IDs.

## What Was Built

- `src/sentinel/audit.mjs` — exports `writeAuditLine(config, hookEvent, eventJson)` and `summariseInput(hookEvent, tool, eventJson)`
- `tests/fixtures/secret-bash.json` — synthetic PreToolUse Bash event with a fake `sk-ant-*` secret for secret-suppression testing
- `tests/audit.test.mjs` — six-scenario test suite covering schema, ULID format, field enum membership, secret suppression, rotation trigger, and single-level rotation overwrite

## Technical Implementation

### Files Modified

- `src/sentinel/audit.mjs`: New module — path resolution, input summarisation, write-with-rotation, all wrapped in fail-open `try { ... } catch {}`
- `tests/audit.test.mjs`: New test suite — six isolated scenarios using `mkdtempSync` temp directories
- `tests/fixtures/secret-bash.json`: New fixture — minimal PreToolUse event with fake secret in `tool_input.command`

### Key Changes

- **Path resolution** (`resolveAuditPath`): Three-layer priority chain — explicit `config.audit.path` (with `~` expansion) > `$CLAUDE_PLUGIN_DATA/audit.jsonl` > `~/.claude/sentinel/audit.jsonl`. Not exported; tests control the path via synthetic config or env var.

- **Input summarisation** (`summariseInput`): Dispatch table keyed on tool name. Returns minimum reconstructable data — never echoes `tool_input` or `tool_response` verbatim. For Bash events: truncates command to 80 chars then scrubs `sk-ant-*` tokens with `[REDACTED]`. For file tools (Read, Edit, Grep, Glob): returns `path` and `glob` only.

- **JSONL record schema** (PRD §10 field order, enforced by insertion order):
  `id`, `ts`, `session_id`, `cwd`, `event`, `hook`, `tool`, `rule`, `matched`, `input_summary`, `decision`, `metadata`

- **Rotation**: `statSync` checks pre-append size; if `size > maxSizeMb * 1024 * 1024`, `renameSync` moves the active log to `<path>.1` (overwriting any prior `.1`). Single-level only — no `.2` is ever created.

- **Fail-open contract**: Outer `try { ... } catch {}` in `writeAuditLine` matches the bare-catch pattern in `hook.mjs:51`. Any failure at any step silently drops the audit line.

## How to Use

```js
import { writeAuditLine, summariseInput } from './src/sentinel/audit.mjs'

// Minimal config — path and size cap
const config = { audit: { path: '/tmp/my-audit.jsonl', maxSizeMb: 10 } }

// Write one JSONL line per hook event
writeAuditLine(config, 'PreToolUse', hookEventJson)

// Inspect the summary without writing (used in Spec 4 tests)
const summary = summariseInput('PreToolUse', 'Bash', hookEventJson)
```

## Configuration

| Key | Source | Default |
|-----|--------|---------|
| `audit.path` | `config/defaults.json` → user `sentinel.json` → project `sentinel.json` | `~/.claude/sentinel/audit.jsonl` |
| `audit.maxSizeMb` | same three-layer merge | `10` |

Path fallback chain (highest to lowest priority):
1. `config.audit.path` (supports leading `~`)
2. `$CLAUDE_PLUGIN_DATA/audit.jsonl`
3. `~/.claude/sentinel/audit.jsonl`

## Testing

```bash
node --test tests/audit.test.mjs   # six isolated scenarios
node --test tests/                  # full suite — no regressions
make validate                       # lint + tests + self-test
```

Tests use `mkdtempSync` for full filesystem isolation. The real `~/.claude/sentinel/audit.jsonl` is never touched. Each test either passes an explicit `audit.path` in a synthetic config object or sets `process.env.CLAUDE_PLUGIN_DATA` with save/restore.

## Notes

- `summariseInput` is exported so Spec 4 integration tests and future rule-engine sprints can call it in isolation.
- `resolveAuditPath` is intentionally unexported — it is an implementation detail.
- The `ulid` import assumes Spec 2 (`src/sentinel/ulid.mjs`) is present; a missing module throws at load time by design, making the dependency explicit.
- `event` and `decision` carry sentinel no-op values (`warn` / `allow`) until Sprint 03+ populates them with real rule-engine output.
- Field order in the written record is enforced by object-literal insertion order, which V8 / Node 20+ preserves through `JSON.stringify` / `JSON.parse` round-trips.
