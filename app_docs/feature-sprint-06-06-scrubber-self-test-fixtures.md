# Scrubber Self-Test Fixtures

**Task ID:** sprint-06-06
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-06-scrubber-self-test-fixtures.md

## Overview

Wired the `scrubber` bucket into the `--self-test` runner in `src/sentinel/hook.mjs` and supplied eight fixtures under `tests/fixtures/scrubber/` that exercise every major path through `scrubResponse`. Extended `tests/hook.test.mjs` with integration tests verifying end-to-end PostToolUse scrubbing behavior and a self-test assertion requiring `>= 41` total fixtures.

## What Was Built

- `scrubber` bucket dispatch added to the `--self-test` IIFE in `hook.mjs`
- Eight JSON fixture files under `tests/fixtures/scrubber/` covering all major detection families and edge cases
- Two new integration tests in `hook.test.mjs` asserting subprocess-level scrub behavior
- One new self-test assertion verifying the scrubber bucket runs and fixture count reaches `>= 41`
- Updated the existing latency assertion threshold from `>= 33` to `>= 41`

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `'scrubber'` to `fixtureDirs`, inserted `else if (bucket === 'scrubber')` dispatch branch, and fully wired the `PostToolUse` case with `scrubResponse`, per-family audit writes, and fail-open catch
- `tests/hook.test.mjs`: Updated fixture count floor from `>= 33` to `>= 41`; added `--self-test: scrubber bucket present and exits 0` assertion; added two PostToolUse integration tests (S1: Anthropic key scrub, S2: clean text pass-through, S3: disabled-mode pass-through)
- `tests/fixtures/scrubber/anthropic.json`: New fixture
- `tests/fixtures/scrubber/aws-akid.json`: New fixture
- `tests/fixtures/scrubber/github-pat.json`: New fixture
- `tests/fixtures/scrubber/jwt.json`: New fixture
- `tests/fixtures/scrubber/high-entropy.json`: New fixture
- `tests/fixtures/scrubber/multi-family.json`: New fixture
- `tests/fixtures/scrubber/preserve-prose.json`: New fixture
- `tests/fixtures/scrubber/disabled.json`: New fixture

### Key Changes

- **Self-test dispatch branch**: Calls `scrubResponse({ text, config: fixtureConfig })`, derives `rule` from `redactions[0].family` (prefixed with `scrubber.`), and maps the result to the partial-match comparator shape `{ decision, rule, matched }`.
- **Fixture-level config override**: `disabled.json` supplies a top-level `"config"` key read via `fixture.config ?? selfTestConfig`, mirroring the `registry` bucket pattern for per-fixture overrides.
- **First-family rule**: `multi-family.json` relies on `anthropic` being `redactions[0]` because the family scan order in `scrubber-families.mjs` places `anthropic` before `jwt`.
- **`matched: null` invariant**: The comparator branch never populates `matched` with the secret value — it is always `null` in both fixture expects and actual output, enforcing the no-log-secrets guarantee.
- **PostToolUse fail-open**: The `PostToolUse` case wraps the entire scrub pipeline in a `try/catch`; any crash emits an empty `additionalContext` and exits 0, ensuring the scrubber never blocks a tool turn.

## How to Use

1. Run the self-test to verify the scrubber bucket and all 41+ fixtures pass:
   ```bash
   node src/sentinel/hook.mjs --self-test
   ```
   Expected final stderr line: `Sentinel: self-test ok (N fixtures, X.Y ms total)` where `N >= 41`.

2. Run the full test suite:
   ```bash
   node --test tests/
   ```

3. Run the combined validation:
   ```bash
   make validate
   ```

## Configuration

The `disabled.json` fixture demonstrates per-fixture config override — the self-test dispatch reads a top-level `"config"` key from the fixture object:

```json
{
  "config": { "scrubber": { "enabled": false } }
}
```

When `scrubber.enabled` is `false` in the live config, `PostToolUse` emits an empty `additionalContext` and exits without calling `scrubResponse`.

## Testing

All three commands must exit 0:

```bash
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
```

The `hook.test.mjs` integration tests use `CLAUDE_PLUGIN_DATA` pointing to a temp directory and verify:
- Redacted text contains `<REDACTED:<family>>`, not the raw secret
- Audit JSONL has exactly one `event: 'scrub'` line per redaction with correct `rule`, `decision`, and `input_summary`
- The raw secret never appears anywhere in the audit file
- Clean text passes through verbatim with zero scrub audit lines
- Disabled mode produces no redactions and no scrub audit lines

## Notes

- The `high-entropy.json` fixture string (`xK9mZ3qR7vL2nP8wT5yB4cF6jH0dA1sE+Q/uIoWgXeYaNbVhMlDr`) was selected to satisfy all three entropy scanner preconditions: `>= 24` contiguous non-whitespace chars, Shannon entropy `> 4.5` bits, and no match against any named family regex.
- The scrubber bucket is the fourth bucket in `fixtureDirs` (`['paths', 'bash', 'registry', 'scrubber']`). Adding a fifth bucket in a future sprint requires only appending to this array and adding an `else if` branch in the dispatch switch.
- The `matched` field is always `null` in both the `scrubResponse` return and the fixture expects — this is a deliberate design invariant, not an oversight. The per-family `redactions` array carries count metadata; the actual matched string is never surfaced.
