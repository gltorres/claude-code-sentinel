# Sprint 07: Session Banners

**Band**: session · **Blocked by**: 02

## Goal
Make Sentinel visible. A user who never sees the plugin doing anything assumes it isn't, then disables it after one false positive. A one-line SessionStart banner that shows recent activity ("Sentinel active — 7 blocks, 3 scrubs in the last 7 days") earns the trust the protective matchers need to keep running. SessionEnd cleanly closes any in-flight audit state.

## What we're building
Two non-blocking hooks:

1. **`SessionStart`** matcher on `startup | resume | clear` reads the audit log, summarises the last 7 days into one line, and emits it as `additionalContext`. Includes a short reminder that PreToolUse is the primary defence and PostToolUse scrubbing is next-turn-only — so users understand the limitation surfaced in Sprint 06.
2. **`SessionEnd`** matcher writes a closing marker to the audit log so a later forensic pass can tell sessions apart.

Both hooks use `async: true` in the hook config so they never block session boot or teardown — a slow audit-log read must not delay the user's session by even a hundred milliseconds.

## Acceptance criteria
1. On a fresh session (`startup`), the user sees a single-line Sentinel banner with last-7-days counts pulled from the audit log.
2. On `resume` and `clear`, the banner re-emits with the latest counts.
3. With an empty audit log, the banner reads "Sentinel active — no events yet".
4. The banner mentions the next-turn-only limitation of the scrubber (one short phrase, not a paragraph).
5. SessionEnd writes one audit line with `event: warn`, `rule: session.end`, and the session ID.
6. Session boot is not delayed by the hook — verified by `async: true` being set in `hooks/sentinel.json` for both matchers.

## Context & constraints

**`async: true` is required.** The Claude Code hook runtime supports asynchronous hooks for events that don't need to gate the operation. SessionStart and SessionEnd both qualify — neither needs to return before the session proceeds. Setting `async: true` prevents a slow disk read from making session start feel sluggish.

**Banner size.** Keep the banner under ~500 characters — well under the 10,000-character `additionalContext` cap. A long banner trains users to scroll past it; a short one gets read.

**Banner content shape** (one line, ≤ ~120 chars typical):

```
Sentinel active — last 7d: 7 blocks, 3 scrubs, 2 asks. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence.
```

**Counting window.** Last 7 days from the audit log, computed off `ts` field. The implementation should scan from the end of the file backward until it sees an entry older than 7 days, not read the whole file every session.

**Latency budgets:** `SessionStart` < 20 ms, `SessionEnd` < 20 ms (both budgets are governed by Node cold-start plus the seek-from-end read).

## Dependencies
- Sprint 02: Reads from the audit log and writes the SessionEnd marker.

## Open questions
—
