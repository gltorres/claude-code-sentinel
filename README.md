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

## Data refresh

The investigator agent's typosquat check compares a candidate package name against bundled lists of the 500 most-downloaded packages per ecosystem (`src/sentinel/data/top_packages_{npm,pypi,crates}.json`). These lists are static snapshots that ship with the plugin and must be refreshed periodically to stay accurate as the ecosystem's popular-package roster evolves.

### Automatic cadence

A GitHub Actions workflow (`.github/workflows/refresh-top-packages.yml`) runs automatically on the **first of every month at 06:00 UTC**. If any of the three data files changed, the workflow opens a pull request with branch name `chore/refresh-top-packages-<run_number>` for human review. No data file is committed automatically without a PR.

The workflow can also be triggered manually from the Actions UI (`workflow_dispatch`) at any time.

### Manual fallback

To refresh the data locally without waiting for the monthly cron:

```bash
make refresh-data
```

Or equivalently:

```bash
node tools/refresh_top_packages.mjs
```

Each run fetches the current top-500 lists from upstream sources (npm download stats, PyPI top-30-days JSON, crates.io downloads API), normalises each list (lowercase, deduplicated, sorted), and writes the result atomically to `src/sentinel/data/`. A summary line is printed per ecosystem on success.

### What the data is used for

`agents/sentinel-investigator.md` (Mode A, step 3 — typosquat distance check) computes the Levenshtein distance between the candidate package name and every name in the relevant ecosystem's bundled list. A distance of 1 or 2 from a popular package name is flagged as a potential typosquat. The bundled lists are also used by `src/sentinel/levenshtein.mjs` in unit tests.

## License

TBD

## Local development install

```
/plugin marketplace add ./claude-code-sentinel
/plugin install sentinel@claude-code-sentinel
/reload-plugins
```

## Investigator agent

When the hook blocks or scrubs and you want a full forensic report, invoke the investigator subagent directly in Claude Code:

```
/agent sentinel-investigator
```

**Mode A — package investigation:**
> Investigate the npm package `lod4sh` version `4.17.21`

**Mode B — leak investigation** (use the `id` from your audit log at `~/.claude/sentinel/audit.jsonl`):
> Investigate audit entry `01HZ9K3V2P8QRMX4TNYW5D6J7B`, my secret prefix is `ghp_Ab`

The full agent instructions are in `agents/sentinel-investigator.md`.

Keep the bundled top-500 package lists current for accurate typosquat detection:

```
make refresh-data
```
