# Plugin Manifest & Hook Config

**Task ID:** `sprint-01-plugin-scaffold/spec-03-plugin-manifest-and-hooks`
**Date:** 2026-05-10
**Specification:** `specs/sprint-01-plugin-scaffold/spec-03-plugin-manifest-and-hooks.md`

## Overview

This feature adds the two Claude Code plugin artifacts needed for marketplace discovery and hook registration: `.claude-plugin/plugin.json` (the minimal three-field manifest) and `hooks/sentinel.json` (the hook config wiring all four event categories to the entry script). It also adds `tests/manifest.test.mjs` with five structural assertions and appends the dev-install flow to `README.md`. After this spec, `make validate` exits 0 for the first time in the sprint.

## What Was Built

- `.claude-plugin/plugin.json` — minimal three-field manifest (`name`, `description`, `author`) conforming to the marketplace convention verified across four reference plugins
- `hooks/sentinel.json` — hook config with four event keys (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`), five matcher objects, `timeout: 5` on every entry, and `async: true` on session events
- `tests/manifest.test.mjs` — five `node:test` assertions validating both JSON files at module load time
- `README.md` — "## Local development install" section appended with the three-command dev-install flow
- `tests/fixtures/.gitkeep` — empty placeholder keeping the fixtures directory tracked in git

## Technical Implementation

### Files Modified

- `.claude-plugin/plugin.json`: New — three-field marketplace manifest (`name: "sentinel"`, `description`, `author`)
- `hooks/sentinel.json`: New — hook config registering `PreToolUse` (two matchers), `PostToolUse`, `SessionStart`, `SessionEnd` against `${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs`
- `tests/manifest.test.mjs`: New — five structural assertions covering manifest field presence, forbidden-field absence, event registration, per-entry invariants, and session-event `async` flag
- `README.md`: Appended — "## Local development install" section with three-command flow
- `tests/fixtures/.gitkeep`: New — empty placeholder

### Key Changes

- **Minimal manifest**: `plugin.json` contains exactly `name`, `description`, `author` — no `version`, `hooks`, `commands`, or `license` fields, matching the observed convention across all marketplace plugins
- **Hook timeout safety net**: every hook entry sets `"timeout": 5` (seconds); without this field the Claude Code default is 600 s, which would silently block tool calls for up to ten minutes if `hook.mjs` hangs
- **Session event async**: `SessionStart` and `SessionEnd` entries carry `"async": true` so Claude Code does not wait for the hook to complete before proceeding — required for session lifecycle events that must not block tool calls
- **`${CLAUDE_PLUGIN_ROOT}` anchor**: all `command` fields reference `${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs`; Claude Code interpolates this to the plugin directory's absolute path at invocation time — relative paths are not reliably resolved across sessions
- **Fail-at-load test strategy**: `manifest.test.mjs` reads both JSON files outside any `test()` callback; a missing or malformed file causes the entire test suite to fail at module load rather than silently skipping assertions

## How to Use

### Running validation

```bash
make validate
```

All four steps must exit 0: JSON parse `plugin.json`, JSON parse `hooks/sentinel.json`, `node --test tests/`, `node src/sentinel/hook.mjs --self-test`.

### Running tests

```bash
make test
# or
node --test tests/
```

Reports all suites including `manifest.test.mjs` (five assertions).

### Dev-install flow (requires a live Claude Code session)

```
/plugin marketplace add ./claude-code-sentinel
/plugin install sentinel@claude-code-sentinel
/reload-plugins
```

Replace `./claude-code-sentinel` with the relative or absolute path to your local clone. No schema errors should appear on load.

## Configuration

### `hooks/sentinel.json` — event matchers

| Event | Matcher | Notes |
|---|---|---|
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | File-read/write tools |
| `PreToolUse` | `Bash` | Shell commands — single entry; per-command logic lives in `hook.mjs` |
| `PostToolUse` | `Bash\|Read\|Grep\|Glob` | Output scrubber (Sprint 05) |
| `SessionStart` | `startup\|resume\|clear` | async: true; banner display (Sprint 07) |
| `SessionEnd` | _(no matcher — fires unconditionally)_ | async: true; audit log flush (Sprint 02) |

### `plugin.json` — install slug

The `name` field is `"sentinel"`. The marketplace install slug is `sentinel@claude-code-sentinel`, where `sentinel` is the `name` field and `claude-code-sentinel` is the marketplace name (the repo directory). Any deviation breaks `/plugin install`.

## Testing

```bash
node --test tests/manifest.test.mjs
```

Five tests, all under 50 ms (pure JSON parsing, no subprocess spawn):

| Test | Asserts |
|---|---|
| `plugin.json has required minimal fields` | `name === 'sentinel'`, `description` is string, `author` is object |
| `plugin.json has no forbidden fields` | `version`, `hooks`, `commands` are `undefined` |
| `hooks/sentinel.json registers all four event names` | All four keys present |
| `every hook entry has timeout:5 and CLAUDE_PLUGIN_ROOT command` | Per-entry invariants across all matchers |
| `SessionStart and SessionEnd hooks declare async:true` | `async === true` on both session events |

## Notes

**Hook config filename (`hooks/sentinel.json` vs `hooks/hooks.json`):** All four observed marketplace plugins use `hooks/hooks.json`. This spec uses `hooks/sentinel.json` as specified in the PRD. If the Phase 4 manual smoke test shows Claude Code cannot discover the hook config, rename to `hooks/hooks.json` and update the path in `tests/manifest.test.mjs` and the `Makefile` validate target accordingly.

**`PreToolUse`/`Bash` single entry:** The research doc recommended two separate identical-body entries. This spec uses one — duplicate JSON with byte-for-byte identical content adds no value in Sprint 01. When Sprints 04/05 add per-command logic, that logic is handled inside `hook.mjs` by inspecting `event.toolInput.command`, not via separate hook config entries.

**Zero dependencies:** `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url`, and `node:child_process` are all Node stdlib. No `npm install` is required across all three Sprint 01 specs and must remain so in future sprints.
