# Hook Dry-Run Flag

**Task ID:** sprint-09-spec-03
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-03-hook-dry-run.md

## Overview

Adds a `--dry-run` flag to `src/sentinel/hook.mjs` that runs the full PreToolUse decision pipeline (path matching for Read-family tools, Bash policy + registry evaluation for Bash commands) but skips `writeAuditLine` and emits a single human-readable line instead of a JSON envelope. This is the backend primitive that the `/sentinel-review test <cmd>` sub-command pipes into to surface decisions without polluting the audit log.

## What Was Built

- `DRY_RUN` boolean constant derived from `process.argv.includes('--dry-run')` at module scope
- `dryEmit({ decision, rule, matched, reason })` helper that prints `decision=<d> rule=<r> matched=<m> reason="<reason>"` to stdout and exits 0, skipping audit writes and JSON envelope emission
- Non-PreToolUse guard: if `--dry-run` is combined with any event other than `PreToolUse`, exits 1 with `dry-run only supports PreToolUse today` to stderr
- `case '--dry-run':` switch fallback for when the user passes `--dry-run` as `argv[2]` instead of a real event name
- Dry-run wiring in all three `case 'PreToolUse'` sub-branches: Read-family deny/allow, Bash (via injected `bashEmitFn`), and scaffold-allow
- Five new subprocess test cases in `tests/hook.test.mjs` (DR1–DR5) covering Bash deny, Bash allow, Read deny, Read allow, and non-PreToolUse error

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `DRY_RUN` constant, `dryEmit` helper, non-PreToolUse guard, `case '--dry-run':` fallback, and `DRY_RUN ? dryEmit(...) : emit(...)` wiring at all three `PreToolUse` sub-branches
- `tests/hook.test.mjs`: Appended five `test()` cases (DR1–DR5) with `statOrNull` helper using existing `statSync` import

### Key Changes

- `dryEmit` prints the human-readable line format and calls `process.exit(0)` directly, preserving the same control-flow contract as `emit()` — once a decision is made, the process exits immediately
- For the Bash sub-branch, a `bashEmitFn` closure is constructed when `DRY_RUN` is true; it unwraps the envelope object that `runBashBranch` constructs and maps it to the flat `dryEmit` signature. `runBashBranch`'s exported signature is unchanged — it already accepted `emit: emitFn` injection
- `rule=null` and `matched=null` are printed as the literal string `null` (not quoted); `reason` is always double-quoted even when empty (`reason=""`)
- The `--self-test` IIFE and its switch case are completely untouched; the normal (non-dry-run) output envelope, `writeAuditLine` call, and `process.exit(0)` inside `emit()` are unchanged

## How to Use

```sh
# Dry-run a Bash command — see the decision without writing to the audit log
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | node src/sentinel/hook.mjs PreToolUse --dry-run
# Output: decision=deny rule=bash.deny matched=cat .env reason="[sentinel] ..."

# Dry-run a Read — see whether a path would be allowed or denied
echo '{"tool_name":"Read","tool_input":{"file_path":"~/.aws/credentials"}}' \
  | node src/sentinel/hook.mjs PreToolUse --dry-run
# Output: decision=deny rule=paths.deny matched=~/.aws/credentials reason="[sentinel] ..."

# Dry-run an allowed path
echo '{"tool_name":"Read","tool_input":{"file_path":"/tmp/project/README.md"}}' \
  | node src/sentinel/hook.mjs PreToolUse --dry-run
# Output: decision=allow rule=null matched=null reason="[sentinel] path allowed"

# Error case — non-PreToolUse event
echo '{}' | node src/sentinel/hook.mjs PostToolUse --dry-run
# stderr: dry-run only supports PreToolUse today
# exit code: 1
```

## Configuration

No new configuration keys. `--dry-run` is a CLI flag passed as a positional argument alongside the event name (`PreToolUse`).

## Testing

```sh
# Run full test suite including the five new DR1–DR5 dry-run cases
node --test tests/hook.test.mjs

# Self-test must still pass (regression check)
node src/sentinel/hook.mjs --self-test

# Full validation
make validate
```

The five dry-run test cases each:
1. Create a temp `CLAUDE_PLUGIN_DATA` directory so audit path is isolated
2. Assert exit code 0 (or 1 for DR5)
3. Assert stdout starts with the expected `decision=` prefix
4. Assert the audit file size is unchanged after the dry-run invocation

## Notes

- Output format is intentionally human-readable, not JSON — the `/sentinel-review test` slash command reads the Bash tool result directly; the model can parse `decision=deny rule=paths.deny matched="**/.env" reason="..."` without a JSON parser
- `~/.aws/credentials` in DR3 uses `homedir()` at test runtime; the default `paths.deny` config covers `~/.aws/**` so this is denied regardless of whether the file physically exists
- This spec is independent of Specs 01 and 02 — it does not depend on `tailAuditEntries`, `findAuditEntryById`, `summariseByEventClass`, or `loadConfigWithSources`
- No new runtime npm dependencies were introduced
