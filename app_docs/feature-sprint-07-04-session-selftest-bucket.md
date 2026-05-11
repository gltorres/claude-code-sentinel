# Session Self-Test Bucket

**Task ID:** sprint-07-session-banners/spec-04-session-selftest-bucket
**Date:** 2026-05-10
**Specification:** specs/sprint-07-session-banners/spec-04-session-selftest-bucket.md

## Overview

Adds a `'session'` bucket to the `--self-test` runner in `src/sentinel/hook.mjs`, bringing session banner generation under the same in-process smoke-test coverage as `paths`, `bash`, `registry`, and `scrubber`. The bucket materialises fixture `audit_lines` into a temp JSONL file, calls `summariseAuditWindow` + `composeBanner` from `session.mjs`, and exposes the resulting banner string to a new `banner_includes` substring comparator. Two JSON fixtures cover the empty-log and mixed-event paths; the fixture-count floor in `tests/hook.test.mjs` rises from 41 to 43.

## What Was Built

- `'session'` appended to `fixtureDirs` in the self-test IIFE — the runner now iterates five buckets
- `else if (bucket === 'session')` dispatch branch in `hook.mjs` — materialises `fixture.audit_lines` to a temp `audit.jsonl`, calls `summariseAuditWindow` + `composeBanner`, assigns `actual = { banner }`
- `banner_includes` special-case in the shared comparator — performs `actual.banner.includes(value)` substring match instead of strict equality
- `tests/fixtures/session/empty.json` — verifies the empty-log fallback path (`"no events yet"` in banner)
- `tests/fixtures/session/mixed.json` — verifies 7-day windowing: 1 in-window block + 1 in-window scrub counted, 9-day-old block excluded; `now` pinned to `1700000000000` for determinism
- Fixture-count floor bumped from `>= 41` to `>= 43` in two assertions in `tests/hook.test.mjs`

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Extended `node:fs` imports (`mkdtempSync`, `writeFileSync`, `rmSync`), `node:os` imports (`tmpdir`); added `session.mjs` import; added `'session'` to `fixtureDirs`; added session dispatch branch and `banner_includes` comparator extension
- `tests/hook.test.mjs`: Bumped fixture-count floor from `>= 41` to `>= 43` in two assertions (line 299 and line 314)

### New Files

- `tests/fixtures/session/empty.json`: No `audit_lines` → reader returns `hasAny: false` → banner contains `"no events yet"`
- `tests/fixtures/session/mixed.json`: Three audit lines with `now: 1700000000000`; 7-day cutoff (`1699395200000`) excludes the 9-day-old block; banner contains `"1 block"`

### Key Changes

- **Temp-file materialisation.** The session branch writes `fixture.audit_lines` (or an empty string) to `mkdtempSync(tmpdir() + '/sentinel-selftest-')`. A `finally` block calls `rmSync(tmpDir, { recursive: true, force: true })` to guarantee cleanup even if `summariseAuditWindow` or `composeBanner` throws.
- **Config override.** A shallow-merged `fixtureConfig` object overrides `audit.path` to point at the temp file, leaving all other config keys from `fixture.config ?? selfTestConfig` intact.
- **`banner_includes` comparator.** The `every` callback checks `k === 'banner_includes'` before the generic equality path. If absent from `fixture.expect`, the behaviour is identical to existing buckets. If present, it performs `typeof actual.banner === 'string' && actual.banner.includes(fixtureExpect[k])`.
- **Deterministic timestamps.** `mixed.json` supplies `"now": 1700000000000` (`2023-11-14T22:13:20.000Z`). The 7-day window cuts at `1699395200000`; the third entry (`2023-11-05`) falls outside and is excluded by `summariseAuditWindow`.
- **Latency budget preserved.** Temp-file creation and a single reverse-chunk scan of a 3-line file is sub-millisecond; the per-fixture `< 20 ms` assertion remains comfortable.

## How to Use

The session bucket runs automatically as part of the existing self-test command:

```bash
node src/sentinel/hook.mjs --self-test
```

Expected output on success:
```
Sentinel: self-test ok (N fixtures, X.Y ms total)
```
where `N >= 43`.

To run the full test suite including the updated fixture-count assertion:
```bash
make validate
node --test tests/
```

## Configuration

No new config keys. The session bucket reads `config.audit.path` (overridden per-fixture) and respects the 7-day window hardcoded in `summariseAuditWindow`. Fixture-level overrides follow the same `fixture.config` merge pattern used by the scrubber bucket.

## Testing

1. **Self-test smoke** — `node src/sentinel/hook.mjs --self-test` exits 0 with `N >= 43` in the final stderr line.
2. **empty.json path** — verifies `composeBanner` emits the `"no events yet"` fallback when the audit log is absent or empty.
3. **mixed.json path** — verifies 7-day windowing excludes the 9-day-old block entry and the banner contains `"1 block"`.
4. **Latency assertion** — `tests/hook.test.mjs:290-305` enforces `totalMs / fixtureCount < 20 ms`; still passes.
5. **Count assertion** — `tests/hook.test.mjs:299` and `:314` pass with the updated `>= 43` threshold.
6. **Regression check** — all 41 existing fixtures (`paths`, `bash`, `registry`, `scrubber`) continue to pass; the `banner_includes` comparator extension is guarded by a key-name check and has no effect on existing `decision`, `rule`, or `matched` key comparisons.

## Notes

- `mixed.json` stores entries in reverse-chronological order (newest first) to reflect the order `writeAuditLine` appends and the reader's backward-scan traversal.
- The `banner_includes` key uses substring matching rather than full equality because `composeBanner` may produce different phrasing in future versions; substring checks make fixtures resilient to minor wording changes.
- `BANNER_PREFIX` (`'Sentinel: '`) is used in self-test failure messages but is not part of the banner string itself; the banner produced by `composeBanner` starts with `"Sentinel active — …"`.
- The session bucket depends on `src/sentinel/session.mjs` being present (delivered by Spec 01). Building this spec before Spec 01 causes an import error for `summariseAuditWindow` and `composeBanner`.
