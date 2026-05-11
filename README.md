# Sentinel: a security airbag for Claude Code

A Claude Code hook plugin that blocks three of the most-shared horror stories of 2026:

1. **Secret file reads.** Claude silently `cat`ing `.env`, `~/.aws/credentials`, SSH keys, and similar, then persisting them into the JSONL transcript.
2. **Credential exfiltration in chat.** High-entropy secrets and known token prefixes (`sk-ant-`, `ghp_`, `AKIA…`, `xox[bp]-`, JWTs, Stripe, SendGrid, Slack) leaking through tool output.
3. **Slopsquatting.** `npm install`, `pip install`, `cargo add`, and friends against packages that don't exist, are less than 14 days old, have under 100 weekly downloads, or have no homepage/repo.

It's built for developers running Claude Code in repos that contain real secrets. If your `~/.aws/credentials`, `.env`, or `~/.ssh/id_rsa` is one hallucinated `cat` away from the JSONL transcript, that's the threat model.

## Status

v1, installable. Follow the install instructions below. All four defenses (path deny, bash exfil deny, registry check, output scrubber) are on by default. `make validate` passes on macOS 14+ and Ubuntu 22.04+.

## Install in five minutes

You'll need Node.js 20.10 or newer and Git.

```bash
$ node --version    # must be >= 20.10
$ git clone https://github.com/gltorres/claude-code-sentinel.git
$ cd claude-code-sentinel
$ claude
> /plugin marketplace add ./
> /plugin install sentinel@claude-code-sentinel
```

After `/plugin install` finishes, restart Claude Code (or run `/reload-plugins`) so the hooks take effect. The next session prints a one-line Sentinel advisory on startup.

Optional: run `make validate` before installing to sanity-check Node version and run the test suite locally. There's no `npm install` step; Sentinel ships with zero runtime dependencies.

If the plugin doesn't show up in `/plugin list`, run `/plugin uninstall sentinel@claude-code-sentinel` and start again from the `/plugin marketplace add` step.

## Demo

Run the four-scenario scripted demo:

```bash
make demo
```

This drives the hook end-to-end through:

1. `cat .env` → `deny` (bash exfil rule `bash.cat`)
2. `pip install <slopsquat>` → `ask` (registry rule `registry.too_new`)
3. `sk-ant-…` in tool output → scrub (`additionalContext` injection)
4. `/sentinel-review recent 3` → three audit lines from steps 1–3

The captured transcript is at [demo/transcript.md](demo/transcript.md).

> Step 3 demonstrates the next-turn backstop, not in-turn redaction. The scrubber caveat below explains why.

## What Sentinel defends against

| Hook | Matcher | Purpose |
| --- | --- | --- |
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | Deny reads of secret-bearing paths |
| `PreToolUse` | `Bash` | Block shell commands that exfiltrate the same paths via `cat`/`grep`/`sed`/pipes |
| `PreToolUse` | `Bash` | Verify package install commands against live registries (npm, PyPI, crates.io) |
| `PostToolUse` | `Bash\|Read\|Grep` | Scrub high-entropy strings and token prefixes from tool output |
| `SessionStart` | `startup\|resume\|clear` | One-line advisory showing blocks and near-misses since last session |
| `SessionEnd` | — | Append structured audit line to `~/.claude/sentinel/audit.jsonl` |

> **The output scrubber is a next-turn backstop, not in-turn redaction.** By the time `PostToolUse` fires, the raw tool result has already reached the model's context window and been written to the on-disk JSONL transcript. The `additionalContext` field is additive: it injects extra text into the next turn. It does not replace, mutate, or erase what the model already saw. So the scrubber stops a leaked credential from being re-quoted or memorised in later turns. It does not stop the raw value from reaching the model in this turn. For true in-turn prevention, you want the `PreToolUse` path-deny rules (Sprint 03) and bash-exfil-deny rules (Sprint 04), which block the tool call before any result is produced.

## Configuration

Default rules live in `config/defaults.json`. To override, drop a `.claude/sentinel.json` in your home directory (user-level) or in the repo root (project-level). Project overrides beat user overrides, which beat defaults.

A small project override that relaxes the registry age threshold:

```json
{
  "registry": {
    "minAgeDays": 7
  }
}
```

The defaults you'll most likely want to touch:

- `paths.deny`: glob patterns for files Sentinel blocks Claude from reading.
- `bash.denyCommands`: shell commands blocked when used with denied path arguments (`cat`, `grep`, `sed`, and so on).
- `registry.minAgeDays`: packages younger than this (default 14) trigger an `ask`.
- `registry.minWeeklyDownloads`: packages with fewer downloads (default 100) trigger an `ask`.
- `scrubber.enabled`: set `false` to disable output scrubbing. You probably don't want to.

To see the effective merged config:

```
/sentinel-review config
```

## Reviewing what Sentinel has done

Every block, ask, scrub, and warn lands in `~/.claude/sentinel/audit.jsonl`. The `/sentinel-review` slash command reads it for you; you don't need to open the raw JSONL.

```
/sentinel-review             # 7-day summary (block/ask/scrub/warn counts)
/sentinel-review recent 10   # last 10 entries, newest first
/sentinel-review config      # effective config with per-key source attribution
```

