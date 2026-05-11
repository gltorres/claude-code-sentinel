# Session End Handler — Audit Marker

**Task ID:** sprint-07-session-banners/spec-02-session-end-handler
**Date:** 2026-05-10
**Specification:** specs/sprint-07-session-banners/spec-02-session-end-handler.md

## Overview

Replaces the no-op `SessionEnd` stub in `src/sentinel/hook.mjs` with a real handler that passes an explicit `decisionCtx` to `emit()`, producing an audit record with `rule: 'session.end'`. This makes session boundaries identifiable in the audit log without any ambiguity — previously the stub emitted `rule: null`, indistinguishable from other lifecycle events.

## What Was Built

- Explicit `decisionCtx` passed to `emit()` in the `case 'SessionEnd':` arm of `src/sentinel/hook.mjs`
- Audit records for `SessionEnd` now carry `event: 'warn'`, `decision: 'allow'`, `rule: 'session.end'`, `matched: null`
- Integration test in `tests/hook.test.mjs` that spawns the real hook subprocess and asserts the full audit record shape including `session_id` flow-through

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added explicit `decisionCtx` second argument to the `emit()` call inside `case 'SessionEnd':` — the only source change in the handler itself
- `tests/hook.test.mjs`: Appended one subprocess integration test asserting all six audit record fields (`hook`, `event`, `rule`, `decision`, `matched`, `session_id`)

### Key Changes

- The `case 'SessionEnd':` body went from one line to three — the `envelope()` call is unchanged; only the second argument to `emit()` was added
- `{ event: 'warn', decision: 'allow', rule: 'session.end', matched: null }` overrides the default `decisionCtx` (which had `rule: null`) inside `emit()`
- `session_id` flows automatically from the stdin JSON payload into the audit record via the existing `eventJson.session_id ?? ''` path in `audit.mjs:76` — no changes to `audit.mjs` were needed
- `additionalContext: ''` is kept intentional — `SessionEnd` does not display a banner to the user; the session marker lives in the audit log only
- The integration test uses the same `CLAUDE_PLUGIN_DATA` / `spawnSync` / `mkdtempSync` / `try-finally` pattern as every other subprocess test in the file

## How to Use

Session end audit lines are automatically written when Claude Code fires the `SessionEnd` hook. To query session boundaries from the audit log:

```bash
# Find all session end records
grep '"hook":"SessionEnd"' ~/.claude/sentinel/audit.jsonl | jq '{ts, session_id, rule}'

# Count session boundaries in last 24h
jq -r 'select(.hook == "SessionEnd") | .ts' ~/.claude/sentinel/audit.jsonl | \
  awk -v cutoff="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)" '$0 >= cutoff' | wc -l
```

No configuration is required. The `SessionEnd` hook fires unconditionally and is registered with `async: true` in `hooks/sentinel.json`.

## Configuration

No new configuration keys. The handler fires unconditionally whenever Claude Code sends a `SessionEnd` event. Existing `audit.*` config controls the audit path and rotation.

## Testing

```bash
# Run only the new integration test
node --test tests/hook.test.mjs --test-name-pattern "SessionEnd writes audit"

# Run full test suite
node --test tests/

# Run self-test (fixture counts are unchanged by this spec)
node src/sentinel/hook.mjs --self-test

# Full validation
make validate
```

Manual verification — spawn the hook directly:

```bash
echo '{"session_id":"sess-xyz","cwd":"/tmp"}' | \
  CLAUDE_PLUGIN_DATA=/tmp/sentinel-test node src/sentinel/hook.mjs SessionEnd
cat /tmp/sentinel-test/audit.jsonl | jq '{hook, event, rule, decision, matched, session_id}'
```

## Notes

- **`rule` change from `null` to `'session.end'`**: Any dashboards or grep scripts filtering `rule IS NULL` to find session end records should be updated. Because Sprint 07 introduces session visibility for the first time, no existing production queries depend on the `null` behaviour.
- **Independence from Spec 1**: This spec does not import `session.mjs` and can be merged before, after, or concurrently with the session audit reader (Spec 1).
- **`async: true`**: The `SessionEnd` hook is declared non-blocking in `hooks/sentinel.json`. The handler's single `appendFileSync` + stdout write completes in under 5 ms — well within the 5-second timeout and invisible to the user.
- **`matched: null`**: There is no pattern match in a session end event. `null` is the correct sentinel, consistent with other unconditional lifecycle hooks.
