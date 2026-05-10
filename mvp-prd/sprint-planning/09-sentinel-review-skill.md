# Sprint 09: `/sentinel-review` Slash Command

**Band**: command · **Blocked by**: 08

## Goal
Give the user one entry point that surfaces everything Sentinel has done, lets them debug a misconfigured rule without triggering a real block, and delegates deep investigation to the Sprint 08 agent. Without this, the audit log is a file no one reads and the investigator agent is unreachable.

## What we're building
A single dispatcher slash command at `commands/sentinel-review.md` with sub-commands:

- `/sentinel-review` (or `summary`) — totals by category, last 7 days.
- `/sentinel-review recent [N]` — last N audit entries with timestamps and reasons (default N = 20).
- `/sentinel-review investigate <id>` — invoke `sentinel-investigator` in Mode B on the audit entry.
- `/sentinel-review investigate-pkg <ecosystem> <name>` — invoke `sentinel-investigator` in Mode A directly.
- `/sentinel-review test <command>` — dry-run the hook against a synthetic Bash or Read input; show the decision without writing to the audit log.
- `/sentinel-review config` — show the effective merged config with source attribution per key (user / project / default).

## Acceptance criteria
1. `summary` against a populated audit log shows counts by `event` class for the last 7 days.
2. `recent 10` shows the last 10 audit entries with timestamps, rules, and human-readable reasons (no raw input).
3. `investigate <id>` resolves the audit entry, dispatches to `sentinel-investigator` in Mode B, and streams the markdown report.
4. `investigate-pkg npm <name>` dispatches to `sentinel-investigator` in Mode A.
5. `test "cat .env"` shows `deny` with the matched rule but writes no audit entry; `test "wc -l .env"` shows `allow`.
6. `config` prints the merged config with each key annotated by its source (`default | user | project`).
7. Unknown sub-commands show a help block listing the supported sub-commands.

## Context & constraints

**Sub-agent delegation uses the `Agent` tool, not `Task`.** The Claude Code tool was renamed in v2.1.63; `Task` still works as an alias but is deprecated. Use `Agent` for forward compatibility. The command file's instructions should explicitly invoke `Agent` when dispatching to `sentinel-investigator`.

**Dry-run mode.** `test` invokes the hook entry script with a `--dry-run` flag:

```
node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs PreToolUse --dry-run
```

The hook script honours `--dry-run` by:
- Reading the synthetic event from stdin (constructed by the slash command from the user's argument).
- Running its normal decision logic.
- Printing the decision plus the matched rule to stdout in a human-readable format.
- **Not** writing to the audit log.

This is the critical UX path for users who hit a false positive and want to understand why before tuning their config.

**Source attribution for `config`.** The merged config is built from three sources: shipped defaults, user (`~/.claude/sentinel.json`), project (`.claude/sentinel.json`). The `config` sub-command annotates each leaf value with where it came from so the user can edit the right file. Implementation can be a thin wrapper over the Sprint 02 config loader — instruct the loader to track source as part of the merge.

**Command file shape.** Markdown at `commands/sentinel-review.md` with the standard slash-command frontmatter (name, description, allowed-tools). Sub-command dispatch is branching logic in the markdown body — Claude Code reads the markdown as the command's instructions to the model.

## Dependencies
- Sprint 08: `investigate` and `investigate-pkg` delegate to the `sentinel-investigator` agent. The command file references the agent by name; the agent must already be in place.
- Sprint 02: Reads from the audit log and the merged config.

## Open questions
—
