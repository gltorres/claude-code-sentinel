# Scrubber Entropy — Shannon Entropy Scanner

**Task ID:** sprint-06-03
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-03-scrubber-entropy.md

## Overview

This spec delivers `src/sentinel/scrubber-entropy.mjs`, the second pass in the Sprint 06 output-scrubber pipeline. It exports two pure functions — `shannonEntropy(str)` and `scrubEntropy(text)` — that catch high-entropy credential-shaped strings not matched by any known family prefix. The module has zero imports and zero I/O: all computation is in-process over character-frequency distributions.

## What Was Built

- `src/sentinel/scrubber-entropy.mjs` — exports `shannonEntropy` and `scrubEntropy`; zero `import` statements; 47 LOC
- `tests/scrubber-entropy.test.mjs` — `node:test` suite with 8 `test()` blocks covering zero-entropy, uniform-distribution, threshold boundary, tag exclusion, mixed-prose, and run-length guard cases

## Technical Implementation

### Files Modified

- `src/sentinel/scrubber-entropy.mjs` (new): Shannon entropy helper + run scanner; pure ESM, no imports
- `tests/scrubber-entropy.test.mjs` (new): in-process unit tests using direct function calls

### Key Changes

- **`shannonEntropy(str)` — character-frequency entropy:** builds a `Map` of character counts in one `for...of` pass (Unicode-safe), then sums `-p * Math.log2(p)` over all unique characters. Empty string returns `0` to avoid divide-by-zero. Complexity is O(n + k) where k ≤ number of distinct characters (≤ 95 for printable ASCII).

- **`scrubEntropy(text)` — O(n) run scanner:** uses a single `String.prototype.replace(/\S{24,}/g, callback)` pass. For each matched run the callback:
  1. Checks `REDACTED_TAG_RE` (`/^<REDACTED:[a-z_]+>$/`) to skip runs that are already family-scanner tags.
  2. Calls `shannonEntropy(run)`.
  3. If entropy > 4.5 bits, increments a counter and returns `'<REDACTED:high_entropy>'`.
  4. Otherwise returns the run unchanged.
  Returns `{ text: string, count: number }`.

- **Minimum run length is 24 characters:** runs shorter than 24 chars are never inspected regardless of their entropy value. This prevents false positives on short capitalized words or hex color codes.

- **Threshold is strict `> 4.5`:** runs with entropy exactly 4.5 are preserved. `Math.log2` is a built-in global in Node ≥ 20.10; no import is required.

- **Anchored guard regex prevents double-replacement:** `REDACTED_TAG_RE` is anchored (`^...$`). Because `RUN_RE` splits on whitespace, a standalone `<REDACTED:anthropic>` becomes an entire run that the anchor check consumes exactly — no substring false-negatives.

### Pipeline Position

`scrubEntropy` operates on **post-family text**. The policy layer (`scrubber-policy.mjs`, spec 4) calls `scrubFamilies` first, then passes its output to `scrubEntropy`. By the time the entropy scanner sees the text, known credential shapes are already replaced with `<REDACTED:*>` tags — the tag-exclusion guard prevents them from being scanned again.

## How to Use

`scrubEntropy` is a pure function — import and call directly:

```js
import { scrubEntropy, shannonEntropy } from './scrubber-entropy.mjs'

// Entropy check on a single string
const bits = shannonEntropy('A3bC9dEfGhIjKlMnOpQrStUvWxYz0123') // > 4.5

// Run scanner on post-family text
const { text, count } = scrubEntropy(postFamilyText)
// text:  scrubbed string with <REDACTED:high_entropy> tags
// count: number of runs replaced
```

In practice callers never invoke `scrubEntropy` directly — routing always goes through `scrubResponse` in `scrubber-policy.mjs`.

## Configuration

The entropy module reads no configuration. Threshold (4.5 bits) and minimum run length (24 chars) are compile-time constants. The `scrubber.enabled` guard and `extraPatterns` are the policy layer's responsibility (spec 4). See `feature-sprint-06-01-scrubber-config-defaults.md`.

## Testing

```bash
# Entropy-specific unit tests (8 test blocks)
node --test tests/scrubber-entropy.test.mjs

# Full suite — zero regressions
node --test tests/

# Full validation
make validate
```

## Notes

- **Character vs byte entropy:** research spec says "character-frequency distribution." For the ASCII-dominated content from `Bash|Read|Grep|Glob` tool responses, character and byte counts are identical. `for...of` (Unicode code points) is strictly correct and simpler than converting to a `Buffer`.
- **`count` semantics:** equals the number of replaced runs, not the number of unique secrets. Two distinct high-entropy runs in one call produce `count: 2`. This matches the audit shape expected by `audit.mjs` (`scrub_count` = replacements per pass).
- **`scrubEntropy` does not coerce its input:** the caller (`scrubResponse`, spec 4) is responsible for `String(text ?? '')` before passing the value in. This matches the contract in `bash-policy.mjs`.
- This module is the second pass in the pipeline. The first pass (family regex scanning, `scrubFamilies`) is in `scrubber-families.mjs` (spec 2). The `scrubResponse` composer (spec 4) chains both passes and produces the final `{ redacted, redactions, decision }` result.
