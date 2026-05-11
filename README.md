# Sentinel — The Security Airbag for Claude Code

A defense-in-depth hook plugin for [Claude Code](https://claude.com/claude-code) that blocks three of the most-shared horror stories of 2026:

1. **Secret file reads** — Claude silently `cat`ing `.env`, `~/.aws/credentials`, SSH keys, etc., and persisting them into the JSONL transcript.
2. **Credential exfiltration in chat** — high-entropy secrets and known token prefixes (`sk-ant-`, `ghp_`, `AKIA…`, `xox[bp]-`, JWTs, Stripe, SendGrid, Slack) leaking through tool output.
3. **Slopsquatting / hallucinated packages** — `npm install`, `pip install`, `cargo add`, etc. against packages that don't exist, are <14 days old, have <100 weekly downloads, or have no homepage/repo.

## Architecture

Sentinel is a hook-first plugin. All defenses run as `PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd` hooks — no servers, no agents, no external infrastructure.

| Hook | Matcher | Purpose |
| --- | --- | --- |
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | Deny reads of secret-bearing paths |
| `PreToolUse` | `Bash` | Block shell commands that exfiltrate the same paths via `cat`/`grep`/`sed`/pipes |
| `PreToolUse` | `Bash` | Verify package install commands against live registries (npm, PyPI, crates.io) |
| `PostToolUse` | `Bash\|Read\|Grep` | Scrub high-entropy strings and token prefixes from tool output |
| `SessionStart` | `startup\|resume\|clear` | One-line advisory showing blocks / near-misses since last session |
| `SessionEnd` | — | Append structured audit line to `~/.claude/sentinel/audit.jsonl` |

> **Output scrubber — next-turn backstop, not in-turn redaction.** By the time the `PostToolUse` hook runs, the raw tool result has already been delivered to the model's context window and written to the on-disk JSONL transcript. The `additionalContext` field is *additive*: it injects extra text into the model's next turn; it does not replace, mutate, or erase the tool result the model already received. The scrubber therefore stops a leaked credential from being *re-quoted, summarised, or memorised* across subsequent turns — it does not stop the raw value from reaching the model in this turn. For true in-turn prevention, rely on the `PreToolUse` path-deny rules (Sprint 03) and bash-exfil-deny rules (Sprint 04), which block the tool call before the result is ever produced.

## Status

Early development. Not yet installable.

## License

TBD

## Local development install

```
/plugin marketplace add ./claude-code-sentinel
/plugin install sentinel@claude-code-sentinel
/reload-plugins
```

## Data Refresh

Run `make refresh-data` (or `npm run refresh-data`) to pull the latest top-500
package lists from upstream sources and rewrite the bundled JSON files under
`src/sentinel/data/`.
