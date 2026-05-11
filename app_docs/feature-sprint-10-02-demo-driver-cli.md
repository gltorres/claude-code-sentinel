# Demo Driver CLI

**Task ID:** sprint-10/spec-02-demo-driver-cli
**Date:** 2026-05-11
**Specification:** specs/sprint-10-demo-and-launch/spec-02-demo-driver-cli.md

## Overview

Implements `tools/demo.mjs`, a zero-dependency Node.js ESM script that drives four scripted demo steps end-to-end by spawning the sentinel hook as a subprocess. The driver exercises each of Sentinel's major defensive capabilities in sequence (path-deny, registry check, output scrubber, and audit review) and outputs a human-readable pass/fail summary. A companion test suite in `tests/demo.test.mjs` validates the driver via subprocess assertions.

## What Was Built

- `tools/demo.mjs` — demo driver script with four sequential demo steps, `runStep` helper, hermetic `CLAUDE_PLUGIN_DATA` isolation, `--write-transcript` flag, and honest-limitation footer after step 3
- `tests/demo.test.mjs` — 9 `node:test` test cases that invoke the driver as a subprocess and assert exit code, per-step PASS markers, and `demo/audit.jsonl` line count
- `demo/demo-stub-fetch.json` — generated stub fixture for step 2's hermetic PyPI registry response
- `demo/transcript.md` and `demo/test-transcript.md` — generated transcript artifacts written by the driver under `--write-transcript`

## Technical Implementation

### Files Modified

- `tools/demo.mjs`: New file — shebang, hand-rolled argv parse, `runStep` helper, four demo steps, hermetic setup, `--write-transcript` stub, exit-code contract
- `tests/demo.test.mjs`: New file — 9 `node:test` cases, subprocess invocation via `spawnSync`, audit line count and validity assertions

### Key Changes

- **`runStep` helper** (`tools/demo.mjs:36-87`): Spawns `node src/sentinel/hook.mjs <Event>` with JSON piped to stdin via `spawnSync`'s `input` option. Compares `hookSpecificOutput` fields against an `expect` map; keys ending in `_includes` do substring matching (used for `additionalContext` in step 3).

- **Hermetic environment** (`tools/demo.mjs:90-97`): Every subprocess spawn receives `CLAUDE_PLUGIN_DATA=<repoRoot>/demo/` so the audit log routes to `demo/audit.jsonl` instead of `~/.claude/sentinel/`. The driver creates `demo/` with `mkdirSync({ recursive: true })` and deletes any stale audit log at startup.

- **Step 2 registry stub** (`tools/demo.mjs:123-165`): Writes a temporary JSON fixture to `demo/demo-stub-fetch.json` and passes its path via `SENTINEL_TEST_FETCH_FIXTURES`. The stub body uses `upload_time_iso_8601: '2026-05-08T00:00:00.000000Z'` (3 days before the sprint date) to trigger the `ageDays < 14` → `registry.too_new` → `ask` branch without any network call.

- **Step 3 honest-limitation footer** (`tools/demo.mjs:192-202`): After the PostToolUse scrubber step prints its PASS/FAIL, the driver unconditionally emits a plain-text caveat explaining that `additionalContext` is a next-turn backstop — the raw value already reached the model's context window this turn. Wording is derived from `README.md:22`.

- **Step 4 direct `spawnSync`** (`tools/demo.mjs:207-230`): Spawns `review-cli.mjs recent 3` directly (not via `runStep`) since its output format is pipe-delimited lines, not a JSON hook envelope. Asserts exit code 0 and exactly 3 non-empty stdout lines.

## How to Use

1. Run the demo driver directly:
   ```
   node tools/demo.mjs
   ```
2. Optionally capture a Markdown transcript (path stored for Spec 10-03's formatter):
   ```
   node tools/demo.mjs --write-transcript=demo/transcript.md
   ```
3. Run the test suite to validate the driver:
   ```
   node --test tests/demo.test.mjs
   ```
4. Run all tests including the demo suite:
   ```
   node --test tests/
   ```
5. Run the full validation gate:
   ```
   make validate
   ```

The driver exits 0 when all four steps match expectations, or 1 if any step fails, printing a per-step FAIL line before exiting.

## Configuration

| Variable | Set by | Purpose |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | Driver (internal) | Routes audit log to `demo/audit.jsonl`; never written to `~/.claude/sentinel/` |
| `SENTINEL_TEST_FETCH_FIXTURES` | Driver (step 2) | Path to the stub JSON fixture; makes step 2 fully network-free |

No user configuration is required. All environment variables are set internally by the driver.

## Testing

`tests/demo.test.mjs` contains 9 test cases:

1. **Exit code 0** — clean run passes all four steps
2. **Step 1 PASS marker** — stdout includes `Step 1` and `PASS`
3. **Step 2 PASS marker** — stdout includes `Step 2` and `PASS`
4. **Step 3 PASS marker** — stdout includes `Step 3` and `PASS`
5. **Honest-limitation footer** — stdout includes `next-turn backstop`
6. **Step 4 PASS marker** — stdout includes `Step 4` and `PASS`
7. **Audit line count** — `demo/audit.jsonl` has exactly 3 lines after a run
8. **Audit line validity** — each line parses as JSON with a non-null `rule` field
9. **`--write-transcript` flag** — driver accepts the flag and exits 0

## Notes

- **`demo/` directory** is a generated artifact created at runtime. `.gitignore` treatment and `make clean-demo` are deferred to Spec 10-03.
- **`--write-transcript` is a stub in this spec.** The driver writes `<!-- transcript placeholder -->` to the specified path. Spec 10-03 will replace this with a real Markdown formatter.
- **Step 4 does not use `runStep`** because `review-cli.mjs` emits pipe-delimited plain text, not a JSON hook envelope. The two invocation patterns are kept explicit to avoid overloading `runStep`'s envelope-parsing logic.
- **Audit log is cleared at startup** so that repeated `node tools/demo.mjs` invocations are idempotent and the 3-line assertion in step 4 and tests is always deterministic.
- **Step 2 stub date is hardcoded** to `2026-05-08T00:00:00.000000Z`. A dynamic `new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()` approach would avoid aging out of the `< 14 days` window, but is not implemented in this spec.
- **No runtime npm dependencies** — the driver uses only `node:child_process`, `node:fs`, `node:path`, `node:url`, and `node:process`.
