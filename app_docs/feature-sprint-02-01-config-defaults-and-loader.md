# Config Defaults and Loader

**Task ID:** sprint-02-01
**Date:** 2026-05-10
**Specification:** specs/sprint-02-config-and-audit/spec-01-config-defaults-and-loader.md

## Overview

Implements the three-layer configuration system for the Sentinel plugin: a shipped `config/defaults.json` base, a user-level `~/.claude/sentinel.json` override, and a project-level `.claude/sentinel.json` override. The synchronous `loadConfig()` function deep-merges these layers in order and is entirely fail-open — missing files and malformed JSON are silent no-ops so a bad config never blocks a Claude Code session.

## What Was Built

- `config/defaults.json` — shipped base config with all six PRD §9 top-level keys
- `src/sentinel/config.mjs` — synchronous `loadConfig({ home, cwd })` function with `deepMerge` and `loadLayer` helpers
- `tests/config.test.mjs` — seven flat `test()` calls covering merge precedence, unknown-key round-trip, and fail-open behavior
- `src/sentinel/hook.mjs` — wired `loadConfig` and `writeAuditLine` into the hook entry script (from Spec 4 of this sprint)

## Technical Implementation

### Files Modified

- `config/defaults.json`: New file. Six top-level keys (`paths`, `bash`, `registry`, `ecosystems`, `scrubber`, `audit`). `audit.path` is `null` (activates env-var fallback in `audit.mjs`); `audit.maxSizeMb` is `10`.
- `src/sentinel/config.mjs`: New file. Exports `loadConfig({ home, cwd } = {})`. Contains private `deepMerge(target, source)` and `loadLayer(filepath)` helpers. No external dependencies — uses only `node:fs`, `node:os`, `node:path`, `node:url`.
- `src/sentinel/hook.mjs`: Added `import { loadConfig }` and `import { writeAuditLine }`. Replaced the Sprint 01 `void event` no-op with `const config = loadConfig({ cwd: event.cwd })` and a guarded `writeAuditLine` call.
- `tests/config.test.mjs`: New file. Seven tests using `mkdtempSync` to inject isolated `home`/`cwd` dirs into `loadConfig`.

### Key Changes

- **Three-layer merge**: `loadConfig` applies `deepMerge(deepMerge(defaults, user), project)` — lowest to highest precedence.
- **`deepMerge` semantics**: Plain objects are merged recursively; arrays, scalars, and `null` replace the target value entirely. This means a project config setting `paths.denyGlobs = ['custom/**']` replaces the default array rather than appending to it.
- **`loadLayer` fail-open**: Two separate `try/catch` blocks — one for `readFileSync`, one for `JSON.parse` — both return `{}` on any error. Missing files, permission errors, and malformed JSON are all treated as empty overlays.
- **Testable injection**: `loadConfig` accepts `{ home, cwd }` so tests can pass `mkdtempSync` dirs without mutating `process.env.HOME` or calling `process.chdir`.
- **Path resolution**: `DEFAULTS_PATH` is resolved relative to `import.meta.url` so it works regardless of the caller's working directory.

## How to Use

**Production (in hook entry script):**
```js
import { loadConfig } from './config.mjs'
const config = loadConfig({ cwd: event.cwd })
// config.audit.maxSizeMb → 10 (or user/project override)
```

**User-level override** — create `~/.claude/sentinel.json`:
```json
{ "audit": { "maxSizeMb": 50 } }
```

**Project-level override** — create `.claude/sentinel.json` in any repo:
```json
{ "audit": { "maxSizeMb": 5, "path": "/tmp/my-project-audit.jsonl" } }
```

Project values take precedence over user values; user values take precedence over shipped defaults. Omitted keys fall through to the lower layer.

## Configuration

`config/defaults.json` defines the canonical default shape:

| Key | Default | Notes |
|---|---|---|
| `paths` | `{}` | Reserved for deny-glob path rules |
| `bash` | `{}` | Reserved for bash command policy |
| `registry` | `{}` | Reserved for registry rules |
| `ecosystems` | `{}` | Reserved for ecosystem-level rules |
| `scrubber` | `{}` | Reserved for PII scrubbing config |
| `audit.path` | `null` | `null` activates `SENTINEL_AUDIT_PATH` env-var fallback in `audit.mjs` |
| `audit.maxSizeMb` | `10` | Rotation threshold for the audit JSONL file |

Unknown keys in user or project configs are preserved unchanged for forward-compatibility.

## Testing

```bash
node --test tests/config.test.mjs   # run config tests only
node --test tests/                  # full suite
make validate                       # JSON parse + tests + self-test
```

The test suite covers:
- Defaults-only load (no user/project files) returns all six keys
- Project value overrides user value at a nested key
- User value applies where project omits
- Defaults apply where both user and project omit
- Unknown key in user config round-trips unchanged
- Malformed user JSON does not throw and falls back to defaults
- Missing user and project files are silent no-ops

## Notes

- `loadConfig` never throws. All filesystem and JSON errors fall back silently to the next lower layer.
- Arrays in a config overlay always replace the target array — they are never concatenated. This is intentional: overrides should be deterministic.
- `hook.mjs` passes `event.cwd` (not `process.cwd()`) to `loadConfig` so the project-level sentinel.json is resolved relative to the project the user is currently working in, not the plugin installation directory.
- Schema validation of the merged config is deferred to Sprint 03+. Unknown keys are currently preserved without type-checking.
