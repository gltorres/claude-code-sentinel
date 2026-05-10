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

## Status

Early development. Not yet installable.

## License

TBD