**Where the audit log lives.** Sentinel resolves the audit path in this order: explicit `config.audit.path`, then `$CLAUDE_PLUGIN_DATA/audit.jsonl` (which Claude Code sets automatically when it invokes plugin hooks), then a fallback at `~/.claude/sentinel/audit.jsonl`. The hook writer picks one of those per-invocation based on the env it runs under. To keep `/sentinel-review` accurate when the writer and reader run under different environments (the live plugin hook has `$CLAUDE_PLUGIN_DATA` set; the Bash-tool child running the CLI does not), the writer also drops a sidecar pointer at `~/.claude/sentinel/.audit-path`. The CLI reads that pointer and includes the discovered path in its scan. Stale pointers (left by tests that cleaned up their temp dirs) get filtered by an `existsSync` gate. Use `/sentinel-review` rather than reading the JSONL directly. The CLI discovers and merges across all live and historical audit files for you.

For a forensic report on a flagged entry, hand it to the investigator subagent:

```
/agent sentinel-investigator
```

**Mode A, package investigation:**
> Investigate the npm package `lod4sh` version `4.17.21`

**Mode B, leak investigation** (use the `id` from your audit log):
> Investigate audit entry `01HZ9K3V2P8QRMX4TNYW5D6J7B`, my secret prefix is `ghp_Ab`

The full agent instructions are in `agents/sentinel-investigator.md`.

## Cross-platform support

Sentinel is first-class on macOS (14+) and Linux (Ubuntu 22.04+, Debian 12+). All path handling goes through Node's `node:path` and `node:os` modules; there are no platform-specific shell scripts in the repo.

Windows is supported via WSL only. PowerShell's `${CLAUDE_PLUGIN_ROOT}` expansion is unreliable for the hook entry point, so the plugin is not certified for native Windows shells. Install it inside a WSL 2 session and use the standard `make validate` and install flow above.

Node 20.10 or newer is required on every platform. The hook checks this at startup. If the Node version is too low, Sentinel fails open (allows the tool call) and prints an advisory reason explaining the version mismatch.

## Out of scope

Sentinel defends against Claude Code mis-use during a trusted session. It cannot defend against a malicious `.claude/settings.json` that registers its own hooks before Sentinel's run (CVE-2025-59536). Use `git status` to check for untrusted settings files before opening any repo.

Other non-goals for v1:

- Defending against a compromised Node.js binary or OS-level rootkit.
- Replacing a secrets-scanning CI step (think `git-secrets`, `trufflehog`). Sentinel is a runtime backstop, not a pre-commit gate.
- Network-egress filtering beyond registry package verification.

## Debugging Sentinel

When you're poking at Sentinel's behaviour from inside a running Claude Code session, run one shell command per `Bash` tool call. The bash-walker tokenises the whole compound command before path-matching, so a quoted wrapper string that just *mentions* a denied path can trigger the deny rule even when no actual file would be read at runtime:

```bash
# Denied. The walker sees ".env" inside the echo argument and treats
# the whole compound command as touching a secret:
echo "testing cat .env behaviour"; node script.mjs

# The same two calls in isolation both succeed:
echo "testing cat behaviour"
node script.mjs
```

The asymmetry is intentional. `paths.deny` patterns match permissively (`**/.env.*` matches any token containing `.env.` plus trailing characters). `paths.allow` patterns match exactly (`**/.env.test` requires the token to end in `.env.test`). Deny stays paranoid, allow stays precise. That's the right trade-off for a security tool, even when it's confusing while you're meta-debugging Sentinel itself.

If you want to inspect a hook decision against a specific event, use dry-run mode instead of crafting bash invocations that mention denied paths:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env.test"},"cwd":"/path/to/project"}' \
  | node src/sentinel/hook.mjs PreToolUse --dry-run
```

## Data refresh

The investigator agent's typosquat check compares a candidate package name against bundled lists of the 500 most-downloaded packages per ecosystem (`src/sentinel/data/top_packages_{npm,pypi,crates}.json`). Those lists are static snapshots that ship with the plugin. They go stale over time and need to be refreshed.

### Automatic cadence

A GitHub Actions workflow (`.github/workflows/refresh-top-packages.yml`) runs on the first of every month at 06:00 UTC. If any of the three data files changed, the workflow opens a pull request with branch name `chore/refresh-top-packages-<run_number>` for human review. Nothing gets committed automatically without a PR.

The workflow also accepts a manual trigger from the Actions UI (`workflow_dispatch`).

### Manual fallback

To refresh the data locally without waiting for the monthly cron:

```bash
make refresh-data
```

Or the equivalent:

```bash
node scripts/refresh_top_packages.mjs
```

Each run fetches the current top-500 lists from upstream sources (npm download stats, PyPI top-30-days JSON, crates.io downloads API), normalises each list (lowercase, deduplicated, sorted), and writes the result atomically to `src/sentinel/data/`. It prints a summary line per ecosystem on success.

### What the data is used for

`agents/sentinel-investigator.md` (Mode A, step 3, typosquat distance check) computes the Levenshtein distance between the candidate package name and every name in the relevant ecosystem's bundled list. A distance of 1 or 2 from a popular package name gets flagged as a potential typosquat. The bundled lists are also used by `src/sentinel/levenshtein.mjs` in unit tests.
