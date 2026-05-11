# Bash Fixtures and Self-Test Extension

**Task ID:** sprint-04-bash-exfil-deny / spec-05
**Date:** 2026-05-10
**Specification:** specs/sprint-04-bash-exfil-deny/spec-05-bash-fixtures-and-selftest.md

## Overview

Adds 11 JSON fixture files under `tests/fixtures/bash/` covering the full Sprint 04 acceptance-criteria matrix, and extends the `--self-test` branch in `src/sentinel/hook.mjs` to walk both `tests/fixtures/paths/` and `tests/fixtures/bash/`, dispatching by `tool_name`. The combined fixture count (21) is reported in the unchanged banner format, and a floor assertion (`fixtureCount >= 21`) is added to the existing latency test.

## What Was Built

- 11 bash fixture JSON files under `tests/fixtures/bash/` covering deny, allow, and ask decisions
- Two-directory `--self-test` loop in `hook.mjs` that dispatches `Bash` fixtures to `evaluateBash` and all others to `matchPath`
- Key-iteration comparison (`Object.keys(fixtureExpect).every(...)`) so paths fixtures are not penalised for lacking `matched_segment`
- Combined fixture count (`count`) replacing `files.length` in the self-test banner
- Floor assertion `assert.ok(fixtureCount >= 21)` in `tests/hook.test.mjs`

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Replaced single-directory `--self-test` loop with a two-directory loop over `['paths', 'bash']`; added `tool_name === 'Bash'` dispatch to `evaluateBash`; switched banner variable from `files.length` to `count`
- `tests/hook.test.mjs`: Added `assert.ok(fixtureCount >= 21, ...)` floor assertion after the existing `fixtureCount > 0` check

### New Files

All 11 files under `tests/fixtures/bash/`:

| File | Decision | Rule | Scenario |
|------|----------|------|----------|
| `cat-env-deny.json` | deny | bash.cat | Simple read of secret path |
| `wc-env-allow.json` | allow | null | Value-stripping (line count only) |
| `cat-env-pipe-pbcopy-deny.json` | deny | bash.cat | Pipe exfil — deny fires on first segment |
| `cp-env-tmp-deny.json` | deny | bash.cp | Copy exfil to /tmp |
| `cat-env-redirect-deny.json` | deny | bash.cat | Redirect does not rescue a read |
| `grep-c-env-allow.json` | allow | null | Count-only flag exemption |
| `grep-env-deny.json` | deny | bash.grep | Full grep read without -c |
| `compound-cat-env-deny.json` | deny | bash.cat | Compound command — one bad segment poisons all |
| `compound-wc-env-allow.json` | allow | null | Compound command — both segments safe |
| `heredoc-ask.json` | ask | null | Exotic heredoc shape → fail-closed ask |
| `shasum-env-allow.json` | allow | null | Value-stripping (hash only) |

### Key Changes

- The `--self-test` block now iterates `fixtureDirs = ['paths', 'bash']` and builds the fixture path via `` new URL(`../../tests/fixtures/${dir}`, import.meta.url).pathname ``
- Dispatch is `tool_name === 'Bash'` → `evaluateBash({ command, cwd, home, config })`; everything else → `matchPath`
- Comparison uses `Object.keys(fixtureExpect).every(k => (result[k] ?? null) === (fixtureExpect[k] ?? null))` — paths fixtures (3 keys) are not penalised for missing `matched_segment` (4th key)
- `loadConfig()` is called once outside both loops to amortise config I/O across all 21 fixtures
- The `evaluateBash` import was already present from Spec 4; no new import was added

## How to Use

1. Run `node src/sentinel/hook.mjs --self-test` — should exit 0 and print `Sentinel: self-test ok (21 fixtures, X.Y ms total)`
2. Run `node --test tests/hook.test.mjs` — latency test now asserts `fixtureCount >= 21`
3. Run `make validate` — full pipeline including self-test and unit tests

## Configuration

No new configuration keys. All bash fixtures exercise the shipped `config/defaults.json` defaults populated in Spec 3 (`bash.denyCommands`, `bash.valueStrippingCommands`, `bash.allowValueStripping`).

## Testing

- **Self-test**: `node src/sentinel/hook.mjs --self-test` exercises all 21 fixtures in-process; any mismatch causes exit 1 with a descriptive failure line
- **Unit test**: `node --test tests/hook.test.mjs` — floor assertion `fixtureCount >= 21` fails fast if bash fixtures directory is missing or empty
- **Full suite**: `node --test tests/` — zero regressions across all 10 paths fixtures and 11 bash fixtures

## Notes

- The floor constant `21` in `tests/hook.test.mjs` is the Sprint 04 minimum (10 paths + 11 bash). Future sprints that add fixtures must update this floor.
- All bash fixtures use `cwd: "/home/testuser/myproject"` and relative path arguments (e.g., `.env`). The bash walker resolves relative paths against `cwd` before glob matching.
- The `heredoc-ask.json` fixture has `matched_segment: null` because the `ask` decision fires at the tokenizer level before any segment is matched — there is no specific segment to blame.
- `tests/fixtures/secret-bash.json` (in root `tests/fixtures/`, not `tests/fixtures/bash/`) is not picked up by the self-test loop.
