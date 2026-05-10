# Sprint 08: Forensic Investigator Agent

**Band**: agent · **Blocked by**: 02

## Goal
When the hook's 300 ms budget says "ask" or "scrub" but the user wants depth, the investigator agent takes a single artifact — a flagged package or a scrubbed audit entry — and produces an evidence-backed threat report with a concrete recommendation. This is the difference between a plugin that nags and a plugin that explains.

## What we're building
A subagent definition at `agents/sentinel-investigator.md` with two modes, plus the bundled typosquat data the package mode needs.

**Mode A — Package investigation.** Inputs: ecosystem (`npm | pypi | crates`), package name, optional version. The agent must execute every one of the following — each step produces evidence, none are optional:

1. Registry metadata fetch — creation date, latest version, version count, maintainer email/handle, homepage, repository URL, license.
2. Repository health (if a repo URL is present) — stars, age, last commit, open issues, default branch, presence of `SECURITY.md`, most-recent-commit message + diff sample.
3. Typosquat distance — Levenshtein distance against the bundled top-500 list for the ecosystem; flag distance ≤ 2 from a popular name.
4. Install-script inspection (npm only) — fetch the tarball, inspect `package.json` for `scripts.preinstall | install | postinstall`. Any presence is suspicious for a non-native-binding package.
5. Maintainer profile — count of other packages by the same publisher; account age. New publisher + first package = elevated risk.
6. Risk scoring — `low | medium | high | critical` with a written justification citing specific evidence above. "Looks suspicious" without specifics fails the bar.
7. Recommendation — `install`, `install with caution after pinning version X.Y.Z`, or `do not install`, with a one-line rationale.

**Mode B — Leak investigation.** Input: an audit-log entry ID where `event == "scrub"`. Steps:

1. Classify the secret family from the redaction tag.
2. Local blast-radius scan — `git grep` for the redacted prefix across the working tree and all branches; search prior Claude Code transcripts at `~/.claude/projects/*/conversations/*.jsonl` for the same prefix. Report: in-memory only / transcript-only / committed-to-current-branch / pushed-to-remote.
3. Remediation checklist — family-specific revocation steps with exact URLs (see Context below).
4. Preventive recommendations — concrete edits to `.claude/sentinel.json` and/or `.gitignore` that would have caught this entry earlier.

**Bundled data.** Top-500 most-installed packages per ecosystem in `src/sentinel/data/top_packages_npm.json`, `top_packages_pypi.json`, `top_packages_crates.json`. Shipped baked-in for offline determinism. A refresh script at `tools/refresh_top_packages.mjs` regenerates them; the README documents `make refresh-data`.

## Acceptance criteria
1. Mode A on a known slopsquat target (e.g. a fictional `huggingface-cli-utils`) produces a markdown report with all 7 sections populated, ≥ 5 distinct evidence points drawn from ≥ 2 data sources, and a concrete final recommendation.
2. Mode B on an audit-log entry with `event: scrub, rule: scrubber.github_pat` produces severity, blast-radius classification, an ordered remediation checklist (most-urgent first) with the GitHub-PAT-specific URLs, and a preventive config diff.
3. Both modes refuse to emit "looks fine" with no evidence — the agent's instructions explicitly fail that bar.
4. Top-500 JSON files exist and parse for all three ecosystems.
5. `tools/refresh_top_packages.mjs` regenerates each list and the output is valid JSON.

## Context & constraints

**Agent frontmatter.** Required fields are `name` and `description` only. Use the `tools` field as an allowlist — anything not listed is unavailable to the agent. Other frontmatter fields available to user-installed agents (`hooks`, `mcpServers`, `permissionMode`) are silently ignored when the agent ships from a plugin path, so don't depend on them.

**Tool allowlist** (PRD §7.2): `Read`, `Grep`, `Glob`, `WebFetch`, `Bash`. For Bash, restrict to: `git log`, `git grep`, `git show`, `git remote`. The investigator must not be able to install packages, modify files, or run arbitrary shell.

**Evidence bar.** Each mode must produce ≥ 5 distinct evidence points from ≥ 2 data sources. The agent instructions must make this non-negotiable so the model doesn't shortcut a hallucinated package as "looks fine".

**Remediation URLs** (Mode B — these are user-actionable and must be exact):

| Family | Action |
| --- | --- |
| `github_pat` | https://github.com/settings/tokens · `gh auth refresh` |
| `aws_akid` | IAM console URL · `aws iam delete-access-key` |
| `stripe_live` | https://dashboard.stripe.com/apikeys |
| `slack` | workspace admin URL pattern (`https://<workspace>.slack.com/admin/integrations`) |
| `anthropic` | https://console.anthropic.com/settings/keys |
| `openai` | https://platform.openai.com/api-keys |
| (other) | generic fallback — "rotate via the issuing service's API key dashboard" |

**Typosquat lists.** Top-500 per ecosystem, refreshed by a script in `tools/`. Shipped baked-in for offline determinism and reproducibility. PRD §12 calls for CI to run the refresh monthly — wire it into a GitHub Action in this sprint or document the manual cadence.

**Vendored Levenshtein.** ~30 LOC, no dep. Distance ≤ 2 from any top-500 name is flagged.

**Output format.** Structured markdown with section headers per step. A final boxed recommendation block (Markdown code block or quote) so the user sees the verdict at a glance.

## Dependencies
- Sprint 02: Mode B reads from the audit log to pull the entry being investigated.

## Open questions
- Does the agent fetch tarballs for install-script inspection via `WebFetch` (works for npm's tarball URLs) or via a shelled `npm pack` (out of scope for the Bash allowlist)? Recommend `WebFetch` to keep the allowlist tight.
