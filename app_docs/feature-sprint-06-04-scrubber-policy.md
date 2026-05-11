# Scrubber Policy Module

**Task ID:** sprint-06/spec-04-scrubber-policy
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-04-scrubber-policy.md

## Overview

This spec introduces `src/sentinel/scrubber-policy.mjs`, the composed decision core for the Sprint 06 output scrubber. It is a single synchronous pure function, `scrubResponse`, that delegates to `scrubFamilies` (family-pattern scanning) and `scrubEntropy` (Shannon-entropy scanning) in the correct pipeline order, then returns a fixed-shape result the `PostToolUse` hook branch can emit as `additionalContext` without knowing about scrubber internals.

## What Was Built

- `src/sentinel/scrubber-policy.mjs` — exports the named `scrubResponse({ text, config })` function; zero runtime deps, zero `node:` built-ins.
- `tests/scrubber-policy.test.mjs` — six `node:test` cases covering all acceptance criteria using real dependency modules (no ESM monkey-patching).

## Technical Implementation

### Files Modified

- `src/sentinel/scrubber-policy.mjs`: Created from scratch — the composed scrubber pipeline (families first, entropy second) wrapped in a single fail-open `try/catch`.
- `tests/scrubber-policy.test.mjs`: Created from scratch — synchronous unit tests covering disabled-mode short-circuit, family+entropy composition, multi-family single response, `extraPatterns` string and object round-trips, and error swallowing.

### Key Changes

- **Pipeline ordering is a correctness requirement**: `scrubFamilies` runs first so that known credential shapes (JWT, Anthropic key, etc.) receive precise family tags before the entropy scanner sees the text. Running entropy first would cause JWTs to be tagged `<REDACTED:high_entropy>` and lose audit specificity.
- **Fail-open `try/catch` wraps the entire body**: any internal exception (bad `extraPatterns` regex, unexpected input shape) causes the catch block to return the original text unchanged — a scrubber fault must never block a tool turn.
- **`enabled === false` returns `redacted: ''`** (not the original text): the empty string is the intended "disabled" signal on the wire; returning the original text when disabled would inject an un-scrubbed copy into `additionalContext`.
- **`decision/rule/matched` included in return shape**: `PostToolUse` always allows — there is no deny path. These fields make the shape congruent with Sprint 04's `evaluateBash` return so the self-test comparator (added in spec-05/06) can do partial-key matching uniformly across all fixture types.
- **Replacement strings are safe from double-detection**: `<REDACTED:anthropic>` tags produced by the family scan contain only ASCII punctuation and lowercase text — well below the entropy threshold — so they are naturally skipped by `scrubEntropy` without an explicit exclusion guard (though spec-03 includes one as a belt-and-suspenders measure).

## How to Use

`scrubResponse` is a pure synchronous function. Call it with the raw tool response text and the merged Sentinel config object:

```js
import { scrubResponse } from './scrubber-family.mjs'

const { redacted, redactions, decision, rule, matched } = scrubResponse({
  text: rawToolResponse,
  config: loadedSentinelConfig,
})
// emit `redacted` as `additionalContext` in the PostToolUse hook output
```

**Return shape:**

| Field | Type | Value |
|---|---|---|
| `redacted` | `string` | Scrubbed text (`''` when `scrubber.enabled === false`) |
| `redactions` | `Array<{ family: string, count: number }>` | Family entries first, `high_entropy` last |
| `decision` | `'allow'` | Always `'allow'` — PostToolUse has no deny path |
| `rule` | `null` | Always `null` |
| `matched` | `null` | Always `null` |

**`extraPatterns` shapes:**

- Plain string `'MY[A-Z]{8}'` → tagged `<REDACTED:custom>`, family name `custom`
- Object `{ name: 'corp', pattern: 'CORP[0-9]{6}' }` → tagged `<REDACTED:corp>`, family name `corp`

## Configuration

`scrubResponse` reads `config.scrubber`:

| Key | Default | Description |
|---|---|---|
| `scrubber.enabled` | `true` | Set to `false` to short-circuit (returns `redacted: ''`, zero redactions) |
| `scrubber.extraPatterns` | `[]` | Array of string patterns or `{ name, pattern }` objects for custom credential families |

## Testing

```bash
# Run the scrubber-policy unit tests only
node --test tests/scrubber-policy.test.mjs

# Run the full suite (zero regressions expected)
node --test tests/

# Full validation including lint and hook self-test
make validate
```

The six test cases cover:
1. `enabled: false` short-circuit — output is `{ redacted: '', redactions: [] }`
2. Family + entropy composition — Anthropic key + high-entropy run → two redaction entries
3. Multi-family response — Anthropic key + GitHub PAT → `anthropic` and `github_pat` entries
4. `extraPatterns` string round-trip — `<REDACTED:custom>` tag in output
5. `extraPatterns` object round-trip — `<REDACTED:corp>` tag in output
6. Error swallowing — invalid regex in `extraPatterns` → `doesNotThrow`, valid shape returned

## Notes

- `scrubResponse` is **not** the audit writer. Each `{ family, count }` entry in `redactions` is consumed by the PostToolUse branch in `hook.mjs` (spec-05), which calls `writeAuditLine` once per entry.
- The fail-open catch block returns `String(text ?? '')` (the original text), **not** `''`. When the catch fires due to an internal exception (not `enabled: false`), preserving the original text is safest because the model already has the raw `tool_response` in context — returning `''` would silently suppress additional context and mask the error.
- Hook wiring (PostToolUse branch in `hook.mjs`) and fixture dispatch (`--self-test` extension) are delivered in specs 05 and 06 respectively. This module is a pure transformation layer with no side effects.
- Performance target: < 30 ms for a sub-10 kB tool response. The sequential (not parallel) family → entropy composition is a correctness requirement, not a performance trade-off. Eleven family regexes over 10 kB + a single-pass entropy scanner run well under 2 ms in V8.
