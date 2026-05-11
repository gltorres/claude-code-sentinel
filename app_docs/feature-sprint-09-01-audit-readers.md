# Audit Readers: `tailAuditEntries`, `findAuditEntryById`, `summariseByEventClass`

**Task ID:** sprint-09-01
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-01-audit-readers.md

## Overview

Extends `src/sentinel/audit.mjs` with three read-only exports that power the `/sentinel-review` slash command's `recent`, `investigate`, and `summary` sub-commands. Prior to this sprint, `audit.mjs` was write-only; these helpers enable reading records back without touching the writer code or the 12-field JSONL schema.

## What Was Built

- `tailAuditEntries({ config, n, paths })` — reverse-chunk scan returning up to `n` records newest-first, spanning both `audit.jsonl` and the rotated `audit.jsonl.1`
- `findAuditEntryById({ config, id, paths })` — forward scan with short-circuit returning a single record by 26-char ULID, or `null` on miss
- `summariseByEventClass({ config, sinceMs, paths })` — forward scan returning `{ block, ask, scrub, warn, total }` counts for records within a time window
- Private `listAuditPaths(config)` helper that auto-discovers `[primary, primary+'.1']` filtered by `existsSync`
- Five new unit test cases covering empty file, single entry, rotation boundary, by-id hit/miss, and time-window cutoff

## Technical Implementation

### Files Modified

- `src/sentinel/audit.mjs`: Extended `node:fs` import; added `listAuditPaths` private helper and three exported read functions (+159 lines)
- `tests/audit.test.mjs`: Extended import line; appended five new `test()` blocks (+139 lines)

### Key Changes

- **Extended `node:fs` import** at `audit.mjs:1` to add `openSync`, `readSync`, `closeSync`, `readFileSync`, `existsSync` alongside the existing four writer symbols.
- **`tailAuditEntries`** uses an 8 KiB reverse-chunk-carry scan (same pattern as `session.mjs:36–96`), iterating files in newest-first order and breaking as soon as `results.length >= n` to avoid reading stale data unnecessarily.
- **`findAuditEntryById`** uses `readFileSync` per file (acceptable under the 10 MiB `maxSizeMb` cap) with forward iteration and immediate return on match; skips `audit.jsonl.1` entirely when the ID is found in the primary file.
- **`summariseByEventClass`** reads both files in full, skips records where `Date.parse(record.ts) < sinceMs`, and accumulates counts only for the four known event classes (`block`, `ask`, `scrub`, `warn`).
- **`paths` injection pattern** — all three helpers accept an explicit `paths` array for test isolation, bypassing `listAuditPaths`. When omitted, `listAuditPaths` derives the live path via `resolveAuditPath`.

## How to Use

### `tailAuditEntries` — fetch the N most recent records

```js
import { tailAuditEntries } from './src/sentinel/audit.mjs'

const records = tailAuditEntries({ config, n: 20 })
// returns: Array of up to 20 parsed record objects, newest first
```

### `findAuditEntryById` — look up a record by ULID

```js
import { findAuditEntryById } from './src/sentinel/audit.mjs'

const record = findAuditEntryById({ config, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
// returns: matching record object, or null
```

### `summariseByEventClass` — aggregate counts over a time window

```js
import { summariseByEventClass } from './src/sentinel/audit.mjs'

const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
const summary = summariseByEventClass({ config, sinceMs: Date.now() - sevenDaysMs })
// returns: { block: N, ask: N, scrub: N, warn: N, total: N }
```

### Injecting explicit paths (for tests or CLI callers)

All three helpers accept a `paths` array to bypass auto-discovery:

```js
tailAuditEntries({ config, n: 5, paths: ['/tmp/my-audit.jsonl'] })
findAuditEntryById({ config, id: '...', paths: ['/tmp/my-audit.jsonl'] })
summariseByEventClass({ config, sinceMs: 0, paths: ['/tmp/my-audit.jsonl'] })
```

## Configuration

No new config keys. The helpers reuse the existing `config.audit.path` (via `resolveAuditPath`) and the rotation behaviour governed by `config.audit.maxSizeMb` (default 10 MiB). The rotated file is always `<primary>.1`.

## Testing

```bash
node --test tests/audit.test.mjs   # all 15 tests (10 existing + 5 new)
node --test tests/                 # full suite regression check
make validate
node src/sentinel/hook.mjs --self-test
```

The five new test cases in `tests/audit.test.mjs`:

| Test | Helper | Scenario |
|---|---|---|
| `tailAuditEntries returns empty array for empty audit file` | `tailAuditEntries` | Empty file → `[]` |
| `tailAuditEntries returns a single entry from a one-line file` | `tailAuditEntries` | One record → `[record]`, newest-first |
| `tailAuditEntries spans primary and rotated file to reach n results` | `tailAuditEntries` | n=3, 1 in primary + 2 in `.1` → 3 results |
| `findAuditEntryById returns matching record on hit, null on miss` | `findAuditEntryById` | Known id → record; unknown id → null |
| `summariseByEventClass counts only records within the sinceMs window` | `summariseByEventClass` | 1 inside + 1 outside → `{ block:1, ask:0, scrub:0, warn:0, total:1 }` |

## Notes

- **No circular import.** `session.mjs` already imports `resolveAuditPath` from `audit.mjs`. Adding any import from `session.mjs` into `audit.mjs` would create an ESM cycle with undefined bindings. `listAuditPaths` re-implements the two-element path derivation without importing `session.mjs`.
- **`readFileSync` vs chunked for by-id and aggregate.** `tailAuditEntries` needs early-exit and random-access, so it uses the 8 KiB chunk pattern. `findAuditEntryById` and `summariseByEventClass` must read the full file anyway, so `readFileSync` is simpler and correct under the 10 MiB cap.
- **ULID fixture.** Tests use `'01ARZ3NDEKTSV4RRFFQ69G5FAV'` — the canonical example from the ULID spec, matching `/^[0-9A-HJKMNP-TV-Z]{26}$/` (Crockford alphabet, excluding I L O U).
- **Writer schema unchanged.** The `EXPECTED_KEYS` assertion at `tests/audit.test.mjs:15–18` and all existing 10 tests are untouched.
