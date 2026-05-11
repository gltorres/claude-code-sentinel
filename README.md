# Sentinel — The Security Airbag for Claude Code

A defense-in-depth hook plugin for [Claude Code](https://claude.com/claude-code) that blocks three of the most-shared horror stories of 2026:

1. **Secret file reads** — Claude silently `cat`ing `.env`, `~/.aws/credentials`, SSH keys, etc., and persisting them into the JSONL transcript.
2. **Credential exfiltration in chat** — high-entropy secrets and known token prefixes (`sk-ant-`, `ghp_`, `AKIA…`, `xox[bp]-`, JWTs, Stripe, SendGrid, Slack) leaking through tool output.
3. **Slopsquatting / hallucinated packages** — `npm install`, `pip install`, `cargo add`, etc. against packages that don't exist, are <14 days old, have <100 weekly downloads, or have no homepage/repo.

## Status

v1 — installable. Follow the [Install](#install--5-min) instructions below.
All four defensive systems (path deny, bash exfil deny, registry check, output scrubber) are active.
`make validate` passes on macOS 14+ and Ubuntu 22.04+.

## Install (≤ 5 min)

**Prerequisites**: Node.js ≥ 20.10 and Git.

```bash
$ node --version    # must be >= 20.10
$ git clone <repo-url>
$ cd claude-code-sentinel
$ make validate
$ claude
> /plugin marketplace add ./claude-code-sentinel
> /plugin install sentinel@claude-code-sentinel
```

After `/plugin install` completes, restart Claude Code (or run `/reload-plugins`) so the hooks take effect. You should see a one-line Sentinel advisory when the next session starts.

**If `make validate` fails**: check that your Node version meets the ≥ 20.10 requirement. No `npm install` is needed — Sentinel has zero runtime dependencies.

**Bounce-back**: if the plugin does not appear in `/plugin list`, remove it with `/plugin uninstall sentinel@claude-code-sentinel` and repeat from the `/plugin marketplace add` step.

## Demo

Run the four-scenario scripted demo (no Claude API key required):

```bash
make demo
```

This drives the hook end-to-end through:
1. `cat .env` → `deny` (bash exfil rule `bash.cat`)
2. `pip install <slopsquat>` → `ask` (registry rule `registry.too_new`)
3. `sk-ant-…` in tool output → scrub (`additionalContext` injection)
4. `/sentinel-review recent 3` → three audit lines from steps 1–3

The full captured transcript is at [demo/transcript.md](demo/transcript.md).

> **Scrubber caveat**: step 3 demonstrates the next-turn backstop, not in-turn redaction. See the caveat under "What Sentinel defends against" for the full explanation.

## What Sentinel defends against

| Hook | Matcher | Purpose |
| --- | --- | --- |
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | Deny reads of secret-bearing paths |
| `PreToolUse` | `Bash` | Block shell commands that exfiltrate the same paths via `cat`/`grep`/`sed`/pipes |
| `PreToolUse` | `Bash` | Verify package install commands against live registries (npm, PyPI, crates.io) |
| `PostToolUse` | `Bash\|Read\|Grep` | Scrub high-entropy strings and token prefixes from tool output |
| `SessionStart` | `startup\|resume\|clear` | One-line advisory showing blocks / near-misses since last session |
| `SessionEnd` | — | Append structured audit line to `~/.claude/sentinel/audit.jsonl` |

> **Output scrubber — next-turn backstop, not in-turn redaction.** By the time the `PostToolUse` hook runs, the raw tool result has already been delivered to the model's context window and written to the on-disk JSONL transcript. The `additionalContext` field is *additive*: it injects extra text into the model's next turn; it does not replace, mutate, or erase the tool result the model already received. The scrubber therefore stops a leaked credential from being *re-quoted, summarised, or memorised* across subsequent turns — it does not stop the raw value from reaching the model in this turn. For true in-turn prevention, rely on the `PreToolUse` path-deny rules (Sprint 03) and bash-exfil-deny rules (Sprint 04), which block the tool call before the result is ever produced.

## Configuration

Default rules live in `config/defaults.json`. To override, create `.claude/sentinel.json` in your home directory (user-level) or in the repo root (project-level). Project overrides take precedence over user overrides, which take precedence over defaults.

Example project override that relaxes the registry age threshold:

```json
{
  "registry": {
    "minAgeDays": 7
  }
}
```

Key defaults:
- `paths.deny` — glob patterns for files Sentinel blocks Claude from reading.
- `bash.denyCommands` — shell commands blocked when used with denied path arguments (`cat`, `grep`, `sed`, …).
- `registry.minAgeDays` — packages younger than this (default 14) trigger an `ask`.
- `registry.minWeeklyDownloads` — packages with fewer downloads (default 100) trigger an `ask`.
- `scrubber.enabled` — set `false` to disable output scrubbing (not recommended).

To inspect the effective merged config:

```
/sentinel-review config
```

## Reviewing what Sentinel has done

Every block, ask, scrub, and warn is appended to `~/.claude/sentinel/audit.jsonl`. Use the `/sentinel-review` slash command to inspect the log without opening raw JSONL:

```
/sentinel-review             # 7-day summary (block/ask/scrub/warn counts)
/sentinel-review recent 10   # last 10 entries, newest first
/sentinel-review config      # effective config with per-key source attribution
```

**Audit-log path resolution.** Sentinel resolves the audit log path in this order: (1) explicit `config.audit.path`, (2) `$CLAUDE_PLUGIN_DATA/audit.jsonl` (set automatically by Claude Code when invoking plugin hooks), (3) fallback `~/.claude/sentinel/audit.jsonl`. The hook writer picks one of these per-invocation based on the env it runs under. To keep `/sentinel-review` accurate when the writer and reader run under different environments (the live plugin hook has `$CLAUDE_PLUGIN_DATA` set; the Bash-tool child running the CLI does not), the writer also persists its resolved path to a sidecar pointer at `~/.claude/sentinel/.audit-path`. The CLI reads the pointer and includes the discovered path in its scan; stale pointers (left by tests that cleaned up their temp dirs) are filtered out by an `existsSync` gate. Use `/sentinel-review` rather than reading the JSONL directly — the CLI discovers and merges across all live and historical audit files.

For a full forensic report on a flagged entry, invoke the investigator subagent:

```
/agent sentinel-investigator
```

**Mode A — package investigation:**
> Investigate the npm package `lod4sh` version `4.17.21`

**Mode B — leak investigation** (use the `id` from your audit log):
> Investigate audit entry `01HZ9K3V2P8QRMX4TNYW5D6J7B`, my secret prefix is `ghp_Ab`

The full agent instructions are in `agents/sentinel-investigator.md`.

## Cross-platform support

Sentinel is first-class on **macOS** (14+) and **Linux** (Ubuntu 22.04+, Debian 12+). All path handling uses Node's `node:path` and `node:os` modules — no platform-specific shell scripts exist in the repo.

**Windows is supported via WSL only.** PowerShell's `${CLAUDE_PLUGIN_ROOT}` expansion is unreliable for the hook entry point, so the plugin is not certified for native Windows shells. Install the plugin inside a WSL 2 session and use the standard `make validate` and install flow above.

Node ≥ 20.10 is required on all platforms. The hook enforces this at startup — if the Node version is below the threshold, Sentinel fails open (allows the tool call) and emits an advisory reason explaining the version mismatch.

## Out of scope

Sentinel defends against Claude Code mis-use during a trusted session. It cannot defend against a malicious `.claude/settings.json` that registers its own hooks before Sentinel's run (CVE-2025-59536). Use `git status` to check for untrusted settings files before opening any repo.

Additional non-goals for v1:
- Defending against a compromised Node.js binary or OS-level rootkit.
- Replacing a secrets-scanning CI step (e.g. `git-secrets`, `trufflehog`) — Sentinel is a runtime backstop, not a pre-commit gate.
- Network-egress filtering beyond registry package verification.

## Debugging Sentinel

When inspecting Sentinel's behaviour from inside a running Claude Code session, prefer one shell command per `Bash` tool call. The bash-walker tokenises the entire compound command before path-matching, and a quoted wrapper string that *mentions* a denied path can trigger the deny rule even when no actual file would be read at runtime:

```bash
# Denied — the walker sees ".env" inside the echo argument and treats
# the whole compound command as touching a secret:
echo "testing cat .env behaviour"; node script.mjs

# Equivalent isolated invocations both succeed:
echo "testing cat behaviour"
node script.mjs
```

The asymmetry is intentional: `paths.deny` patterns match permissively (`**/.env.*` matches any token containing `.env.` plus trailing characters), while `paths.allow` patterns match exactly (`**/.env.test` requires the token to end in `.env.test`). This keeps deny paranoid and allow precise — desirable for a security tool, surprising when you are meta-debugging the tool itself.

If you need to inspect a hook decision against a specific event, prefer the standalone dry-run mode over crafting bash invocations that mention denied paths:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env.test"},"cwd":"/path/to/project"}' \
  | node src/sentinel/hook.mjs PreToolUse --dry-run
```

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
node scripts/refresh_top_packages.mjs
```

Each run fetches the current top-500 lists from upstream sources (npm download stats, PyPI top-30-days JSON, crates.io downloads API), normalises each list (lowercase, deduplicated, sorted), and writes the result atomically to `src/sentinel/data/`. A summary line is printed per ecosystem on success.

### What the data is used for

`agents/sentinel-investigator.md` (Mode A, step 3 — typosquat distance check) computes the Levenshtein distance between the candidate package name and every name in the relevant ecosystem's bundled list. A distance of 1 or 2 from a popular package name is flagged as a potential typosquat. The bundled lists are also used by `src/sentinel/levenshtein.mjs` in unit tests.

## License

TBD
