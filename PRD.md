# Sentinel — Product Requirements Document

**Status:** Draft v2 (Node stack)
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

## 4. Tech Stack

The plugin is a **Node.js project with zero runtime dependencies**. The "zero deps" stance is a deliberate security posture: a defensive plugin should not itself widen the supply-chain attack surface.

| Layer | Choice | Rationale |
| --- | --- | --- |
| Runtime | **Node.js ≥ 20.10 LTS** | Stable global `fetch`, `node:test` runner, ESM-by-default, `AbortSignal.timeout()` for the 250 ms registry budget. macOS/Linux/Windows-compatible. |
| Module format | **ESM (`.mjs`)** | No build step, no transpiler, no `package.json` `"type"` ambiguity. Hook entry runs as `node src/sentinel/hook.mjs <event>`. |
| HTTP | Stdlib `fetch` + `AbortSignal.timeout(250)` | No `axios` / `node-fetch` dep. |
| Shell tokenizer | **Vendored** minimal POSIX-shell tokenizer in `src/sentinel/lib/shell.mjs` (~150 LOC) | Avoids `shell-quote`; the patterns we care about (`;`, `&&`, `||`, `|`, redirects, quoted strings) are bounded. |
| Glob matcher | **Vendored** minimal glob-to-RegExp in `src/sentinel/lib/glob.mjs` (~80 LOC) | Supports `**`, `*`, `?`, character classes — enough for the path-deny list. Avoids `picomatch`/`minimatch`. |
| Levenshtein / Shannon entropy | Vendored — both are < 30 LOC each | Pure functions, no dep needed. |
| Config format | **JSON** (`.claude/sentinel.json` / `~/.claude/sentinel.json`) | Node has no stdlib TOML parser; JSON is universally available and matches existing Claude Code config conventions. |
| Test runner | Built-in `node:test` | Zero dev-dep overhead; `node --test tests/` works on a fresh clone. |
| Package manager | **None at runtime.** Dev-only `package.json` declares `"type": "module"` and dev scripts; no `dependencies`. Optional `devDependencies` only if a linter is added later. | Fresh clone → `node --test tests/` works with no `npm install`. |
| Audit log | JSONL appended via `fs.promises.appendFile` | Stdlib only. |

**Floor versions are non-negotiable:** Node ≥ 20.10 ensures `fetch`, `node:test`, and `AbortSignal.timeout` are all stable. Older Node will be rejected by the hook's preamble with a clear upgrade message.

## 5. Plugin Shape

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
│   ├── hook.mjs                 # single Node entry point for all hook events
│   ├── paths.mjs                # secret-path glob matching
│   ├── bash.mjs                 # shell command walker (uses lib/shell.mjs)
│   ├── registry.mjs             # npm / PyPI / crates.io live checks via fetch
│   ├── scrubber.mjs             # output redaction
│   ├── audit.mjs                # JSONL writer
│   ├── config.mjs               # JSON loader (user + project merge)
│   ├── defaults.json            # shipped defaults
│   ├── data/
│   │   ├── top_packages_npm.json
│   │   ├── top_packages_pypi.json
│   │   └── top_packages_crates.json
│   └── lib/
│       ├── shell.mjs            # vendored POSIX-shell tokenizer
│       ├── glob.mjs             # vendored glob matcher
│       ├── levenshtein.mjs
│       └── entropy.mjs
├── tests/
│   ├── fixtures/                # 30+ known-bad payloads as JSON files
│   └── *.test.mjs               # node:test files
├── package.json                 # "type": "module", scripts only — no deps
├── Makefile                     # `make validate`, `make test`, `make demo`
├── PRD.md
└── README.md
```

## 6. Component 1 — The Hook (`hooks/sentinel.json` + `src/sentinel/hook.mjs`)

One config file, one Node entry script, multiple matchers. All matchers exec the same script with the event name; the script dispatches internally via `process.argv[2]`.

### 6.1 Matchers

| Event | Matcher | Purpose | Latency budget |
| --- | --- | --- | --- |
| `PreToolUse` | `Read\|Edit\|Grep\|Glob\|NotebookEdit` | Block reads of secret-bearing paths | < 20 ms |
| `PreToolUse` | `Bash` | Block shell-based exfil of same paths | < 50 ms |
| `PreToolUse` | `Bash` (install commands) | Live registry check for hallucinated/risky packages | < 300 ms (timeout-bounded) |
| `PostToolUse` | `Bash\|Read\|Grep\|Glob` | Scrub high-entropy strings and known token prefixes from `tool_response` | < 30 ms |
| `SessionStart` | `startup\|resume\|clear` | One-line advisory banner with running stats | < 20 ms |
| `SessionEnd` | — | Finalize audit entries | < 20 ms |

Node startup cost (~30 ms cold) is part of every budget; the entry script is intentionally small and avoids dynamic `import()` so the V8 parse cost stays predictable.

### 6.2 Path-deny defaults

Loaded from `.claude/sentinel.json`; defaults shipped in `src/sentinel/defaults.json`.

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

### 6.3 Bash AST walker (`src/sentinel/bash.mjs`)

Vendored tokenizer (`lib/shell.mjs`) → walk tokens splitting on `;`, `&&`, `||`, `|`, `&`. For each segment:

- **Hard deny:** command in `{cat, head, tail, less, more, bat, view, xxd, hexdump, base64}` reading a secret path.
- **Hard deny:** `grep`, `rg`, `awk`, `sed`, `perl`, `python -c`, `node -e` reading a secret path unless the only output is a count (`grep -c`, `wc -l`).
- **Hard deny:** redirection of a secret path into anything that prints, pipes, or copies (`cat .env | pbcopy`, `cp .env /tmp/x`).
- **Allow:** value-stripping ops — `wc`, `file`, `stat`, `ls -la`, `du`, `shasum`, `sha256sum`.
- **Install-command branch:** see §6.4.

### 6.4 Registry check (`src/sentinel/registry.mjs`)

When the bash walker sees `npm install <X>`, `pnpm add <X>`, `yarn add <X>`, `pip install <X>`, `uv add <X>`, `cargo add <X>`:

- Issue an async `fetch()` with `AbortSignal.timeout(250)` to:
  - npm: `https://registry.npmjs.org/<pkg>`
  - PyPI: `https://pypi.org/pypi/<pkg>/json`
  - crates.io: `https://crates.io/api/v1/crates/<pkg>`
