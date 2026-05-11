# Levenshtein Helper

**Task ID:** sprint-08-spec-01
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-01-levenshtein-helper.md

## Overview

Adds `src/sentinel/levenshtein.mjs`, a pure zero-dependency utility that computes Levenshtein edit distance between two strings and finds the closest match in a caller-supplied list. This module is used by the Sprint 08 forensic investigator agent to detect typosquatted package names by comparing an install target against the bundled top-500 popular-package lists.

## What Was Built

- `src/sentinel/levenshtein.mjs` — exports `levenshtein(a, b)` and `nearestPopular(name, list)` as named ESM exports
- `tests/levenshtein.test.mjs` — 14 `node:test` flat-style test cases covering all edge cases and acceptance criteria

## Technical Implementation

### Files Modified

- `src/sentinel/levenshtein.mjs`: New module — two-row dynamic-programming Levenshtein, O(min(|a|,|b|)) space
- `tests/levenshtein.test.mjs`: New test file — flat `import { test }` style, synchronous, no I/O

### Key Changes

- **`levenshtein(a, b)`** — standard (not Damerau-Levenshtein) two-row DP. Early exits for identical strings and empty inputs. A character swap costs 2 (two substitutions), not 1.
- **`nearestPopular(name, list)`** — iterates a caller-supplied array, returns `{ name, distance }` for the minimum-distance entry. Ties broken by array order. Returns `{ name: null, distance: Infinity }` for an empty list so callers can apply `distance <= 2` without special-casing.
- **Standard vs DL distance** — the spec's research notes referenced a `lodash`/`lodahs` distance of 1 (Damerau-Levenshtein) but the implementation uses standard Levenshtein (distance 2 for that pair). The `reqeusts`→`requests` case yields distance 2 under standard Levenshtein; the investigator agent applies the ≤ 2 threshold, so the typosquat detection still fires. Tests document the standard-Levenshtein costs with explicit comments.
- **Zero runtime dependencies** — no `node:` built-ins or npm packages imported; the module is self-contained ~55 LOC.
- **Auto-discovered by test runner** — the existing `node --test tests/*.mjs` glob picks up the new test file; no Makefile or `package.json` changes required.

## How to Use

```js
import { levenshtein, nearestPopular } from './src/sentinel/levenshtein.mjs'

// Edit distance between two strings
levenshtein('reqeusts', 'requests')  // → 2
levenshtein('lodash', 'lodash')      // → 0
levenshtein('', 'abc')               // → 3

// Find nearest match in a list
nearestPopular('reqeusts', ['requests', 'flask'])
// → { name: 'requests', distance: 2 }

nearestPopular('anything', [])
// → { name: null, distance: Infinity }
```

The `nearestPopular` caller is responsible for normalising input (e.g. lowercasing) and for interpreting the distance threshold. The investigator agent (spec-05) applies `distance <= 2` to flag potential typosquats; the ≤ 2 threshold is not encoded in this module.

## Configuration

None. This module has no config keys, no hook wiring, and no dependency on `config/defaults.json`. The top-500 package lists (spec-03) are passed in as a caller-supplied array at invocation time.

## Testing

```bash
node --test tests/levenshtein.test.mjs   # run spec-01 tests only
node --test tests/                        # full suite, zero regressions expected
make validate                             # lint + full test suite
```

The 14 test cases cover: identical strings, empty-string left/right, single substitution, adjacent-swap (cost 2), full-mismatch same length, insertion, `nearestPopular` exact match, `nearestPopular` picks closest, empty-list guard, and tie-breaking by array order.

## Notes

- **Damerau-Levenshtein not implemented.** A transposition (two adjacent chars swapped) costs 2 under standard Levenshtein. If a future spec requires single-operation transpositions (DL distance), the module can be upgraded without breaking spec-01 acceptance criteria, since the typosquat threshold (`<= 2`) remains valid for both metrics.
- **`nearestPopular` does not normalise input.** Lowercasing, deduplication, and list loading are the caller's responsibility. The investigator agent (spec-05) handles normalisation before calling.
- **Top-500 data deferred.** The JSON seed files (`src/sentinel/data/top_packages_*.json`) are created in spec-03. This module has no dependency on those files.
