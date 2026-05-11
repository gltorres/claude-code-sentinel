# Sentinel Review Slash Command

**Task ID:** sprint-09-spec-05
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-05-sentinel-review-command.md

## Overview

This deliverable creates `commands/sentinel-review.md` — the user-facing slash command that serves as the single entry point for all Sentinel observability and control actions in Claude Code. The file is a pure markdown instruction set with YAML frontmatter that Claude Code loads when the user invokes `/sentinel-review`, routing seven sub-command branches to CLI helpers, the dry-run path, and the forensic investigator agent.

## What Was Built

- `commands/sentinel-review.md` — 157-line slash command definition at the repo root with YAML frontmatter and full branch dispatcher body
- Seven sub-command branches: `summary` (empty args), `recent [N]`, `config`, `test <command>`, `investigate <id>`, `investigate-pkg <eco> <name> [version]`, and unknown/`help`
- Input-shape heuristic for the `test` branch: path-like inputs build a Read-shaped synthetic event; all others build a Bash-shaped event
- Agent dispatch via `subagent_type: "sentinel-investigator"` for both `investigate` (Mode B) and `investigate-pkg` (Mode A)
- Static help block listing all six supported sub-commands with examples

## Technical Implementation

### Files Modified

- `commands/sentinel-review.md`: Created from scratch — YAML frontmatter (`name`, `description`, `allowed-tools`) plus prose branch dispatcher body

### Key Changes

- **Frontmatter** declares `name: sentinel-review`, `description: Inspect Sentinel audit state, dry-run rules, dispatch the investigator agent.`, and `allowed-tools: Bash, Read, Agent`.
- **Branch dispatch** is a linear `$ARGUMENTS`-matching structure; empty args default to the `summary` branch.
- **Bash branches** (`summary`, `recent`, `config`, `test`) shell out via `node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/review-cli.mjs` or `node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs PreToolUse --dry-run`.
- **Agent branches** (`investigate`, `investigate-pkg`) use the `Agent` tool with `subagent_type: "sentinel-investigator"` — not the deprecated `Task` tool.
- **`investigate-pkg` ecosystem guard** rejects any `<eco>` value that is not `npm`, `pypi`, or `crates` before dispatching to the agent.

## How to Use

1. **Audit summary** — `/sentinel-review` or `/sentinel-review summary`
   Shows block/ask/scrub/warn counts for the last 7 days as a bulleted list.

2. **Tail the log** — `/sentinel-review recent [N]`
   Shows the last N audit entries (default 20), newest first.

3. **Inspect effective config** — `/sentinel-review config`
   Shows each config leaf with source attribution (`default`, `user`, or `project`), grouped by source.

4. **Dry-run a command** — `/sentinel-review test "cat .env"` or `/sentinel-review test ~/.ssh/id_rsa`
   Pipes a synthetic event to `hook.mjs --dry-run` and shows the decision without writing an audit entry.

5. **Investigate an audit entry** — `/sentinel-review investigate <id> [secret_prefix]`
   Dispatches the `sentinel-investigator` agent in Mode B with the given audit entry ULID.

6. **Investigate a package** — `/sentinel-review investigate-pkg <npm|pypi|crates> <name> [version]`
   Dispatches the `sentinel-investigator` agent in Mode A for a proactive package risk report.

7. **Help** — `/sentinel-review help` or any unrecognized argument
   Prints a static help block listing all sub-commands and examples.

## Configuration

No configuration changes are required. The command auto-discovers from `commands/sentinel-review.md` at the repo root — no `commands` key in `.claude-plugin/plugin.json` is needed. Runtime invocations use `${CLAUDE_PLUGIN_ROOT}`, a shell variable set by the Claude Code plugin runtime to the plugin installation directory.

## Testing

This spec adds no unit tests (the command body is model instructions, not executable Node code). Behavioral validation is covered by the Sprint 09 Spec 06 E2E runbook at `.claude/commands/e2e/test_sprint_09_sentinel_review.md`, which asserts all seven branches and verifies that the body contains the literal string `Agent` referencing `sentinel-investigator`.

Validation commands:
```bash
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
```

## Notes

- The command depends on Specs 01–04 being deployed: `summary`, `recent`, `config`, and `test` branches shell out to `review-cli.mjs` (Spec 04) and `hook.mjs --dry-run` (Spec 03). The file is safe to create early but Bash branches will fail at runtime until those specs are live.
- `$ARGUMENTS` is a Claude Code slash-command convention substituted by the runtime — it is not a shell variable.
- The `test` branch path-shape heuristic treats single-word inputs without shell operators as file paths (building a Read-shaped event), which is the correct fallback for commands like `ls`.
- `investigate` vs `investigate-pkg` disambiguation relies on exact first-word matching; misspellings fall through to the help branch.
