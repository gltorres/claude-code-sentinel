# Scrubber Config Defaults

**Task ID:** sprint-06/spec-01-scrubber-config-defaults
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-01-scrubber-config-defaults.md

## Overview

This sprint populates the `scrubber` configuration key with two sub-keys (`enabled: true` and `extraPatterns: []`) and delivers the full Sprint 06 output-scrubber pipeline: family-pattern matching, Shannon entropy scanning, a policy composer, PostToolUse hook wiring, audit integration, self-test fixture dispatch, and supporting test coverage. The scrubber intercepts every PostToolUse tool response and redacts credential-shaped strings and high-entropy tokens before they are returned to Claude in `additionalContext`.

## What Was Built

- `config/defaults.json` — `scrubber` key populated with `enabled: true` and `extraPatterns: []`
- `src/sentinel/scrubber-families.mjs` — 11 pre-compiled credential family regexes (Anthropic, OpenAI, GitHub PAT, AWS AKID, AWS session token, Slack, Stripe, SendGrid, Atlassian, LangSmith, JWT) plus `extraPatterns` support
- `src/sentinel/scrubber-entropy.mjs` — Shannon entropy scanner: redacts non-whitespace runs ≥ 24 chars with entropy > 4.5 bits as `<REDACTED:high_entropy>`
- `src/sentinel/scrubber-policy.mjs` — `scrubResponse()` policy composer: runs families then entropy, returns `{ redacted, redactions, decision, rule, matched }`
- `src/sentinel/hook.mjs` — `PostToolUse` case wired to call `scrubResponse`, emit `additionalContext` with redacted text, and write per-family audit lines; fail-open on scrubber crash; `scrubber` bucket added to `--self-test` fixture dispatch
- `src/sentinel/audit.mjs` — scrub-event guard moved before the path-tool guard (correct order)
- `tests/fixtures/scrubber/` — 8 fixture JSONs covering anthropic key, AWS AKID, disabled scrubber, GitHub PAT, high-entropy, JWT, multi-family, and prose preservation
- `tests/config.test.mjs` — 2 new test blocks asserting `scrubber` sub-key defaults and three-layer override merge
- `tests/scrubber-families.test.mjs` — full coverage of all family regexes and `extraPatterns`
- `tests/scrubber-entropy.test.mjs` — Shannon entropy math and `scrubEntropy` behavior
- `tests/scrubber-policy.test.mjs` — `scrubResponse` disabled path, multi-family, entropy, and error-recovery cases
- `tests/hook.test.mjs` — scrubber fixture runner and PostToolUse integration assertions
- `README.md` — backstop note documenting next-turn scrubber defense

## Technical Implementation

### Files Modified

- `config/defaults.json`: replaced `"scrubber": {}` with `"scrubber": { "enabled": true, "extraPatterns": [] }`
- `src/sentinel/hook.mjs`: imported `scrubResponse`; replaced no-op PostToolUse stub with full scrub + audit + fail-open; added `scrubber` to `--self-test` fixture directories
- `src/sentinel/audit.mjs`: moved `scrub_family` guard block above the Read/Edit/Grep/Glob guard to fix dispatch order
- `tests/config.test.mjs`: appended two new `test()` blocks for scrubber defaults and merge precedence

### New Files

- `src/sentinel/scrubber-families.mjs`: family regex engine with `scrubFamilies(text, extraPatterns)` export
- `src/sentinel/scrubber-entropy.mjs`: `shannonEntropy(str)` + `scrubEntropy(text)` exports
- `src/sentinel/scrubber-policy.mjs`: `scrubResponse({ text, config })` composer export
- `tests/fixtures/scrubber/*.json`: 8 self-test fixture files
- `tests/scrubber-families.test.mjs`, `tests/scrubber-entropy.test.mjs`, `tests/scrubber-policy.test.mjs`: unit test suites

### Key Changes

- **Config defaults**: `config.scrubber.enabled` defaults to `true`; `config.scrubber.extraPatterns` defaults to `[]`. The existing `deepMerge` propagates overrides through all three layers (defaults → user → project) with array-replacement semantics.
- **Family scanning**: 11 families applied in fixed order. `aws_session` preserves the key name and redacts only the value. OpenAI regex has a negative lookahead to avoid consuming Anthropic tokens. Tags use the format `<REDACTED:<family>>`.
- **Entropy scanning**: Runs after family scanning so already-tagged `<REDACTED:…>` tokens are not re-scanned. Threshold is > 4.5 bits on runs ≥ 24 non-whitespace characters.
- **Fail-open**: Any uncaught scrubber exception causes PostToolUse to emit `additionalContext: ''` and exit 0 — the tool turn is never blocked.
- **Audit**: One `writeAuditLine` call per redaction family; `matched` is always `null` (the secret is never logged).

## How to Use

### Disable the scrubber project-wide

Create or update `.claude/sentinel.json` in the project root:

```json
{ "scrubber": { "enabled": false } }
```

### Disable for your user account

Edit `~/.claude/sentinel.json`:

```json
{ "scrubber": { "enabled": false } }
```

### Add custom redaction patterns

Supply a string (regex source) or an `{name, pattern}` object in `extraPatterns`. An array override replaces the default `[]` wholesale:

```json
{
  "scrubber": {
    "extraPatterns": [
      "MY_CORP_TOKEN_[A-Z0-9]{32}",
      { "name": "internal_key", "pattern": "INTKEY-[A-Za-z0-9]{16}" }
    ]
  }
}
```

String entries are tagged `<REDACTED:custom>`; named entries are tagged `<REDACTED:<name>>`.

## Configuration

| Key | Default | Description |
|---|---|---|
| `scrubber.enabled` | `true` | Enable or disable PostToolUse output scrubbing |
| `scrubber.extraPatterns` | `[]` | User-defined redaction patterns (string or `{name, pattern}`) |

## Testing

```bash
# Full test suite
node --test tests/

# Unit tests only
node --test tests/scrubber-families.test.mjs
node --test tests/scrubber-entropy.test.mjs
node --test tests/scrubber-policy.test.mjs

# Config defaults and merge
node --test tests/config.test.mjs

# Hook integration + self-test fixtures
node src/sentinel/hook.mjs --self-test

# Full validation
make validate
```

## Notes

- `extraPatterns: []` ships as an empty array (not `null`) so policy consumers can safely call `.flatMap()` without null-guarding.
- Array replacement semantics (not append): a project override of `extraPatterns` replaces the default `[]`. An operator wanting additional patterns must include the full desired list in their override.
- The `enabled === false` guard uses strict equality so `undefined` (pre-Sprint 06 configs without the key) still enables scrubbing via fail-safe.
- The `PostToolUse` scrubber is a next-turn backstop: the redacted text appears in `additionalContext` for the next Claude turn, not the tool response itself. This is an additive defense; it does not block tool execution.