- Decision tree:
  - **Doesn't exist** → `deny` ("package not found in registry — likely hallucinated").
  - **Created < 14 days ago** → `ask` ("very new package — confirm intent").
  - **Weekly downloads < 100** (npm/PyPI only) → `ask` ("low usage — confirm intent").
  - **No homepage, no repository field** → `ask` ("no public source — confirm intent").
  - **All checks pass** → `allow` (silent).
- LRU cache on disk at `~/.claude/sentinel/cache.json`, 1-hour TTL, keyed on `<ecosystem>:<name>`. Loaded synchronously at hook startup; written on exit via `fs.writeFileSync` (cache size is small enough that sync write is faster than spawning an async flush).
- **Network failure or timeout → `allow` with warning.** Never break offline workflows.
- Thresholds configurable per ecosystem.

### 6.5 Output scrubber (`src/sentinel/scrubber.mjs`)

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

### 6.6 Hook return shapes

The hook reads the event JSON from stdin and writes the decision to stdout. All matchers use the standard Claude Code hook envelope.

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

## 7. Component 2 — The Agent (`agents/sentinel-investigator.md`)

A real forensic analyst, not a stub. Invoked when the user wants depth beyond what the hook can decide in 300 ms.

### 7.1 Role

> Defensive security analyst specializing in software supply-chain risk and credential-leak forensics. You investigate a single artifact — a flagged package, or an audit entry where a secret was scrubbed — and produce an evidence-backed threat report with a recommendation.

### 7.2 Tools

`Read`, `Grep`, `Glob`, `WebFetch`, `Bash` (allowlist: `git log`, `git grep`, `git show`, `git remote`).

### 7.3 Mode A — Package investigation

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

### 7.4 Mode B — Leak investigation

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
4. **Preventive recommendations** — concrete config edits to `.claude/sentinel.json` and/or `.gitignore` that would have prevented this entry.

Output: severity, blast-radius classification, ordered remediation checklist (most urgent first), preventive config diff.

### 7.5 Acceptance for "meaningful work"

For each mode, the agent must produce ≥ 5 distinct pieces of evidence from ≥ 2 data sources. A report that says "package looks fine" with no evidence fails the bar.

## 8. Component 3 — The Skill (`commands/sentinel-review.md`)

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

`test` is critical: it lets users debug a misconfigured allowlist without triggering a real block. It invokes `node src/sentinel/hook.mjs PreToolUse --dry-run` under the hood.

The skill is implemented as a markdown command file with branching logic; sub-commands that need agent work delegate via the Task tool to `sentinel-investigator`.

## 9. Configuration (`.claude/sentinel.json`)

Two-layer merge: `~/.claude/sentinel.json` (user defaults) ← `.claude/sentinel.json` (project overrides). Project wins. Unknown keys are preserved (forward-compat).

```json
{
  "paths": {
    "deny": ["**/.env", "**/.env.*", "**/credentials*.json"],
    "allow": ["**/.env.example", "**/.env.sample", "**/.env.template"]
  },
  "bash": {
    "denyCommands": ["cat", "head", "tail", "less", "more", "bat", "view", "xxd", "hexdump", "base64"],
    "warnCommands": ["grep", "rg", "awk", "sed"],
    "allowValueStripping": true
  },
  "registry": {
    "enabled": true,
    "timeoutMs": 250,
    "minAgeDays": 14,
    "minWeeklyDownloads": 100,
    "requireHomepage": true,
    "cacheTtlHours": 1
  },
  "ecosystems": {
    "npm": true,
    "pypi": true,
    "crates": true,
    "rubygems": false,
    "go": false
  },
  "scrubber": {
    "enabled": true,
    "extraPatterns": []
  },
  "audit": {
    "path": "~/.claude/sentinel/audit.jsonl",
    "maxSizeMb": 50
  }
}
```

