# Output Scrubber README Backstop Note

**Task ID:** sprint-06/spec-07-scrubber-readme-note
**Date:** 2026-05-10
**Specification:** specs/sprint-06-output-scrubber/spec-07-scrubber-readme-note.md

## Overview

Adds a blockquote paragraph to `README.md` immediately below the Architecture table, explaining that the `PostToolUse` output scrubber is a next-turn backstop — not an in-turn redaction mechanism. The note is required by the Sprint 06 PRD (`mvp-prd/sprint-planning/06-output-scrubber.md:31`) to prevent users from treating the scrubber as a primary secret-prevention layer. No source code, tests, or configuration were changed.

## What Was Built

- One Markdown blockquote paragraph inserted into `README.md` after the `SessionEnd` Architecture table row and before `## Status`.
- The paragraph documents four key constraints of the `PostToolUse` hook:
  1. The raw tool result reaches the model's context window and JSONL transcript before the hook runs.
  2. `additionalContext` is additive-only — it cannot replace or erase what the model already received.
  3. The scrubber's purpose is to stop a leaked value from being re-quoted, summarised, or memorised in subsequent turns.
  4. For true in-turn prevention, users must rely on the `PreToolUse` path-deny (Sprint 03) and bash-exfil-deny (Sprint 04) rules.

## Technical Implementation

### Files Modified

- `README.md`: Two lines added — the blockquote paragraph and a trailing blank line — immediately after the `SessionEnd` Architecture table row (original line 21).

### Key Changes

- Paragraph formatted as a Markdown blockquote (`>`) for visual prominence, following callout conventions already implied in the project's README style.
- Text is verbatim from the PRD's "Context & constraints" block (`06-output-scrubber.md:24-31`) and research note (`research/2026-05-10-sprint-06-output-scrubber.md:§1`).
- Insertion is purely additive — no existing Architecture table row wording was removed or reworded.
- The SessionStart banner that would echo this limitation at runtime is explicitly deferred to Sprint 07 scope (per research doc §5).

## How to Use

The note is documentation for consumers of the sentinel plugin:

1. Read the Architecture table in `README.md` to understand the hook lifecycle.
2. Read the blockquote below the table to understand the PostToolUse limitation.
3. When designing a policy that must prevent secrets from reaching the model at all, implement `PreToolUse` rules (path-deny, Sprint 03; bash-exfil-deny, Sprint 04) rather than relying on the output scrubber.

## Configuration

None. This is a documentation-only change. No config keys, environment variables, or settings are added.

## Testing

No automated tests are required or added. The paragraph content is verified by human review against the spec's success criteria:

- Phrase "next-turn backstop" present.
- Phrase "already been delivered to the model's context window and written to the on-disk JSONL transcript" present.
- Phrase "re-quoted, summarised, or memorised" present.
- References to Sprint 03 (path-deny) and Sprint 04 (bash-exfil-deny) as primary in-turn defences present.
- All existing automated checks (`make validate`, `node --test tests/`, `node src/sentinel/hook.mjs --self-test`) continue to pass with zero regressions.

## Notes

- The `>` blockquote format can be dropped if a future README style guide prefers plain paragraphs — the text content is unchanged either way.
- The SessionStart banner that echoes this limitation at runtime is Sprint 07 scope and is not covered by this spec.
