# Registry Fixtures and Self-Test Extension

**Task ID:** sprint-05/spec-07-registry-fixtures-and-selftest
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-07-registry-fixtures-and-selftest.md

## Overview

This deliverable adds 12 fixture JSON files under `tests/fixtures/registry/` that cover every branch of the registry decision tree, then extends the `--self-test` runner in `src/sentinel/hook.mjs` to dispatch registry fixtures to `evaluateRegistry` using a stub `fetchFn` built from each fixture's `stubFetch` field. Because `evaluateRegistry` is async, the outer `--self-test` block was promoted to an async IIFE. The fixture floor assertion in `tests/hook.test.mjs` was bumped from `>= 21` to `>= 33` (10 paths + 11 bash + 12 registry).

## What Was Built

- 12 registry fixture JSON files under `tests/fixtures/registry/`, one per decision-tree branch
- Async IIFE promotion of the `--self-test` block in `src/sentinel/hook.mjs`
- `lookupStub` inline helper for URL-prefix-to-response mapping inside the IIFE
- `'registry'` bucket added to `fixtureDirs` with full dispatch to `await evaluateRegistry(...)`
- Fresh per-fixture `cache = {}` for fixture isolation
- `fixture.now` passthrough so `ageDays` calculations are deterministic
- Fixture-count floor bump in `tests/hook.test.mjs` (21 → 33)

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Promoted `--self-test` block to async IIFE; added `'registry'` to `fixtureDirs`; added inline `lookupStub` helper and registry dispatch branch; added `evaluateRegistry` and cache imports (deduplicated with spec-06)
- `tests/hook.test.mjs`: Bumped floor assertion at line 299 from `>= 21` to `>= 33`; updated assertion message to `paths + bash + registry`

### New Files

All 12 files under `tests/fixtures/registry/`:

| File | Decision | Rule | Scenario |
|---|---|---|---|
| `01-deny-not-found.json` | deny | `registry.not_found` | npm 404 — unknown package |
| `02-ask-too-new.json` | ask | `registry.too_new` | Package created 5 days ago (threshold: 14 days) |
| `03-ask-low-downloads.json` | ask | `registry.low_downloads` | 10 weekly downloads (threshold: 100) |
| `04-ask-no-source.json` | ask | `registry.no_source` | No `homepage` or `repository` with `requireHomepage: true` |
| `05-allow-popular.json` | allow | null | Well-aged, 1M weekly downloads, has homepage |
| `06-allow-unavailable-network-error.json` | allow | `registry.unavailable` | Fetch throws a plain network error (fail-open) |
| `07-allow-unavailable-timeout.json` | allow | `registry.unavailable` | Fetch throws `AbortError` (fail-open) |
| `08-deny-wins-compound.json` | deny | `registry.not_found` | Compound: lodash (allow) + fake-pkg-9999 (deny) → deny wins |
| `09-pypi-too-new.json` | ask | `registry.too_new` | PyPI package uploaded 3 days ago |
| `10-crates-allow-no-weekly.json` | allow | null | crates.io: `weeklyDownloads: null` skips rule 3 |
| `11-allow-noop-bare-install.json` | allow | null | `npm install` with no args — no packages parsed |
| `12-allow-non-install.json` | allow | null | Non-install command (`ls -la`) — passes through immediately |

### Key Changes

- **Async IIFE**: `if (process.argv.includes('--self-test'))` body replaced with `(async () => { ... })()` so `await evaluateRegistry(...)` is legal without changing the module's top-level synchronous contract.
- **`lookupStub(stubFetch, url)`**: Inline helper inside the IIFE; iterates `Object.keys(stubFetch)` and returns the first entry whose key is a prefix of the requested URL. Absent key synthesises a `{ ok: false, status: 500 }` response — missing stubs surface as `registry.unavailable` rather than silent wrong-allows.
- **`throw` stubs**: Fixtures `06` and `07` use `{ "throw": "network" }` / `{ "throw": "abort" }` to simulate network errors and `AbortError` respectively; the stub `fetchFn` translates these into thrown errors.
- **Per-fixture cache**: `const cache = {}` is created fresh inside each registry fixture iteration, ensuring test-order independence.
- **Deterministic `ageDays`**: All 12 registry fixtures pin `"now": 1746835200000` (2026-05-10T00:00:00Z) so `ageDays` calculations are reproducible regardless of when the self-test runs.
- **`fixtureEvent.config` override**: `fixtureEvent.config ?? selfTestConfig` — no current fixture uses this, but it allows future fixtures to supply non-default config (e.g. `requireHomepage: false`).

## How to Use

1. Run the self-test to validate all 33 fixtures:
   ```sh
   node src/sentinel/hook.mjs --self-test
   # Sentinel: self-test ok (33 fixtures, X.Y ms total)
   ```
2. Run the full test suite to verify floor assertion and regression coverage:
   ```sh
   node --test tests/
   ```
3. Run the full validation pipeline:
   ```sh
   make validate
   ```
4. To add a new registry fixture: create a JSON file in `tests/fixtures/registry/` with keys `event`, `stubFetch`, `now`, and `expect`; bump the floor in `tests/hook.test.mjs` by 1.

## Configuration

Each fixture JSON follows this shape:

```json
{
  "event": {
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": { "command": "<shell command>" }
  },
  "now": 1746835200000,
  "stubFetch": {
    "<url-prefix>": { "status": 200, "body": { ... } }
  },
  "expect": { "decision": "deny|ask|allow", "rule": "<rule|null>", "matched": "<pkg|null>" }
}
```

Stub descriptor fields:
- `{ "status": 200|404|500, "body": <json> }` — normal response
- `{ "throw": "network" }` — throws a plain `Error`
- `{ "throw": "abort" }` — throws an `AbortError` (simulates `AbortSignal.timeout`)
- `{}` (empty `stubFetch`) — no fetch is expected; any fetch call surfaces as `registry.unavailable`

## Testing

- **Self-test**: `node src/sentinel/hook.mjs --self-test` exercises all 33 fixtures in-process with no real network calls. Exits 0 on full pass; exits 1 with a descriptive failure line on any mismatch.
- **Latency test**: `tests/hook.test.mjs` asserts `fixtureCount >= 33` and per-fixture average < 20 ms.
- **Regression coverage**: Sprint 03/04 fixtures (`paths/`, `bash/`) pass through their unchanged synchronous dispatch branches; the async IIFE has no observable effect on their execution.
- **Integration gate**: `make validate` runs `--self-test` as step 3; CI has no network access so all fetches must be stub-driven.

## Notes

- The `paths` and `bash` loop branches are functionally unchanged from Sprint 04; the loop variable was renamed from `dir` to `bucket` as a cosmetic improvement.
- The floor `33` = 10 (paths) + 11 (bash) + 12 (registry). Future sprints adding fixtures must update `tests/hook.test.mjs` line 299 accordingly.
- No live network call is ever made during `--self-test`. All registry fetches resolve synchronously within the stub `fetchFn`.
- This spec touches only `src/sentinel/hook.mjs` (self-test block), `tests/hook.test.mjs` (floor bump), and `tests/fixtures/registry/*.json` (new files). No new source modules were added.