## 10. Audit log schema (`~/.claude/sentinel/audit.jsonl`)

One JSON object per line:

```json
{
  "id": "01J...",
  "ts": "2026-05-10T14:32:11Z",
  "session_id": "...",
  "cwd": "/Users/.../some-project",
  "event": "block|ask|scrub|warn",
  "hook": "PreToolUse|PostToolUse",
  "tool": "Read|Bash|Grep|...",
  "rule": "paths.deny|bash.exfil|registry.missing|scrubber.github_pat|...",
  "matched": "**/.env",
  "input_summary": "Read /Users/.../.env",
  "decision": "deny|ask|allow",
  "metadata": { "package": "huggingface-cli-utils", "ecosystem": "pypi", "age_days": 6 }
}
```

`id` is a ULID generated via a small vendored ULID helper. Input is *summarized*, never logged verbatim, to avoid the audit log itself becoming a leak channel.

## 11. Install & Validation

### 11.1 Install (README front-matter)

```bash
# Prereq: Node.js >= 20.10 (check with: node --version)

# 1. Clone
git clone https://github.com/gltorres/claude-code-sentinel.git
cd claude-code-sentinel

# 2. Validate before installing
make validate

# 3. Install into Claude Code
/plugin install ./claude-code-sentinel
```

No `npm install` step. The project has no runtime dependencies.

### 11.2 `make validate` — must pass on a fresh clone

- `node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json"))'` (manifest is valid JSON)
- `node -e 'JSON.parse(require("fs").readFileSync("hooks/sentinel.json"))'` (hook config is valid JSON)
- `node src/sentinel/hook.mjs --self-test` runs:
  - Asserts Node version ≥ 20.10
  - Loads default config without error
  - Runs 30+ fixture payloads from `tests/fixtures/` through each hook event and asserts the expected decision
  - Exits 0 only if all fixtures match
- `node --test tests/` (offline tests; registry tests stub `globalThis.fetch`)

### 11.3 Demo (`make demo`)

A scripted Claude Code session that:
1. Asks Claude to `cat .env` → demonstrates `deny`.
2. Asks Claude to `pip install huggingface-cli-utils` (a real slopsquat target) → demonstrates `ask` with reason.
3. Returns a synthetic `tool_response` containing `sk-ant-abc123…` → demonstrates scrubbing.
4. Runs `/sentinel-review` → shows the three audit entries.

This is the artifact for README / launch tweet.

## 12. Risks & Open Questions

| Risk | Mitigation |
| --- | --- |
| False positives on `.env.example` legitimately read by Claude | Default allowlist includes `.env.example`, `.env.sample`, `.env.template`; project config can extend. |
| Node startup cost (~30 ms) blows the latency budget | Entry script kept small; no dynamic `import()`; cache file read synchronously once. Budgeted in §6.1. |
| Registry checks slow down every install command | 250 ms per-package timeout via `AbortSignal.timeout`; on-disk LRU cache; network failure falls through to `allow` with warning. |
| User disables Sentinel after one annoying false positive | Errors include the exact rule and a one-line edit to disable it; `/sentinel-review test` lets them debug without triggering a real block. |
| PostToolUse scrubber can't un-write the JSONL for the *current* tool call | Documented as known limitation; PreToolUse is the primary defense. |
| Top-package list for typosquat detection goes stale | Refresh script in `tools/refresh_top_packages.mjs`; CI runs monthly. |
| User on Node < 20.10 | Hook preamble checks `process.versions.node` and emits a clear `permissionDecisionReason` pointing to the upgrade path; defaults to `allow` (fail-open) so it never bricks a session. |

Open questions to resolve before v1:

- Should the audit log live at `~/.claude/sentinel/` or inside the project's `.claude/` directory? **Tentative:** user-level by default, project-level if `.claude/sentinel.json` overrides `audit.path`.
- Should typosquat detection ship a baked-in top-500 list or fetch at install time? **Tentative:** ship baked-in for offline determinism; refresh via `make refresh-data`.

## 13. Success Criteria (v1 launch)

1. `make validate` passes from a fresh clone with no setup beyond a working Node ≥ 20.10.
2. All 30+ fixture payloads block/ask/allow as expected.
3. Demo session (§11.3) runs end-to-end on macOS and Linux.
4. Plugin loads in Claude Code with no schema errors visible in the session.
5. `sentinel-investigator` produces a report with ≥ 5 evidence points in both modes on the demo inputs.
6. README install instructions reproduce on a colleague's fresh machine in < 5 minutes.
7. `node --test tests/` runs green with zero `npm install` invocations.
