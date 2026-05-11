# Path Matcher and Defaults

**Task ID:** sprint-03-02
**Date:** 2026-05-10
**Specification:** specs/sprint-03-path-read-deny/spec-02-path-matcher-and-defaults.md

## Overview

This sprint delivered the full path-based read-deny stack: a vendored glob compiler (`glob.mjs`), a pure `matchPath` function (`paths.mjs`), populated deny/allow defaults in `config/defaults.json`, and hook wiring that blocks credential-bearing files from reaching the model context. Out of the box, Sentinel now intercepts `Read`, `Edit`, `Grep`, `Glob`, and `NotebookEdit` calls and denies access to files matching 20 canonical secret patterns (`.env`, `.ssh/id_*`, `.aws/credentials`, `.pem`, `.key`, `.netrc`, etc.) while allowing template variants (`.env.example`, `.pub`).

## What Was Built

- **`src/sentinel/glob.mjs`** — vendored glob-to-RegExp compiler; no runtime dependencies. Supports `**`, `*`, `?`, `[abc]`, `[!a]` character-class negation, and both leading-`**/` and absolute-path anchoring.
- **`src/sentinel/paths.mjs`** — pure `matchPath` function; resolves tilde paths and relative paths before consulting the allow/deny lists. Allow list is checked first (allow beats deny); fail-open on no match.
- **`config/defaults.json`** — `paths.deny` (20 patterns) and `paths.allow` (5 patterns) populated from PRD §6.2. Previously `{}`.
- **`src/sentinel/hook.mjs`** — `PreToolUse` now calls `matchPath` for the five protected tool types; emits `permissionDecision: 'deny'` with a human-readable reason on block. `--self-test` runs all fixture JSON files in-process and reports latency.
- **`src/sentinel/audit.mjs`** — `writeAuditLine` accepts an optional `decisionCtx` parameter (`event`, `decision`, `rule`, `matched`) so blocks are logged with full context. `NotebookEdit` added to input summariser and path extractor.
- **Test fixtures** — 10 JSON fixtures under `tests/fixtures/paths/` covering deny and allow cases for `Read`, `Edit`, `Grep`, `Glob`, and `NotebookEdit`.
- **Test suites** — `tests/paths.test.mjs` (10 cases), `tests/glob.test.mjs` (new), extended `tests/hook.test.mjs` and `tests/config.test.mjs`.

## Technical Implementation

### Files Modified

- `src/sentinel/glob.mjs`: New. Exports `compileGlob(pattern) -> RegExp` and `matchGlob(pattern, path) -> boolean`.
- `src/sentinel/paths.mjs`: New. Exports `matchPath({ filePath, cwd, home, config }) -> { decision, rule?, matched? }`.
- `config/defaults.json`: `paths` key changed from `{}` to object with `deny` (20 patterns) and `allow` (5 patterns).
- `src/sentinel/hook.mjs`: Wired `matchPath` into `PreToolUse`; extended `--self-test` with fixture-based latency test; `emit()` accepts `decisionCtx`.
- `src/sentinel/audit.mjs`: `writeAuditLine` signature extended with `decision` param; `NotebookEdit` branch added to `summariseInput`; `notebook_path` added to path extractor.
- `tests/paths.test.mjs`: New unit suite (10 assertions).
- `tests/glob.test.mjs`: New unit suite for the glob compiler.
- `tests/hook.test.mjs`: Extended with path-deny integration scenarios.
- `tests/config.test.mjs`: One assertion added — `loadConfig().paths.deny.length > 0`.
- `tests/fixtures/paths/*.json`: 10 new fixture files.

### Key Changes

- **Allow-beats-deny semantics**: `matchPath` checks `config.paths.allow` before `config.paths.deny`. `.env.example` is matched by the allow pattern `**/.env.example` and returned immediately — the `**/.env.*` deny pattern is never evaluated.
- **Fail-open default**: when neither list matches, `matchPath` returns `{ decision: 'allow' }` with no `rule` or `matched` fields. Callers should check `result.rule` existence rather than treating `undefined` as an error.
- **Tilde and relative path resolution**: `expandTilde` replaces a leading `~` with `home` before `node:path.resolve` joins relative paths against `cwd`. Both steps happen before any pattern comparison.
- **`?` wildcard support**: `**/secrets*.y?ml` matches both `.yaml` and `.yml`. The glob compiler translates `?` to `[^/]`.
- **Audit decision context**: blocks are logged with `event: 'block'`, `decision: 'deny'`, and the matched rule/pattern, so the audit trail distinguishes warnings from denies.

## How to Use

1. Install Sentinel as a Claude Code plugin — the defaults take effect immediately with no extra config.
2. Attempt to read a protected file (e.g., `.env`, `~/.ssh/id_rsa`) — Claude Code will receive `permissionDecision: 'deny'` and the tool call will be blocked.
3. Template files (`.env.example`, `.env.sample`, `.env.template`, `*.pub`) pass through normally.
4. To add organisation-specific patterns, create `~/.claude/sentinel.json` with a `paths.deny` array. Because `deepMerge` replaces arrays on collision, your array fully overrides the defaults:

```json
{
  "paths": {
    "deny": [
      "**/.env",
      "**/internal-secrets/**"
    ]
  }
}
```

## Configuration

`config/defaults.json` ships these lists:

**`paths.deny`** (20 patterns):
`**/.env`, `**/.env.*`, `**/.envrc`, `**/credentials*.json`, `**/secrets*.y?ml`, `**/secrets*.yml`, `**/.bashrc`, `**/.zshrc`, `**/.profile`, `**/.bash_profile`, `**/*.pem`, `**/*.key`, `**/.aws/credentials`, `**/.aws/config`, `**/.kube/config`, `**/.ssh/id_*`, `**/.npmrc`, `**/.pypirc`, `**/.git-credentials`, `**/.netrc`

**`paths.allow`** (5 patterns — checked first):
`**/.env.example`, `**/.env.sample`, `**/.env.template`, `**/*.pub`, `**/*.public.*`

User or project overrides live in `~/.claude/sentinel.json` or `<project>/.claude/sentinel.json`. Array keys replace (not merge) the defaults.

## Testing

```bash
# Unit tests — paths module
node --test tests/paths.test.mjs

# Unit tests — glob compiler
node --test tests/glob.test.mjs

# Integration tests — hook subprocess with path-deny
node --test tests/hook.test.mjs

# Config loader — paths.deny populated
node --test tests/config.test.mjs

# Full suite
node --test tests/

# In-process self-test with fixture latency report
node src/sentinel/hook.mjs --self-test

# Full validate (manifest, hook config JSON, self-test, node --test)
make validate
```

## Notes

- `glob.mjs` is vendored (no `npm install` required); it handles all patterns in `defaults.json` including `?`, `[abc]`, and `[!a]` negation.
- `matchPath` never calls `process.exit` — it is a pure function safe to import from any module.
- The `--self-test` fixture runner measures total elapsed time for all fixtures and writes it to stderr in the format `self-test ok (N fixtures, X.Y ms total)`.
- `**/.env.*` in the deny list matches `.env.production`, `.env.local`, `.env.staging`, etc. Only the three named template patterns in the allow list are carved out.
- `NotebookEdit` path extraction reads `notebook_path` first, then falls back to `file_path`, consistent with the Claude Code tool-input shape for that tool.
