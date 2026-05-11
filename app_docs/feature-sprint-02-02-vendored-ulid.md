# Vendored ULID Generator

**Task ID:** sprint-02-02
**Date:** 2026-05-10
**Specification:** specs/sprint-02-config-and-audit/spec-02-vendored-ulid.md

## Overview

A minimal ULID (Universally Unique Lexicographically Sortable Identifier) generator was vendored into `src/sentinel/ulid.mjs` with zero runtime dependencies. The module exports `ulid()` — returning a 26-character Crockford-base32 string — and `_resetMonotonicState()` for deterministic test teardown. It is consumed by the audit writer (`src/sentinel/audit.mjs`) to stamp every audit log line with a sortable, monotonic ID.

## What Was Built

- `src/sentinel/ulid.mjs` — self-contained ESM module with no npm dependencies; imports only `node:crypto`
- `tests/ulid.test.mjs` — four-test suite covering alphabet validity, 1000-call monotonicity, same-ms prefix sharing, and timestamp round-trip accuracy
- Monotonic increment logic guaranteeing strict lexicographic ordering even within the same millisecond

## Technical Implementation

### Files Modified

- `src/sentinel/ulid.mjs` (new): Vendored ULID generator — 66 lines, no runtime deps
- `tests/ulid.test.mjs` (new): `node:test` suite with four flat `test()` calls

### Key Changes

- **Crockford base32 encoding**: The `ENCODING` constant holds the 32-character alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which excludes I, L, O, and U to eliminate visual ambiguity. `encodeTime(ms, 10)` encodes a 48-bit millisecond timestamp into the first 10 characters; `encodeRandom(bytes)` uses BigInt arithmetic to encode 10 random bytes into the last 16 characters.
- **Monotonic increment**: Module-private `lastMs` and `lastRandom` track state across calls. When `Date.now()` returns the same millisecond as the previous call, `incrementRandom(bytes)` adds 1 to the 10-byte buffer as a big-endian 80-bit integer (carry propagates left), guaranteeing strict ordering without re-seeding randomness.
- **Fresh seed on new millisecond**: When `Date.now()` advances, `crypto.randomBytes(10)` seeds a fresh `lastRandom`. The hot path (same-ms increment) touches only a 10-byte loop — nanosecond range with no I/O.
- **Test isolation escape hatch**: `_resetMonotonicState()` resets `lastMs = -1` and `lastRandom = null`, enabling each test to start from a known state without cross-test contamination from module-level singleton state.
- **`Date.now` monkey-patch pattern**: The same-ms test forces a fixed timestamp via `Date.now = () => fixedMs` inside a `try/finally` that always restores the original, making the monotonic-increment branch fully deterministic.

## How to Use

```js
import { ulid } from './ulid.mjs'

const id = ulid()
// e.g. "01HTQK8Z7V3JPNQ4XBSD5M6C2W"
// First 10 chars: timestamp prefix (lexicographically sortable by time)
// Last 16 chars: random tail (monotonically incremented within same ms)
```

For test files only:

```js
import { ulid, _resetMonotonicState } from '../src/sentinel/ulid.mjs'

// Call at the start of each test that relies on known monotonic state:
_resetMonotonicState()
const id = ulid()
```

## Configuration

No configuration. The module reads `Date.now()` directly and accepts no options. Zero entries in `config/defaults.json` relate to ULID generation — the ID format is fixed by the ULID specification.

## Testing

```bash
node --test tests/ulid.test.mjs   # 4 pass / 0 fail
node --test tests/               # all suites including ulid
make validate                    # full pipeline: manifest, hook config, self-test, node --test
```

The four tests cover:

| Test | What it asserts |
| --- | --- |
| 26-char Crockford alphabet | Output matches `/^[0-9A-HJKMNP-TV-Z]{26}$/` |
| 1000-call strict monotonicity | Every consecutive pair satisfies `ids[i] > ids[i-1]` |
| Same-ms prefix sharing | Mocked `Date.now` forces identical timestamp prefix; second ULID > first |
| Timestamp round-trip | First 10 chars decode to within 5 ms of wall-clock time |

## Notes

- `_resetMonotonicState()` is for tests only. Production callers (`audit.mjs`) must never call it; the leading underscore signals this convention.
- BigInt arithmetic in `encodeRandom` is required to avoid 53-bit float precision loss on the 80-bit random value. Node >= 20.10 (required by `package.json`) guarantees BigInt availability.
- The ULID spec excludes I, L, O, U from the alphabet. The regex `/^[0-9A-HJKMNP-TV-Z]{26}$/` encodes this: `A-H` (skips I), `J` then `KMN` (skips L), `P-T` (skips O), `V-Z` (skips U).
- `src/sentinel/hook.mjs` is not modified by this spec; wiring `ulid.mjs` into the hook pipeline is deferred to Spec 4.
