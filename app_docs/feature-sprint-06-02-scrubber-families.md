# Scrubber Families — Credential Family Regex Registry

**Task ID:** sprint-06-02
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-02-scrubber-families.md

## Overview

This spec delivers `src/sentinel/scrubber-families.mjs`, the first of two passes in the Sprint 06 output-scrubber pipeline. It exports a single pure function `scrubFamilies(text, extraPatterns)` that applies 11 hardcoded credential-family regexes in fixed order, replacing known secret shapes with `<REDACTED:<family>>` tags and returning a redaction inventory for audit. The function is stateless and has zero I/O — callers supply the already-parsed `extraPatterns` array from config.

## What Was Built

- `src/sentinel/scrubber-families.mjs` — exports `scrubFamilies(text, extraPatterns)` with a frozen `FAMILY_REGEXES` array of 11 pre-compiled entries
- `tests/scrubber-families.test.mjs` — `node:test` suite with `describe/it` blocks: 22 positive/negative cases (2 per family) plus count accuracy, prose preservation, and `extraPatterns` round-trips

## Technical Implementation

### Files Modified

- `src/sentinel/scrubber-families.mjs` (new): pure credential-family regex engine; 148 lines

### New Files

- `src/sentinel/scrubber-families.mjs`: family regex engine
- `tests/scrubber-families.test.mjs`: unit test suite (311 lines)

### Key Changes

- **11 hardcoded families in fixed order:** `anthropic → openai → github_pat → aws_akid → aws_session → slack → stripe_live → sendgrid → atlassian → langsmith → jwt`. Order is load-bearing: `anthropic` fires before `openai` so the OpenAI negative lookahead (`sk-(?!ant-)`) never sees Anthropic tokens.

- **Tag format:** every match is replaced with `<REDACTED:<family>>` — no length suffix, no preview (brief line 50). The returned `redactions` array contains only families with `count >= 1`.

- **`aws_session` special handling:** the key name is preserved and only the value is redacted — `aws_session_token=<value>` becomes `aws_session_token=<REDACTED:aws_session>`. Uses `/gi` to cover `AWS_SESSION_TOKEN=` (uppercase) and mixed-case variants.

- **`extraPatterns` two-shape API:**
  - `string` → compiled as regex source, tagged `<REDACTED:custom>`
  - `{ name, pattern }` → tagged `<REDACTED:<name>>`
  - Malformed regex sources and incomplete objects are silently skipped — no throw, text unchanged.

- **O(n) performance:** each of the 11 family passes uses `.replace(/regex/g, callback)`. All `RegExp` objects are pre-compiled at module load time in the frozen `FAMILY_REGEXES` array; `re.lastIndex = 0` is reset before each call to guard against state leakage across invocations.

### Family Regex Table

| Family | Pattern prefix | Tag |
|---|---|---|
| `anthropic` | `sk-ant-` + 32+ alnum | `<REDACTED:anthropic>` |
| `openai` | `sk-` (non-ant) + 40+ alnum | `<REDACTED:openai>` |
| `github_pat` | `ghp_\|gho_\|ghu_\|ghs_\|ghr_` + 36+ alnum | `<REDACTED:github_pat>` |
| `aws_akid` | `AKIA` + 16 uppercase alnum | `<REDACTED:aws_akid>` |
| `aws_session` | `aws_session_token=<value>` (value only) | `<REDACTED:aws_session>` |
| `slack` | `xox[abprs]-` + 10+ alnum-dash | `<REDACTED:slack>` |
| `stripe_live` | `sk_live_` + 24+ alnum | `<REDACTED:stripe_live>` |
| `sendgrid` | `SG.` + 22 chars + `.` + 43 chars | `<REDACTED:sendgrid>` |
| `atlassian` | `ATATT3` + 180+ alnum-dash-underscore | `<REDACTED:atlassian>` |
| `langsmith` | `lsv2_pt_` + 32+ alnum | `<REDACTED:langsmith>` |
| `jwt` | `eyJ…eyJ…sig` three-part structure | `<REDACTED:jwt>` |

## How to Use

`scrubFamilies` is a pure function — import and call directly:

```js
import { scrubFamilies } from './scrubber-families.mjs'

const { text, redactions } = scrubFamilies(rawToolOutput, config.scrubber.extraPatterns)
// text: scrubbed string with <REDACTED:*> tags
// redactions: [{ family: 'anthropic', count: 1 }, ...]
```

Supply `extraPatterns` as an array of strings or `{name, pattern}` objects to catch project-specific secret shapes alongside the 11 built-ins.

## Configuration

`scrubFamilies` itself has no configuration — it is a stateless pure function. The caller (spec 4, `scrubResponse`) reads `config.scrubber.extraPatterns` and passes it in. See `feature-sprint-06-01-scrubber-config-defaults.md` for the config layer.

## Testing

```bash
# Family-specific unit tests (22 positive/negative + edge cases)
node --test tests/scrubber-families.test.mjs

# Full suite — zero regressions
node --test tests/

# Full validation
make validate
```

## Notes

- **`SK_ANT_RE` in `bash-policy.mjs:5` is a separate surface** and must not be refactored. It uses `[REDACTED]` (no family tag) for audit-prefix sanitisation; this module uses `<REDACTED:<family>>` for next-turn `additionalContext`. The two redaction surfaces are intentionally independent.
- **`count` semantics:** equals the number of replacements, not the number of unique secrets. Two occurrences of the same token in one response produce `count: 2`.
- **`re.lastIndex = 0`** is set before each `.replace()` call as a defensive guard. While `.replace()` internally resets `lastIndex`, the explicit reset protects against future refactors that switch to a manual `.exec()` loop.
- This module is the first pass in the pipeline. The second pass (Shannon entropy scanning, `scrubEntropy`) is implemented in `scrubber-entropy.mjs` (spec 3). The `scrubResponse` composer (spec 4) chains both passes and produces the final result.
