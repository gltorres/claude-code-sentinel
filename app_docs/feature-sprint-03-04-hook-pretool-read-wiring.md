# Hook PreToolUse Read Wiring

**Task ID:** sprint-03-04
**Date:** 2026-05-10
**Specification:** specs/sprint-03-path-read-deny/spec-04-hook-pretool-read-wiring.md

## Overview

This feature wires the path-matcher (`matchPath` from Spec 02) and the parameterised audit writer (`writeAuditLine` from Spec 03) into the live hook entry point. Previously, `case 'PreToolUse'` in `src/sentinel/hook.mjs` unconditionally emitted `permissionDecision: 'allow'` regardless of which path Claude Code was about to read or edit. After this change, any `Read | Edit | Grep | Glob | NotebookEdit` operation whose resolved path matches a `paths.deny` rule (and is not rescued by a `paths.allow` override) is blocked before content reaches the model, with a structured deny envelope on stdout and a `block`/`deny` audit line in the JSONL log.

## What Was Built

- Path-extraction logic for the five protected tool types (`Read`, `Edit`, `Grep`, `Glob`, `NotebookEdit`), each using the correct `tool_input` field
- `matchPath` integration in `case 'PreToolUse'` — deny envelope emitted on first matching `paths.deny` pattern not overridden by `paths.allow`
- Extended `emit()` to accept an optional `decisionCtx` argument forwarded to `writeAuditLine`, enabling deny audit records
- Enhanced `--self-test` branch that runs all JSON fixtures in `tests/fixtures/paths/` in-process and reports pass/fail counts with millisecond latency
- 8 new integration tests in `tests/hook.test.mjs` covering all five tool types, the SSH key deny/allow pair, and JSONL audit readback assertions

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs` — added `homedir` and `matchPath` imports; extended `emit()` with `decisionCtx`; replaced scaffold `case 'PreToolUse'` with path-matching dispatch; extended `--self-test` to run path fixtures
- `tests/hook.test.mjs` — appended 8 integration tests using `runHookEnv` + `mkdtempSync` + JSONL readback pattern

### Key Changes

- **`emit(obj, decisionCtx = {})`** — the second parameter defaults to `{}`, which causes `writeAuditLine` to fall back to its own defaults (`event: 'warn'`, `decision: 'allow'`). All pre-existing callers (`PostToolUse`, `SessionStart`, `SessionEnd`) are unaffected.

- **Path extraction per tool type** — `Read | Edit | Grep` use `tool_input.file_path`; `NotebookEdit` uses `tool_input.notebook_path ?? tool_input.file_path`; `Glob` uses `tool_input.pattern` (the pattern is treated as the path-under-test, resolved against `cwd`).

- **Allow-beats-deny semantics** — `matchPath` checks `paths.allow` first. A match there returns `{ decision: 'allow' }` even if `paths.deny` also matches. Example: `.env.example` is explicitly allowed even though `**/.env.*` is denied.

- **Deny envelope shape** — on deny, stdout carries `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Sentinel: read of <matched> blocked by paths.deny' } }`. Exit code is always `0`; exit code 1 is never used to signal deny.

- **Self-test fixture runner** — `--self-test` reads every `.json` file from `tests/fixtures/paths/`, calls `matchPath` for each, compares `decision`/`rule`/`matched` against the fixture's `expect` object, and exits 1 on any mismatch with a descriptive stderr message. Reports total fixture count and elapsed time on success.

## How to Use

The deny enforcement is fully automatic — no configuration is required beyond what ships in `config/defaults.json`. When Claude Code fires a `PreToolUse` hook for a protected tool, Sentinel evaluates the path and returns a deny or allow decision before the tool runs.

To observe the behaviour manually:

1. Send a crafted hook event on stdin:
   ```sh
   echo '{"session_id":"s","cwd":"/tmp","tool_name":"Read","tool_input":{"file_path":"/tmp/.env"}}' \
     | node src/sentinel/hook.mjs PreToolUse
   ```
2. Inspect stdout — a deny will show `"permissionDecision":"deny"`.
3. Check the audit log at `$CLAUDE_PLUGIN_DATA/audit.jsonl` for the `block` record.

Run the self-test to validate all path fixtures against `matchPath` in one command:

```sh
node src/sentinel/hook.mjs --self-test
```

## Configuration

Deny and allow glob lists live in `config/defaults.json` under `paths.deny` and `paths.allow`. Users can override these in their project or user `sentinel.json` via the three-layer merge that `loadConfig` performs (see feature-sprint-02-01).

Default `paths.deny` patterns include: `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/.ssh/id_*`, `**/.aws/credentials`, `**/.kube/config`, `**/.netrc`, and others.

Default `paths.allow` overrides include: `**/.env.example`, `**/.env.sample`, `**/.env.template`, `**/*.pub`, `**/*.public.*`.

## Testing

```sh
# Run hook integration tests (includes 8 new deny/allow cases)
node --test tests/hook.test.mjs

# Run full test suite (no regressions)
node --test tests/

# Self-test with path fixture validation and latency report
node src/sentinel/hook.mjs --self-test

# Full validation pipeline
make validate
```

Integration test cases covered:

| # | Tool | Path | Expected |
|---|------|------|----------|
| 1 | Read | `.env` | deny |
| 2 | Read | `.env.example` | allow |
| 3 | Edit | `.env` | deny |
| 4 | Grep | `credentials.json` | deny |
| 5 | Glob | `.env` (pattern) | deny |
| 6 | NotebookEdit | `~/.zshrc` | deny |
| 7 | Read | `~/.ssh/id_ed25519` | deny |
| 8 | Read | `~/.ssh/id_ed25519.pub` | allow |

## Notes

- `Bash` and unrecognised tool names skip path extraction entirely and continue to emit `permissionDecision: 'allow'` with reason `'scaffold no-op'` — unchanged from Sprint 02.
- The `case 'PreToolUse':` block is wrapped in `{ }` braces to give block scope to its `const` declarations, avoiding conflicts with future `case` branches that also declare locals.
- Integration tests include `rmSync` cleanup of temp directories; the two pre-existing audit tests (lines 64–99) omit cleanup and were not modified.
- `homedir()` is called once per `PreToolUse` invocation — it is a cheap synchronous OS call (~1 µs) and needs no caching because each hook invocation is a fresh process.
- All imports are static; no dynamic `import()` is used. This is required to stay within the cold-start budget documented in the Spec 04 research notes.
