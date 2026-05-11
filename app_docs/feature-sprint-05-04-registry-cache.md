# Registry Cache Module

**Task ID:** sprint-05/spec-04-registry-cache
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-04-registry-cache.md

## Overview

Implements `src/sentinel/registry-cache.mjs`, a fail-open disk-backed cache for registry lookup decisions. It short-circuits redundant network fetches by persisting `allow`/`ask`/`deny` verdicts to `${CLAUDE_PLUGIN_DATA}/cache.json` with TTL and size-cap eviction, so repeated install-command evaluations within the TTL window cost zero network round trips.

## What Was Built

- `resolveCachePath(env)` — resolves the absolute cache file path, mirroring the three-step priority chain in `audit.mjs`: `CLAUDE_PLUGIN_DATA` env var → `~/.claude/sentinel/cache.json`
- `loadCache(path)` — reads and parses `cache.json`; returns `{}` on any error (missing file, corrupt JSON, bad type)
- `getCached(cache, key, ttlMs, now)` — pure in-memory lookup; returns `undefined` on miss or TTL expiry
- `setCached(cache, key, value, now)` — pure in-memory write; stamps `ts: now` onto the stored value
- `flushCache(path, cache, maxEntries)` — evicts oldest entries by `ts` when over cap, then `writeFileSync`; swallows all I/O errors
- `tests/registry-cache.test.mjs` — eight-scenario test suite using `mkdtempSync` filesystem isolation

## Technical Implementation

### Files Modified

- `src/sentinel/registry-cache.mjs`: New module — five named exports, private `expandTilde` helper, ~72 LOC
- `tests/registry-cache.test.mjs`: New test file — eight `test()` blocks, flat style matching `audit.test.mjs` conventions

### Key Changes

- **Fail-open everywhere**: `loadCache` wraps `readFileSync`+`JSON.parse` in `try/catch {}` returning `{}`; `flushCache` wraps `mkdirSync`+`writeFileSync` in `try/catch {}` — neither ever throws
- **Path resolution mirrors audit.mjs**: `resolveCachePath` duplicates the private `resolveAuditPath` env-var dance from `src/sentinel/audit.mjs:11-24`, substituting `cache.json` for `audit.jsonl`; `resolveAuditPath` is not exported so it cannot be reused
- **Eviction by `ts`**: `flushCache` sorts keys ascending by `cache[k].ts` and deletes the oldest excess entries before writing; eviction only runs when `Object.keys(cache).length > maxEntries`
- **Pure in-memory ops**: `getCached` and `setCached` are O(1) plain-object operations — no filesystem access
- **Cache value shape**: `{ ts, decision, reason, rule }` — callers pass `{ decision, reason, rule }` to `setCached` and receive the full shape from `getCached`, enabling Spec 05 policy to skip all network/decision logic on a warm hit

## How to Use

The cache is consumed end-to-end in the registry check pipeline (Spec 06 wires it into `hook.mjs`). Direct usage from another module:

```js
import { resolveCachePath, loadCache, getCached, setCached, flushCache } from './registry-cache.mjs'

const cachePath = resolveCachePath()          // reads process.env
const cache = loadCache(cachePath)            // {} on any error

const key = 'npm:lodash'
const ttlMs = 3_600_000                       // 1 hour
const now = Date.now()

const hit = getCached(cache, key, ttlMs, now)
if (!hit) {
  const result = { decision: 'allow', reason: null, rule: null }
  setCached(cache, key, result, now)
}

flushCache(cachePath, cache, 1024)            // trim + write; never throws
```

## Configuration

Cache behaviour is controlled by keys loaded from `config/defaults.json` (Sprint 05, Spec 01):

| Config key | Default | Description |
|---|---|---|
| `registry.cacheTtlMs` | `3600000` | TTL in milliseconds (1 hour) |
| `registry.cacheMaxEntries` | `1024` | Maximum entries before LRU eviction |

The cache file path defaults to `~/.claude/sentinel/cache.json`. Override by setting `CLAUDE_PLUGIN_DATA` to any directory.

## Testing

```bash
node --test tests/registry-cache.test.mjs
```

Eight scenarios are covered:

1. `loadCache` on a missing file returns `{}`
2. `loadCache` on corrupt JSON returns `{}`
3. `getCached` returns entry when within TTL
4. `getCached` returns `undefined` past TTL
5. `setCached` + `flushCache` + `loadCache` round-trip preserves all fields
6. `flushCache` evicts oldest entries down to `maxEntries`
7. `flushCache` to a read-only directory does not throw
8. `resolveCachePath` honours `CLAUDE_PLUGIN_DATA`

## Notes

- **No cross-process locking**: two simultaneous hook processes may overwrite each other's flush. Acceptable for MVP — the cache is a performance optimisation, not a correctness boundary. A stomped write causes at most one redundant network fetch.
- **Sync I/O by design**: `readFileSync`/`writeFileSync` keep the hook's critical path simple; for a small JSON file (≤100 KB at 1024-entry cap) parse time is negligible relative to the 300 ms cache-miss budget.
- **Not yet wired into `hook.mjs`**: this module is standalone until Spec 06 (hook integration) adds the `loadCache`/`flushCache` calls around the registry evaluation path.
