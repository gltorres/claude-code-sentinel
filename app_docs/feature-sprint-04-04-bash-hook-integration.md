# Bash Exfil Deny — Hook Integration

**Task ID:** sprint-04-04
**Date:** 2026-05-10
**Specification:** specs/sprint-04-bash-exfil-deny/spec-04-hook-integration.md

## Overview

This feature wires the `evaluateBash` policy module (Sprint 04 Spec 3) into the live hook entry point, replacing the prior scaffold-allow stub for Bash events. Every `PreToolUse` Bash command is now evaluated against the deny/allow/ask policy; denies emit a block envelope and populate the previously-reserved `matched_segment` audit field. This is the final behaviour-changing step of Sprint 04.

## What Was Built

- **Bash branch in `hook.mjs`**: Replaces the unconditional scaffold-allow `else` block for Bash tool events with a tri-outcome handler (`deny` / `ask` / `allow`), leaving the unrecognised-tool fallback untouched as an inner `else`.
- **`evaluateBash` import**: Static import of `evaluateBash` from `./bash-policy.mjs` added to `hook.mjs`.
- **Inline `truncate` helper**: A one-liner defined inside the Bash branch to cap reason strings at 40 characters, avoiding oversized stdout lines.
- **`matched_segment` threading in `audit.mjs`**: `summariseInput` gains an optional 4th `decisionCtx` parameter; the Bash branch now reads `decisionCtx?.matched_segment ?? null` instead of hardcoding `null`.
- **`summariseInput` call updated**: `writeAuditLine` passes its `decision` argument as the 4th arg to `summariseInput`.
- **Self-test extended to bash fixtures**: The `--self-test` harness now iterates both `tests/fixtures/paths/` and `tests/fixtures/bash/`, dispatching path fixtures through `matchPath` and bash fixtures through `evaluateBash`.
- **Integration tests (Tests 9–11)**: Three subprocess tests in `tests/hook.test.mjs` asserting deny, allow, and ask outcomes for `cat .env`, `wc -l .env`, and a heredoc command.
- **Audit direct-call test (test j)**: One test in `tests/audit.test.mjs` asserting `matched_segment` is populated from `decisionCtx` on a Bash deny.
- **Bash fixtures**: 11 fixture JSON files under `tests/fixtures/bash/` covering deny, allow, and ask shapes.

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `evaluateBash` import; replaced scaffold-allow Bash else-block with tri-outcome handler; extended `--self-test` to iterate `tests/fixtures/bash/` alongside paths fixtures.
- `src/sentinel/audit.mjs`: Extended `summariseInput` signature with optional `decisionCtx = {}`; replaced `matched_segment: null` with `decisionCtx?.matched_segment ?? null`; updated `writeAuditLine` to pass `decision` as fourth arg to `summariseInput`.
- `tests/hook.test.mjs`: Appended `makeBashEvent` helper and Tests 9–11 (deny, allow, ask subprocess integration tests).
- `tests/audit.test.mjs`: Appended test (j) asserting non-null `matched_segment` on a Bash deny audit record.
- `config/defaults.json`: Updated as part of Spec 3 (bash policy defaults already present).

### New Files

- `tests/fixtures/bash/cat-env-deny.json`
- `tests/fixtures/bash/cat-env-pipe-pbcopy-deny.json`
- `tests/fixtures/bash/cat-env-redirect-deny.json`
- `tests/fixtures/bash/compound-cat-env-deny.json`
- `tests/fixtures/bash/compound-wc-env-allow.json`
- `tests/fixtures/bash/cp-env-tmp-deny.json`
- `tests/fixtures/bash/grep-c-env-allow.json`
- `tests/fixtures/bash/grep-env-deny.json`
- `tests/fixtures/bash/heredoc-ask.json`
- `tests/fixtures/bash/shasum-env-allow.json`
- `tests/fixtures/bash/wc-env-allow.json`

### Key Changes

- The scaffold-allow `else` block at `hook.mjs:153-159` (pre-change) is replaced by `else if (tool === 'Bash')` with explicit deny/ask/allow outcome handling, and the original unrecognised-tool fallback is preserved as the final `else`.
- `evaluateBash` is called inside a `try/catch`; on any exception the branch fail-opens to allow, consistent with the fail-open contract for the entire hook.
- Bash deny audit records set `event: 'block'`, `decision: 'deny'`, `rule`, `matched`, and `matched_segment` — the first time `matched_segment` is non-null in the audit log.
- Bash ask decisions use `rule: bashResult.rule || 'bash.exotic'` so the audit record always has a non-null rule even when the tokenizer fires the exotic flag without a named rule.
- The `summariseInput` signature extension is backward-compatible — all non-Bash callers pass three arguments and the fourth defaults to `{}`, preserving `matched_segment: null` for all other tools.

## How to Use

The integration is automatic — no user configuration is needed beyond what Sprint 04 Spec 3 already sets up in `config/defaults.json`.

1. Claude Code fires a `PreToolUse` Bash hook event when the agent attempts a shell command.
2. `hook.mjs` calls `evaluateBash({ command, cwd, home, config })`.
3. **Deny**: emits `permissionDecision: 'deny'` with a reason string like `Sentinel: bash segment 'cat .env' reads **/.env (bash.deny.cat)`; audit JSONL records `event: block`, `decision: deny`, `rule`, `matched`, and `matched_segment`.
4. **Ask**: emits `permissionDecision: 'ask'` for heredocs, command substitutions, and other exotic shapes; audit records `event: ask`, `decision: ask`.
5. **Allow**: emits `permissionDecision: 'allow'` for value-stripping commands (`wc`, `grep -c`, `shasum`) and other safe patterns.

## Configuration

Bash policy is driven by `config/defaults.json` (populated in Spec 3):

```json
{
  "bash": {
    "denyCommands": ["cat", "cp", "mv", ...],
    "valueStrippingCommands": ["wc", "grep -c", "shasum", ...]
  }
}
```

Users and projects can override via `~/.claude/sentinel.json` or `.claude/sentinel.json` using the three-layer merge from Spec 2-01.

## Testing

```bash
# Full suite — must exit 0
make validate

# Hook subprocess tests (Tests 9–11 cover deny/allow/ask)
node --test tests/hook.test.mjs

# Audit direct-call test (test j — matched_segment population)
node --test tests/audit.test.mjs

# Full repo test suite
node --test tests/

# Self-test (covers all 11 bash fixtures + path fixtures)
node src/sentinel/hook.mjs --self-test

# Smoke test
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | node src/sentinel/hook.mjs PreToolUse
# Expected: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}
```

## Notes

- `truncate` is defined inline in the Bash branch rather than at module scope to keep `hook.mjs`'s outer scope free of utility helpers.
- The existing `tests/hook.test.mjs:64-76` test (`'PreToolUse writes one audit line to CLAUDE_PLUGIN_DATA'`) uses `tool_name: 'Bash'` with `command: 'ls'`; `evaluateBash` returns `allow` for `ls` so that test remains green.
- The 12-field top-level audit record ordering invariant (`tests/audit.test.mjs:31-40`) is unaffected — only the `input_summary` sub-object's `matched_segment` value changes.
- Unrecognised tool names still reach the inner `else` and receive the original `scaffold no-op` allow envelope, preserving backward compatibility.
