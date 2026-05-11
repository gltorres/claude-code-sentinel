# Audit Decision Params & Hook Path-Deny Wiring

**Task ID:** sprint-03-03
**Date:** 2026-05-10
**Specification:** specs/sprint-03-path-read-deny/spec-03-audit-decision-params.md

## Overview

This feature parameterises `writeAuditLine` with an optional decision context object so that deny decisions produce a meaningful, queryable audit trail rather than a misleading `warn`/`allow` record. It also adds a `NotebookEdit` branch to `summariseInput`, wires the decision context through `emit()`, and completes the `PreToolUse` path-deny integration in `hook.mjs` along with an in-process self-test runner.

## What Was Built

- **`writeAuditLine` fourth parameter** — optional `decision` object `{ event, decision, rule, matched }` with backward-compatible defaults (`warn`/`allow`/`null`/`null`)
- **`summariseInput` NotebookEdit branch** — returns `{ path: notebook_path }` for `NotebookEdit` tool events; `Read|Edit|Grep|Glob` branch gains `notebook_path` as a defensive intermediate fallback
- **`emit()` decision forwarding** — `emit(obj, decisionCtx)` in `hook.mjs` passes `decisionCtx` through to `writeAuditLine`; one-argument calls are unchanged
- **`PreToolUse` path-deny wiring** — `hook.mjs` now calls `matchPath` for `Read`, `Edit`, `Grep`, `Glob`, and `NotebookEdit` tool events and emits a `deny` envelope + `block` audit record on match
- **In-process self-test** — `--self-test` flag loads every JSON fixture under `tests/fixtures/paths/`, runs `matchPath` in-process, and reports timing; replaces the Sprint 02 no-op
- **3 new audit unit tests** — cover deny-context round-trip, `NotebookEdit` path extraction, and backward-compatible default-arg behaviour

## Technical Implementation

### Files Modified

- `src/sentinel/audit.mjs`: Added fourth `decision` parameter to `writeAuditLine`; added `NotebookEdit` branch and `notebook_path` fallback in `summariseInput`
- `src/sentinel/hook.mjs`: Extended `emit()` with optional `decisionCtx`; replaced `PreToolUse` scaffold no-op with full path-deny evaluation; replaced `--self-test` no-op with fixture-driven in-process runner; added `readdirSync` and `homedir` imports
- `tests/audit.test.mjs`: Appended three new `test()` blocks (g, h, i)
- `tests/hook.test.mjs`: Extended hook integration tests (209 lines total)
- `tests/paths.test.mjs`: New path-matcher test file (154 lines)
- `tests/config.test.mjs`: 13 lines of new config tests
- `config/defaults.json`: Updated with secrets glob deny patterns and path fallback fixes
- `tests/fixtures/paths/*.json`: 11 new fixture files covering allow/deny cases for Read, Edit, Grep, Glob, and NotebookEdit

### Key Changes

- `writeAuditLine` signature extended from 3 to 4 parameters with a default that exactly matches the previous hard-coded values — all existing callers are unaffected
- Record fields `event`, `rule`, `matched`, `decision` are now populated from `decision.event ?? 'warn'`, `decision.rule ?? null`, etc., rather than literals
- `emit(obj, decisionCtx = {})` passes `decisionCtx` as-is to `writeAuditLine`; when called with one argument the empty default propagates through `writeAuditLine`'s own default parameter
- `PreToolUse` handler extracts `filePath` per tool type (using `file_path`, `notebook_path`, or `pattern` keys) then calls `matchPath`; a `deny` result emits a blocking envelope and a `block`/`deny` audit record
- `--self-test` runner iterates all `tests/fixtures/paths/*.json` fixtures, calls `matchPath` in-process, compares `decision`/`rule`/`matched`, and fails with exit 1 on any mismatch; reports total fixture count and elapsed time

## How to Use

1. **Allow/deny decisions in audit log** — the `deny` result from `matchPath` is forwarded to `emit` as:
   ```js
   emit(envelope('PreToolUse', { permissionDecision: 'deny', ... }), {
     event: 'block', decision: 'deny', rule: result.rule, matched: result.matched,
   })
   ```
2. **Read deny decision from audit JSONL** — each line in `audit.jsonl` now carries the actual `event` and `decision` values; query with `jq 'select(.event == "block")'`
3. **Extend to new tools** — add a path-extraction branch in `hook.mjs` `PreToolUse` and include the tool name in the `matchPath`-guarded condition; no audit changes required
4. **Override decision defaults** — pass a partial `{ event: 'block' }` to `writeAuditLine`; `?? 'warn'` / `?? 'allow'` fallbacks handle missing fields

## Configuration

No new config keys. `config/defaults.json` contains the `paths.deny` and `paths.allow` glob lists evaluated by `matchPath`. See `feature-sprint-03-02-path-matcher-and-defaults.md` for the full defaults structure.

## Testing

```bash
# Unit tests — 9 tests (6 pre-existing + 3 new)
node --test tests/audit.test.mjs

# Hook integration tests
node --test tests/hook.test.mjs

# Full suite
node --test tests/

# Full validation (includes --self-test fixture runner)
make validate

# Self-test directly
node src/sentinel/hook.mjs --self-test
```

All commands must exit 0 with zero test failures.

## Notes

- The `?? 'warn'` / `?? 'allow'` / `?? null` guards inside the record literal are intentional — they make partially-specified decision objects safe and only fire when a field is `undefined`, not `null`
- `NotebookEdit` uses `notebook_path` as primary key with `file_path` fallback; the `Read|Edit|Grep|Glob` branch adds `notebook_path` as an intermediate fallback to defensively handle edge cases where Claude Code routes a notebook read through `Read`
- `decisionCtx = {}` in `emit` means a one-argument call forwards an empty object; `writeAuditLine`'s default parameter `{ event:'warn', ... }` only applies when the argument is `undefined`, so the empty object would produce `undefined` field values caught by the `??` guards — Sprint 02 callers remain correct
