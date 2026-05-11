# Registry Policy — Decision Core

**Task ID:** sprint-05/spec-05-registry-policy
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-05-registry-policy.md

## Overview

Implements `src/sentinel/registry-policy.mjs`, the async decision core for Sprint 05's registry-check feature. It re-walks an incoming Bash command string, identifies install segments, runs per-package metadata lookups against the registry cache and fetch clients, applies a 5-step decision tree to each package, and aggregates results using `deny > ask > allow` priority — mirroring the sync `evaluateBash` pattern from Sprint 04.

## What Was Built

- `src/sentinel/registry-policy.mjs` — exports `evaluateRegistry` async function with two private helpers (`decideFromFetch`, `aggregate`)
- `tests/registry-policy.test.mjs` — 9-case `node:test` suite covering all decision-tree branches, fail-open, cache-hit deduplication, deny-wins aggregation, and silent allow for non-install commands
- `src/sentinel/hook.mjs` — wired `evaluateRegistry` into the Bash branch (after `evaluateBash` returns allow); loads/flushes cache around the registry call; added `runBashBranch` export for testability
- 12 registry fixture JSON files under `tests/fixtures/registry/`

## Technical Implementation

### Files Modified

- `src/sentinel/registry-policy.mjs`: new file — exports `evaluateRegistry`, private `decideFromFetch` and `aggregate`
- `src/sentinel/hook.mjs`: imports `evaluateRegistry`, `resolveCachePath`, `loadCache`, `flushCache`; adds `runBashBranch` export; wires registry check after bash-allow path
- `tests/registry-policy.test.mjs`: new file — 9 unit tests, all in-process, stub `fetchFn` injected directly
- `tests/hook-registry.test.mjs`: new file — integration tests for the full hook Bash branch with registry evaluation
- `tests/fixtures/registry/*.json`: 12 fixture files covering all fixture-dispatch scenarios

### Key Changes

- `evaluateRegistry({ command, config, fetchFn, cache, now })` re-walks the raw command via `walk()`, calls `parseInstallSegments`, resolves cache hits, launches all `fetchPackageMetadata` calls concurrently via `Promise.all`, and returns the aggregated result
- `decideFromFetch` applies the 5-step tree in order: `not_found` → deny, `ageDays < minAgeDays` → ask, `weeklyDownloads != null && < min` → ask, no homepage/repo → ask, else allow; network/timeout errors → fail-open allow with rule `registry.unavailable`
- `aggregate` uses `{ deny: 3, ask: 2, allow: 1 }` priority ordering; first-encountered winner when tied; `registry.unavailable` only surfaces if no stronger decision exists
- Cache key is `<ecosystem>:<name>` (lowercased); stored value is `{ ts, decision, reason, rule }`; TTL from `config.registry.cacheTtlHours`
- `crates.io` returns `weeklyDownloads: null`; the low-downloads rule guards with `weeklyDownloads != null` so it never fires for crates packages

## How to Use

```js
import { evaluateRegistry } from './src/sentinel/registry-policy.mjs';

const result = await evaluateRegistry({
  command: 'npm install some-package',
  config,      // loaded via loadConfig()
  fetchFn,     // globalThis.fetch or test stub
  cache,       // plain object from loadCache()
  now,         // Date.now()
});
// result: { decision, rule, matched, matched_segment, reason }
```

Decision values:
- `allow` — package passed all checks (or non-install command)
- `ask` — package is too new, has low downloads, or has no source link
- `deny` — package not found in registry (slopsquatting protection)

Rule values:
| Rule | Decision | Trigger |
|---|---|---|
| `null` | allow | well-established package |
| `registry.unavailable` | allow | network error / timeout (fail-open) |
| `registry.not_found` | deny | 404 from registry |
| `registry.too_new` | ask | `ageDays < minAgeDays` |
| `registry.low_downloads` | ask | `weeklyDownloads < minWeeklyDownloads` |
| `registry.no_source` | ask | no homepage and no repository |

## Configuration

All thresholds are in `config/defaults.json` under the `registry` key:

```json
{
  "registry": {
    "minAgeDays": 14,
    "minWeeklyDownloads": 100,
    "requireHomepage": true,
    "timeoutMs": 250,
    "cacheTtlHours": 1,
    "cacheMaxEntries": 1024
  }
}
```

Override in user or project `sentinel.json` — the three-layer merge from Sprint 02 applies.

## Testing

```bash
# Policy unit tests (all in-process, no network)
node --test tests/registry-policy.test.mjs

# Full suite (zero regressions)
node --test tests/

# Full validation
make validate
```

The test suite injects a stub `fetchFn` directly — no `globalThis.fetch` is ever called. The `cache` object is a plain `{}` passed per-test for isolation.

## Notes

- `evaluateRegistry` is only called after `evaluateBash` returns `allow`, so `walked.exotic` will be `false` in production; the guard is purely defensive
- Compound commands (`npm install lodash && npm install <missing>`) fetch all packages in parallel via `Promise.all`; wall-clock cost is `max(fetch_i)` not `sum(fetch_i)`, staying within the 300 ms latency budget
- Hook integration (wiring into `src/sentinel/hook.mjs`) is part of this sprint but not this spec — see spec-06 documentation and the hook changes in this branch
- Cache is flushed (`flushCache`) after each hook invocation to persist the in-memory TTL state to disk
