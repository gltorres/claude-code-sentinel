# Registry Clients Module

**Task ID:** sprint-05/spec-03-registry-clients
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-03-registry-clients.md

## Overview

Implements `src/sentinel/registry-clients.mjs`, a pure-async module that fetches and normalises package metadata from npm, PyPI, and crates.io into a uniform shape consumed by the registry policy layer. The module accepts an injected `fetchFn` for testability, never throws (all errors become `{ status: 'error' }`), and has zero runtime dependencies or `import` statements.

## What Was Built

- `src/sentinel/registry-clients.mjs` — named export `fetchPackageMetadata`, three internal per-ecosystem helpers, zero imports, 155 LOC
- `tests/registry-clients.test.mjs` — 17 test cases using stub `fetchFn`; covers all three ecosystems, error paths, scoped package encoding, and secondary-fetch fallback behavior

## Technical Implementation

### Files Modified

- `src/sentinel/registry-clients.mjs`: Created from scratch — `fetchPackageMetadata` dispatcher plus `fetchNpm`, `fetchPyPI`, `fetchCrates` internal helpers
- `tests/registry-clients.test.mjs`: Created from scratch — 17 `test()` blocks using a `makeStub(routes)` factory; no live network calls

### Key Changes

- **Dispatcher**: `fetchPackageMetadata({ ecosystem, name, fetchFn, timeoutMs })` switches on ecosystem and delegates to the matching helper; unknown ecosystems return `{ status: 'error' }`.
- **Fail-open contract**: every helper wraps all I/O in `try/catch` and returns `{ status: 'error' }` on any network failure, timeout, 4xx/5xx (non-404), or JSON parse error; 404 specifically returns `{ status: 'not_found' }`.
- **Secondary fetches (fail-soft)**: npm downloads (`api.npmjs.org`) and PyPI weekly stats (`pypistats.org`) are each wrapped in their own inner `try/catch`; failure leaves `weeklyDownloads: null` without affecting the primary `status: 'ok'` result.
- **crates.io no weekly granularity**: `weeklyDownloads` is always `null` for the crates ecosystem; the policy layer (spec-05) skips the minimum-downloads rule when this field is `null`.
- **Scoped npm packages**: all URL path segments use `encodeURIComponent`, so `@scope/pkg` becomes `%40scope%2Fpkg` — raw slashes never appear in the URL (research §5 trap 4).

## How to Use

Import the named export and pass ecosystem, package name, an injected fetch function, and a timeout:

```js
import { fetchPackageMetadata } from './registry-clients.mjs'

const result = await fetchPackageMetadata({
  ecosystem: 'npm',       // 'npm' | 'pypi' | 'crates'
  name: 'lodash',
  fetchFn: globalThis.fetch,
  timeoutMs: 250,
})
// result: { status: 'ok', meta: { ageDays, weeklyDownloads, hasHomepage, hasRepository } }
// result: { status: 'not_found' }  — package does not exist (404)
// result: { status: 'error' }      — network/timeout/parse failure (fail-open)
```

The `meta` object is present only when `status === 'ok'`:

| Field | Type | Description |
|---|---|---|
| `ageDays` | `number` | Whole days since first published. Defaults to `0` if timestamp missing. |
| `weeklyDownloads` | `number \| null` | Last-week download count. `null` for crates or if stats fetch fails. |
| `hasHomepage` | `boolean` | Whether the package lists a homepage URL. |
| `hasRepository` | `boolean` | Whether the package lists a source repository URL. |

## Configuration

`timeoutMs` is supplied by the caller (spec-05 reads it from `config.registry.timeoutMs`, defaulting to `250` ms as set by spec-01). No config is imported inside this module.

## Testing

```bash
node --test tests/registry-clients.test.mjs
# 17 tests — npm (8), pypi (4), crates (4), unknown ecosystem (1)

node --test tests/
# Full suite — zero regressions expected
```

All tests use the synchronous `makeStub(routes)` stub factory. No live network calls are made.

## Notes

- **PyPI age**: computed from the earliest `upload_time_iso_8601` across all release files in `pkg.releases`, with a fallback to `pkg.urls` if `releases` is empty.
- **PyPI repository detection**: checks `info.project_urls` for any of `Repository`, `Source`, `Source Code`, `Code`, or `GitHub` keys.
- **Hook wiring not included**: this module is not yet imported by `hook.mjs`; that is spec-06's scope.
- **No cache layer**: caching is spec-04's scope (`registry-cache.mjs`).
- **No policy decisions**: policy evaluation is spec-05's scope (`registry-policy.mjs`).
