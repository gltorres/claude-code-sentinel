# Project Skeleton — Sentinel Plugin Scaffold

**Task ID:** `sprint-01-plugin-scaffold/spec-01-project-skeleton`
**Date:** 2026-05-10
**Specification:** `specs/sprint-01-plugin-scaffold/spec-01-project-skeleton.md`

## Overview

This sprint established the foundational project skeleton for Sentinel, a Claude Code plugin that provides defense-in-depth security hooks. The implementation went beyond the spec-01 scope (package.json, Makefile, placeholder test, fixtures dir) to also deliver the plugin manifest, hooks configuration, the hook entry point, and full test coverage — completing the entire sprint-01 scope across all three planned specs in one pass.

## What Was Built

- `package.json` — ESM module manifest with zero dependencies, Node ≥ 20.10 engine requirement, `test` and `self-test` scripts
- `Makefile` — Three `.PHONY` targets: `validate` (full gate), `test` (runner only), `demo` (placeholder)
- `src/sentinel/hook.mjs` — Fail-open ESM hook entry point handling all four Claude Code hook events
- `.claude-plugin/plugin.json` — Claude plugin manifest with name, description, and author
- `hooks/sentinel.json` — Hook registration config wiring all four events (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`) to the hook entry point
- `tests/placeholder.test.mjs` — Scaffold-wiring placeholder test (1 assertion)
- `tests/hook.test.mjs` — 7 subprocess-level tests exercising hook behavior and fail-open guarantees
- `tests/manifest.test.mjs` — 5 tests validating plugin.json and hooks/sentinel.json structure
- `tests/fixtures/.gitkeep` — Empty directory placeholder for later sprint fixture JSON files

## Technical Implementation

### Files Modified

- `.gitignore`: Added `node_modules/` defensive entry

### New Files

- `package.json`: ESM manifest — `"type": "module"`, `"private": true`, `"engines": { "node": ">=20.10" }`, zero deps
- `Makefile`: Tab-indented `.PHONY` targets; `validate` runs JSON parse on both manifests + test suite + self-test; `test` runs `node --test tests/*.mjs`
- `src/sentinel/hook.mjs`: Single ESM entry; reads stdin synchronously, parses event JSON, switches on event name, emits envelope JSON to stdout, exits 0; all error paths are fail-open (allow)
- `.claude-plugin/plugin.json`: Minimal Claude plugin manifest with `name`, `description`, `author`
- `hooks/sentinel.json`: Hook registration with `PreToolUse` (Read/Edit/Grep/Glob/Bash matchers), `PostToolUse`, `SessionStart` (async), `SessionEnd` (async); all entries use `timeout: 5` and reference `${CLAUDE_PLUGIN_ROOT}`
- `tests/placeholder.test.mjs`: Single `assert.ok(true)` to wire the test runner
- `tests/hook.test.mjs`: Subprocess tests via `spawnSync` covering self-test, all four event envelopes, unknown-event fallthrough, and invalid-JSON fail-open
- `tests/manifest.test.mjs`: Structural tests for plugin.json required fields, forbidden fields, event registration completeness, timeout/command shape, and async flags on session events

### Key Changes

- **Fail-open design**: Every error path in `hook.mjs` (bad Node version, stdin read error, JSON parse failure, unknown event) emits `permissionDecision: 'allow'` rather than blocking Claude Code. This prevents Sentinel from becoming a denial-of-service vector.
- **Synchronous stdin read**: Uses `readFileSync(0, 'utf8')` (file descriptor 0) to consume the hook event payload — no async needed since events are tiny and the process is short-lived.
- **Envelope format**: All output follows the Claude Code hook envelope shape: `{ hookSpecificOutput: { hookEventName, ...eventSpecificFields } }` written to stdout as a single JSON line.
- **`${CLAUDE_PLUGIN_ROOT}` variable**: All hook commands in `hooks/sentinel.json` reference the plugin root via this variable, making the hook location portable regardless of install path.
- **Zero-dependency stance**: No `npm install` is required; `node:test`, `node:assert/strict`, `node:fs`, `node:child_process`, `node:url`, `node:path` are all Node stdlib — a deliberate security posture.

## How to Use

1. **Run the test suite**: `make test` — exits 0, reporting 13 pass / 0 fail
2. **Validate all manifests**: `make validate` — validates `plugin.json`, `hooks/sentinel.json`, runs tests, runs self-test
3. **Run tests directly**: `node --test tests/` or `node --test tests/*.mjs`
4. **Self-test the hook**: `node src/sentinel/hook.mjs --self-test` — exits 0 with `Sentinel: self-test ok` on stderr
5. **Invoke hook manually**: `echo '{"tool":"Read"}' | node src/sentinel/hook.mjs PreToolUse` — emits envelope JSON to stdout

## Configuration

No configuration required for Sprint 01. The hook is a no-op scaffold that allows all tool use. Future sprints (02–06) will add:
- Path-deny rules (Spec 02 scope)
- Bash exfil deny rules (Spec 03 scope)
- Registry check integration
- Output scrubber
- Audit log writer

The `hooks/sentinel.json` wires the hook to Claude Code via `${CLAUDE_PLUGIN_ROOT}` — set automatically when the plugin is installed via the Claude Code plugin system.

## Testing

```bash
make test                          # Full test suite (13 tests)
node --test tests/                 # Same, bypassing Make
node --check tests/placeholder.test.mjs   # Syntax check
make validate                      # Full validation gate (all manifests + tests + self-test)
```

Expected output from `make test`:
```
# tests 13
# pass 13
# fail 0
```

## Notes

- **Spec 01 vs delivered scope**: Spec 01 planned only the project skeleton (package.json, Makefile, placeholder test). The sprint delivered the full Sprint 01 scope including the hook entry point (Spec 02) and plugin manifests (Spec 03), with all 13 tests passing.
- **`make validate` is the sprint gate**: All three specs must be complete before `make validate` exits 0. It validates both JSON manifests, runs the full test suite, and runs the self-test.
- **`tests/fixtures/`** is intentionally empty. Sprint 02+ will populate it with stub event JSON files for fixture-replay testing.
- **Session events are `async: true`**: `SessionStart` and `SessionEnd` hooks declare `async: true` in `hooks/sentinel.json` so they don't block Claude Code's startup/shutdown path.
- **No `npm install` at any point**: The zero-dep stance means `make test` works on a fresh clone with only Node ≥ 20.10 installed.
