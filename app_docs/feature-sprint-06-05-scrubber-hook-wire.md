# Scrubber Hook Wire

**Task ID:** `sprint-06/spec-05-scrubber-hook-wire`
**Date:** 2026-05-10
**Specification:** `specs/sprint-06-output-scrubber/spec-05-scrubber-hook-wire.md`

## Overview

This feature wires the output scrubber into the `PostToolUse` branch of `src/sentinel/hook.mjs`, replacing a three-line pass-through stub with a live call to `scrubResponse` from `scrubber-policy.mjs`. Tool responses containing secrets are redacted before they reach the model's next turn, with one audit line written per detected family and a guaranteed fail-open exit — a scrubber crash never blocks a tool turn.

## What Was Built

- **PostToolUse scrubber wiring** in `src/sentinel/hook.mjs`: replaces the empty stub with a full scrubber branch including disabled-path guard, per-family audit writes, and outer fail-open catch
- **Static import** of `scrubResponse` from `scrubber-policy.mjs` added to `hook.mjs`
- **Self-test dispatch** for the `scrubber` fixture bucket: `scrubber` added to `fixtureDirs` and the comparator extended to map `scrubResponse` results to the fixture-expected shape
- **8 scrubber fixture JSON files** under `tests/fixtures/scrubber/` (anthropic, aws-akid, disabled, github-pat, high-entropy, jwt, multi-family, preserve-prose)
- **3 integration tests** appended to `tests/hook.test.mjs` covering secret present (S1), no secret (S2), and scrubber disabled via project config (S3)

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: added `scrubResponse` import; replaced PostToolUse stub (lines 366–368) with full scrubber branch; added `'scrubber'` to `fixtureDirs` and scrubber bucket comparator in `--self-test`
- `tests/hook.test.mjs`: extended `node:fs` import with `mkdirSync`/`writeFileSync`; appended three integration tests (S1, S2, S3)
- `tests/fixtures/scrubber/*.json`: eight self-test fixture files (new files)

### Key Changes

- **`emit()` is bypassed for PostToolUse** — `emit()` would write one audit line for the whole event; the scrubber needs one line per detected family. The branch inlines `process.stdout.write(JSON.stringify(envelope(...)) + '\n')` and `process.exit(0)` directly, matching the `emit()` wire format without the double-audit side effect.
- **Disabled-path guard** — `config?.scrubber?.enabled === false` short-circuits to `additionalContext: ''` with zero audit lines and exits 0, matching the old stub shape exactly.
- **Per-family audit loop** — `for (const { family, count } of result.redactions)` calls `writeAuditLine` with `event: 'scrub'`, `decision: 'allow'`, `rule: 'scrubber.<family>'`, and `matched: null`. `matched: null` is mandatory — the raw secret must never appear in the audit log.
- **Outer fail-open catch** — any exception from `scrubResponse`, `JSON.stringify`, or the audit loop falls through to `additionalContext: ''` + `process.exit(0)`, ensuring the tool turn is never blocked.
- **Self-test bucket wiring** — `'scrubber'` added to `fixtureDirs`; comparator maps `scrubResponse` result to `{ decision, rule, matched }` using `'scrubber.' + firstFamily` for the rule and `null` for matched.

### PostToolUse Branch Shape

```
PostToolUse event received
  │
  ├─ scrubber.enabled === false → emit additionalContext:'' → exit 0
  │
  └─ scrubResponse({ text: event.tool_response, config })
       │
       ├─ for each redaction family:
       │    writeAuditLine(event:'scrub', decision:'allow', rule:'scrubber.<family>', matched:null)
       │
       └─ emit additionalContext: result.redacted → exit 0
            │
            └─ [any throw] → emit additionalContext:'' → exit 0  (fail-open)
```

## How to Use

The wiring is automatic — no configuration change is required. Every `PostToolUse` event is now filtered through the scrubber pipeline.

1. **Default behavior (scrubber enabled)**: any `tool_response` containing a recognized secret pattern or high-entropy string is redacted to `<REDACTED:<family>>` before the model sees it. The audit log receives one `event:'scrub'` record per family.

2. **Disable for a project**: create `.claude/sentinel.json` in the project root:
   ```json
   { "scrubber": { "enabled": false } }
   ```
   The `PostToolUse` branch will emit an empty `additionalContext` with no audit lines.

3. **Manual test**:
   ```sh
   echo '{"tool_name":"Bash","tool_response":"sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
     | node src/sentinel/hook.mjs PostToolUse
   ```
   Output `additionalContext` should contain `<REDACTED:anthropic>`, not the raw key.

## Configuration

All configuration lives under `config.scrubber` (defaults in `config/defaults.json`, overridable via project or user `sentinel.json`):

| Key | Default | Effect |
|---|---|---|
| `scrubber.enabled` | `true` | Set `false` to disable all scrubbing and audit writes |
| `scrubber.extraPatterns` | `[]` | Additional patterns (string regex or `{ name, pattern }`) merged into the family scanner |

## Testing

```sh
# Full suite (all Sprint 03–06 tests must pass)
node --test tests/

# Self-test including scrubber fixtures
node src/sentinel/hook.mjs --self-test

# Combined validation
make validate
```

The three integration tests in `tests/hook.test.mjs` cover:
- **S1** — Bash response with Anthropic API key: `additionalContext` contains `<REDACTED:anthropic>`, one scrub audit line, raw secret absent from JSONL
- **S2** — Read response with no secret: `additionalContext` equals input verbatim, zero scrub audit lines
- **S3** — Scrubber disabled via project `sentinel.json`: `additionalContext` is `''`, zero scrub audit lines, raw secret absent from JSONL

## Notes

- **Double-audit caveat**: `emit()` writes one audit line unconditionally for the whole event. PostToolUse needs one line per detected family, so `emit()` is bypassed entirely for this case. `SessionStart`, `SessionEnd`, and `PreToolUse` continue to use `emit()` unchanged.
- **`matched: null` is mandatory**: the matched value for a scrub event is the raw secret. `audit.mjs` synthesises `input_summary` from `scrub_family`/`scrub_count` fields patched onto the event object; `matched` is intentionally left null and never written to JSONL.
- **Spec ordering**: this spec depends on Specs 01–04 (`scrubber-config-defaults`, `scrubber-families`, `scrubber-entropy`, `scrubber-policy`). If `scrubber-policy.mjs` is absent, `hook.mjs` will fail at startup with `ERR_MODULE_NOT_FOUND`.
- **Spec 06 scope**: the self-test fixture floor in `hook.test.mjs` is not bumped by this spec — that is Spec 06 (`scrubber-self-test-fixtures`)'s scope.
