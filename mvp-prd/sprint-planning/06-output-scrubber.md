# Sprint 06: Output Scrubber (next-turn defence)

**Band**: posttool · **Blocked by**: 02

## Goal
Stop credentials that slipped into a tool response (a `grep`, an env dump, a `kubectl describe`) from propagating to the next model turn. **This is next-turn defence only.** It is not in-turn redaction — the raw value already reached the model in this turn's tool result. The PreToolUse layers (Sprints 03–05) are the primary defence; this sprint exists because they will sometimes miss, and we still want to stop the leaked value from being quoted, summarised, or memorised across subsequent turns.

## What we're building
A PostToolUse matcher on `Bash | Read | Grep | Glob` that scans the tool response for known credential shapes plus a high-entropy fallback, and emits a redacted view as `additionalContext` for the model's next turn. Every redaction writes one audit entry naming the family.

## Acceptance criteria
1. A tool response containing `sk-ant-abc...` (≥ 32 chars after the prefix) is emitted to `additionalContext` with the substring replaced by `<REDACTED:anthropic>`.
2. A response containing an `AKIA` access-key (`AKIA` + 16 uppercase alphanumerics) is redacted as `<REDACTED:aws_akid>`.
3. A response containing a `ghp_...` / `gho_...` / `ghu_...` / `ghs_...` / `ghr_...` GitHub PAT is redacted as `<REDACTED:github_pat>`.
4. A response containing a JWT (`eyJ...eyJ...sig`) is redacted as `<REDACTED:jwt>`.
5. A response with a 32-character base64-shaped string with Shannon entropy > 4.5 and no known family prefix is redacted as `<REDACTED:high_entropy>`.
6. Non-secret prose ("the build passed in 4.2 seconds") is preserved verbatim.
7. Every redaction writes one audit entry with `event: scrub`, `rule: scrubber.<family>`, and a redaction count — never the redacted text.
8. At least 8 scrubber fixtures cover each family + the entropy fallback and pass through `--self-test`.
9. Hook latency stays under ~30 ms.

## Context & constraints

**This is the most misunderstood matcher in the PRD — be honest about what it can do.**

`PostToolUse` in Claude Code is **non-blocking and additive-only**. The tool result is already in the model's context and already written to the on-disk JSONL transcript by the time the hook runs. `additionalContext` injects *extra* text into the next model turn; it does **not** replace, mutate, or overwrite the tool result the model has already received. So:

- **What this sprint stops:** the scrubbed value being re-quoted by the model in subsequent turns; the value entering long-running summaries; the value being written into a code edit the model is about to make.
- **What this sprint does NOT stop:** the raw value reaching the model in this turn's tool result (Sprint 03/04 are the only defence for that); the raw value being recorded in the on-disk JSONL transcript for that specific tool call (also a Sprint 03/04 problem).

This limitation must be documented in the README and surfaced in the SessionStart banner (Sprint 07) — users need to know PreToolUse is the primary defence and PostToolUse is a backstop, not an eraser.

**Token families to detect** (PRD §6.5 — these stay):

| Family | Pattern |
| --- | --- |
| `anthropic` | `sk-ant-[A-Za-z0-9_-]{32,}` |
| `openai` | `sk-[A-Za-z0-9]{40,}` (excluding `sk-ant-`) |
| `github_pat` | `(ghp\|gho\|ghu\|ghs\|ghr)_[A-Za-z0-9]{36,}` |
| `aws_akid` | `AKIA[0-9A-Z]{16}` |
| `aws_session` | high-entropy after `aws_session_token=` |
| `slack` | `xox[abprs]-[A-Za-z0-9-]{10,}` |
| `stripe_live` | `sk_live_[A-Za-z0-9]{24,}` |
| `sendgrid` | `SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}` |
| `atlassian` | `ATATT3[A-Za-z0-9_-]{180,}` |
| `langsmith` | `lsv2_pt_[A-Za-z0-9]{32,}` |
| `jwt` | `eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=.+/-]+` |
| `high_entropy` | Shannon entropy > 4.5 on contiguous strings of length ≥ 24, after the family scan |

**Replacement format:** `<REDACTED:<family>>`. No length suffix, no truncated preview — anything more would itself become a leak vector.

**`additionalContext` size cap:** 10,000 characters. If a scrubbed response would exceed it, Claude Code automatically spills to a file and injects a path instead. Don't fight this — just write the scrubbed text and let the runtime handle overflow.

**Vendored Shannon entropy.** ~30 LOC, no dep needed. Compute on contiguous non-whitespace runs of length ≥ 24; flag runs with entropy > 4.5.

**Hook entry latency budget:** < 30 ms. Regex scan is cheap; the constraint is staying small enough that the scrubber doesn't itself become a noticeable post-tool delay.

## Dependencies
- Sprint 02: Reads `scrubber.enabled` and `scrubber.extraPatterns` from config; writes audit entries.

## Open questions
- Should `scrubber.extraPatterns` accept named families with regex + display name, or just raw regex strings (which would all be tagged `<REDACTED:custom>`)?
