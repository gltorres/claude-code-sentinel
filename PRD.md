# Sentinel — Product Requirements Document

**Status:** Draft v1
**Owner:** @gltorres
**Target:** Claude Code plugin marketplace, week-1 launch

---

## 1. Problem

Three recurring Claude Code horror stories in 2025–2026, all reproducible today:

1. **Silent secret reads.** Claude `cat`s / `Read`s `.env`, `~/.aws/credentials`, SSH keys, etc. The value enters the JSONL transcript and the next LLM turn — exfiltrated to the API and persisted on disk. (refs: agentfluent #72, Knostic write-up, anthropics/claude-code #44868).
2. **Credentials in chat output.** A grep, an env-var dump, or a `kubectl describe` puts a live token into the tool response. Same exfil path.
3. **Slopsquatted packages.** Claude hallucinates a package name; an attacker has already registered it on npm/PyPI. `npm install <name>` ships malware. (refs: Trend Micro, Socket, Snyk 2025–2026 reports.)

None of these are fixed by Claude Code's built-in permission system: the user is asked once, says "Allow always for Bash", and the airbag deflates.

## 2. Goals

- Block the three classes above **at the hook layer**, before the value reaches the model or the disk.
- Make blocks **visible** — users see what was prevented and why, so they understand they're being protected (not nagged).
- Provide **on-demand forensic depth** when a block needs investigation (was a secret already leaked? is this package a typosquat of `requests`?).
- Install from a fresh clone with a single `/plugin install` step; validate cleanly without external infrastructure.

## 3. Non-Goals

- Not a static-analysis tool for generated code (Anthropic's own code-review plugin already covers `eval`/`pickle` patterns).
- Not a runtime sandbox or seccomp filter.
- Not a replacement for `gitleaks` or `detect-secrets` in CI — Sentinel operates inside the Claude Code session, not the repo.
- No telemetry beyond the local audit log. No phone-home.

## 4. Plugin Shape

The plugin ships **one hook, one agent, one skill** — no MCP. Each component has a single, clear job.

```
claude-code-sentinel/
├── .claude-plugin/
│   └── plugin.json              # manifest
├── hooks/
│   └── sentinel.json            # hook config — registers all matchers against one entry script
├── agents/
│   └── sentinel-investigator.md # the forensic agent
├── commands/
│   └── sentinel-review.md       # the /sentinel-review skill
├── src/sentinel/
│   ├── hook.py                  # single Python entry point for all hook events
│   ├── paths.py                 # secret-path glob matching
│   ├── bash.py                  # shlex-based shell command walker
│   ├── registry.py              # npm / PyPI / crates.io live checks
│   ├── scrubber.py              # output redaction
│   ├── audit.py                 # JSONL writer
│   └── config.py                # TOML loader (user + project overrides)
├── tests/
│   ├── fixtures/                # 30+ known-bad payloads
│   └── test_*.py
├── Makefile                     # `make validate`, `make test`, `make demo`
├── PRD.md
└── README.md
```

## 5. Component 1 — The Hook (`hooks/sentinel.json` + `src/sentinel/hook.py`)

One config file, one Python entry script, multiple matchers. All matchers exec the same script with the event name; the script dispatches internally.

### 5.1 Matchers

| Event | Matcher | Purpose | Latency budget |
| --- | --- | --- | --- |
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | Block reads of secret-bearing paths | < 20 ms |
| `PreToolUse` | `Bash` | Block shell-based exfil of same paths | < 50 ms |
| `PreToolUse` | `Bash` (install commands) | Live registry check for hallucinated/risky packages | < 300 ms (timeout-bounded) |
| `PostToolUse` | `Bash\|Read\|Grep\|Glob` | Scrub high-entropy strings and known token prefixes from `tool_response` | < 30 ms |
| `SessionStart` | `startup\|resume\|clear` | One-line advisory banner with running stats | < 20 ms |
| `SessionEnd` | — | Finalize audit entries | < 20 ms |

### 5.2 Path-deny defaults

Loaded from `.claude/sentinel.toml`; defaults shipped in `src/sentinel/defaults.toml`.

```
**/.env, **/.env.*  (with allowlist exceptions for .env.example, .env.sample, .env.template)
**/.envrc
**/credentials*.json
**/secrets*.y?ml
**/.bashrc, **/.zshrc, **/.profile, **/.bash_profile
**/*.pem, **/*.key  (allowlist: **/*.pub, **/*.public.*)
**/.aws/credentials, **/.aws/config
**/.kube/config
**/.ssh/id_*  (excluding *.pub)
**/.npmrc, **/.pypirc, **/.git-credentials
**/.netrc
```

### 5.3 Bash AST walker (`src/sentinel/bash.py`)

`shlex.split` → walk tokens splitting on `;`, `&&`, `||`, `|`, `&`. For each segment:

- **Hard deny:** command in `{cat, head, tail, less, more, bat, view, xxd, hexdump, base64}` reading a secret path.
- **Hard deny:** `grep`, `rg`, `awk`, `sed`, `perl`, `python -c` reading a secret path unless the only output is a count (`grep -c`, `wc -l`).
- **Hard deny:** redirection of a secret path into anything that prints, pipes, or copies (`cat .env | pbcopy`, `cp .env /tmp/x`).
- **Allow:** value-stripping ops — `wc`, `file`, `stat`, `ls -la`, `du`, `shasum`.
- **Install-command branch:** see §5.4.

### 5.4 Registry check (`src/sentinel/registry.py`)

When the bash walker sees `npm install <X>`, `pnpm add <X>`, `yarn add <X>`, `pip install <X>`, `uv add <X>`, `cargo add <X>`:

- Issue an async HTTP GET with **250 ms timeout** to:
  - npm: `https://registry.npmjs.org/<pkg>`
  - PyPI: `https://pypi.org/pypi/<pkg>/json`
  - crates.io: `https://crates.io/api/v1/crates/<pkg>`
- Decision tree:
  - **Doesn't exist** → `deny` ("package not found in registry — likely hallucinated").
  - **Created < 14 days ago** → `ask` ("very new package — confirm intent").
  - **Weekly downloads < 100** (npm/PyPI only) → `ask` ("low usage — confirm intent").
  - **No homepage, no repository field** → `ask` ("no public source — confirm intent").
  - **All checks pass** → `allow` (silent).
- LRU cache on disk at `~/.claude/sentinel/cache.json`, 1-hour TTL, keyed on `(ecosystem, name)`.
- **Network failure → `allow` with warning.** Never break offline workflows.
- Thresholds configurable per ecosystem.

### 5.5 Output scrubber (`src/sentinel/scrubber.py`)

PostToolUse only. Replaces matches with `<REDACTED:<family>>`. Families:

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
| `high_entropy` | Shannon entropy > 4.5 on contiguous strings of length ≥ 24 (after the family scan) |

**Known limitation:** scrubbing PostToolUse output cannot un-write the value already in the on-disk JSONL transcript for *that* tool call. The PreToolUse layer is the primary defense; the scrubber stops the value from reaching the *next* LLM turn (the exfil-to-API path). This is documented in README and the SessionStart banner.

### 5.6 Hook return shapes

PreToolUse deny:
```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Sentinel: read of **/.env blocked by rule [paths.deny]"
}}
```

PreToolUse ask:
```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Sentinel: package `huggingface-cli-utils` was created 6 days ago with 12 weekly downloads. Confirm before installing."
}}
```

PostToolUse scrub:
```json
{ "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<scrubbed tool output>"
}}
```

## 6. Component 2 — The Agent (`agents/sentinel-investigator.md`)

A real forensic analyst, not a stub. Invoked when the user wants depth beyond what the hook can decide in 300 ms.

### 6.1 Role

> Defensive security analyst specializing in software supply-chain risk and credential-leak forensics. You investigate a single artifact — a flagged package, or an audit entry where a secret was scrubbed — and produce an evidence-backed threat report with a recommendation.

### 6.2 Tools

`Read`, `Grep`, `Glob`, `WebFetch`, `Bash` (allowlist: `git log`, `git grep`, `git show`, `git remote`).

### 6.3 Mode A — Package investigation

Inputs: `ecosystem` (`npm` / `pypi` / `crates`), `package_name`, optional `version`.

The agent must do all of the following — each one is a separate concrete step, none are optional:

1. **Registry metadata** — fetch the registry record. Pull creation date, latest version, version count, maintainer email/handle, homepage, repository URL, license.
2. **Repository health** (if repo URL present) — fetch GitHub/GitLab API for stars, age, last commit, open issues, default branch, presence of `SECURITY.md`. Inspect the most recent commit message and a diff sample.
3. **Typosquat distance** — compute Levenshtein distance against a bundled list of top-500 packages per ecosystem (shipped in `src/sentinel/data/top_packages_*.json`). Flag distance ≤ 2 from a popular name.
4. **Install-script inspection** — for npm packages, fetch the tarball and inspect `package.json` for `scripts.preinstall`, `scripts.install`, `scripts.postinstall`. Any presence is suspicious for a non-native-binding package.
5. **Maintainer profile** — count of other packages by the same publisher; account age. New publisher + first package = elevated risk.
6. **Risk scoring** — combine the above into `low` / `medium` / `high` / `critical` with a written justification citing specific evidence (no vague "looks suspicious").
7. **Recommendation** — `install`, `install with caution after pinning version X.Y.Z`, or `do not install`, plus a one-line rationale.

Output: structured markdown report with sections for each step above and a final boxed recommendation.

### 6.4 Mode B — Leak investigation

Inputs: an audit-log entry ID where `event == "scrub"`.

Steps:

1. **Classify** the secret family from the redaction tag.
2. **Local blast-radius scan**:
   - `git grep` for the redacted prefix across the working tree and all branches.
   - Search prior Claude Code transcripts in `~/.claude/projects/*/conversations/*.jsonl` for the same prefix (pre-scrub instances).
   - Report: in-memory only / transcript-only / committed-to-current-branch / pushed-to-remote.
3. **Remediation checklist** — emit family-specific revocation steps with exact URLs:
   - `github_pat` → `https://github.com/settings/tokens` + `gh auth refresh`
   - `aws_akid` → IAM console URL + `aws iam delete-access-key` command
   - `stripe_live` → `https://dashboard.stripe.com/apikeys`
   - `slack` → workspace admin URL pattern
   - `anthropic` → `https://console.anthropic.com/settings/keys`
   - …and a generic fallback for unknown families.
4. **Preventive recommendations** — concrete config edits to `.claude/sentinel.toml` and/or `.gitignore` that would have prevented this entry.

Output: severity, blast-radius classification, ordered remediation checklist (most urgent first), preventive config diff.

### 6.5 Acceptance for "meaningful work"

For each mode, the agent must produce ≥ 5 distinct pieces of evidence from ≥ 2 data sources. A report that says "package looks fine" with no evidence fails the bar.

## 7. Component 3 — The Skill (`commands/sentinel-review.md`)

A single dispatcher slash command. The user's entry point.

```
/sentinel-review                       → summary view (totals by category, last 7 days)
/sentinel-review recent [N]            → last N audit entries with timestamps and reasons
/sentinel-review investigate <id>      → invoke sentinel-investigator agent on entry <id>
/sentinel-review investigate-pkg <eco> <name>
                                       → invoke agent in package mode directly
/sentinel-review test <command>        → dry-run the hook against a synthetic Bash/Read input
/sentinel-review config                → show effective merged config (user + project)
```

`test` is critical: it lets users debug a misconfigured allowlist without triggering a real block.

The skill is implemented as a markdown command file with branching logic; sub-commands that need agent work delegate via the Task tool to `sentinel-investigator`.

## 8. Configuration (`.claude/sentinel.toml`)

Two-layer merge: `~/.claude/sentinel.toml` (user defaults) ← `.claude/sentinel.toml` (project overrides). Project wins.

```toml
[paths]
deny = ["**/.env", "**/.env.*", "**/credentials*.json", ...]
allow = ["**/.env.example", "**/.env.sample", "**/.env.template"]

[bash]
deny_commands = ["cat", "head", "tail", "less", "more", "bat", "view", "xxd", "hexdump", "base64"]
warn_commands = ["grep", "rg", "awk", "sed"]
allow_value_stripping = true

[registry]
enabled = true
timeout_ms = 250
min_age_days = 14
min_weekly_downloads = 100
require_homepage = true
cache_ttl_hours = 1

[ecosystems]
npm = true
pypi = true
crates = true
rubygems = false
go = false

[scrubber]
enabled = true
extra_patterns = []     # list of {name, regex}

[audit]
path = "~/.claude/sentinel/audit.jsonl"
max_size_mb = 50        # rotate at this size
```

## 9. Audit log schema (`~/.claude/sentinel/audit.jsonl`)

One JSON object per line:

```json
{
  "id": "01J...",                 // ULID
  "ts": "2026-05-10T14:32:11Z",
  "session_id": "...",
  "cwd": "/Users/.../some-project",
  "event": "block|ask|scrub|warn",
  "hook": "PreToolUse|PostToolUse",
  "tool": "Read|Bash|Grep|...",
  "rule": "paths.deny|bash.exfil|registry.missing|scrubber.github_pat|...",
  "matched": "**/.env",           // glob or pattern that fired
  "input_summary": "Read /Users/.../.env",
  "decision": "deny|ask|allow",
  "metadata": { "package": "huggingface-cli-utils", "ecosystem": "pypi", "age_days": 6, ... }
}
```

Input is *summarized*, never logged verbatim, to avoid the audit log itself becoming a leak channel.

## 10. Install & Validation

### 10.1 Install (README front-matter)

```bash
# 1. Clone
git clone https://github.com/gltorres/claude-code-sentinel.git
cd claude-code-sentinel

# 2. Validate before installing
make validate

# 3. Install into Claude Code
/plugin install ./claude-code-sentinel
```

### 10.2 `make validate` — must pass on a fresh clone

- `python -m json.tool .claude-plugin/plugin.json` (manifest is valid JSON)
- `python -m json.tool hooks/sentinel.json` (hook config is valid JSON)
- `python -m sentinel.hook --self-test` runs:
  - Loads default config without error
  - Runs 30+ fixture payloads from `tests/fixtures/` through each hook event and asserts the expected decision
  - Exits 0 only if all fixtures match
- `pytest tests/` (offline tests; registry tests use stubbed HTTP)

### 10.3 Demo (`make demo`)

A scripted Claude Code session that:
1. Asks Claude to `cat .env` → demonstrates `deny`.
2. Asks Claude to `pip install huggingface-cli-utils` (a real slopsquat target) → demonstrates `ask` with reason.
3. Returns a synthetic `tool_response` containing `sk-ant-abc123…` → demonstrates scrubbing.
4. Runs `/sentinel-review` → shows the three audit entries.

This is the artifact for README / launch tweet.

## 11. Risks & Open Questions

| Risk | Mitigation |
| --- | --- |
| False positives on `.env.example` legitimately read by Claude | Default allowlist includes `.env.example`, `.env.sample`, `.env.template`; project config can extend. |
| Registry checks slow down every install command | 250 ms per-package timeout; on-disk LRU cache; network failure falls through to `allow` with warning. |
| User disables Sentinel after one annoying false positive | Errors include the exact rule and a one-line edit to disable it; `/sentinel-review test` lets them debug without triggering a real block. |
| PostToolUse scrubber can't un-write the JSONL for the *current* tool call | Documented as known limitation; PreToolUse is the primary defense. |
| Top-package list for typosquat detection goes stale | Refresh script in `tools/refresh_top_packages.py`; CI runs monthly. |

Open questions to resolve before v1:

- Should the audit log live at `~/.claude/sentinel/` or inside the project's `.claude/` directory? **Tentative:** user-level by default, project-level if `.claude/sentinel.toml` overrides `audit.path`.
- Should typosquat detection ship a baked-in top-500 list or fetch at install time? **Tentative:** ship baked-in for offline determinism; refresh via `make refresh-data`.

## 12. Success Criteria (v1 launch)

1. `make validate` passes from a fresh clone with zero external setup beyond `python3` and `pip install -r requirements.txt`.
2. All 30+ fixture payloads block/ask/allow as expected.
3. Demo session (§10.3) runs end-to-end on macOS and Linux.
4. Plugin loads in Claude Code with no schema errors visible in the session.
5. `sentinel-investigator` produces a report with ≥ 5 evidence points in both modes on the demo inputs.
6. README install instructions reproduce on a colleague's fresh machine in < 5 minutes.
