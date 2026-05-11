# Forensic Investigator Agent Definition

**Task ID:** sprint-08-spec-05
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-05-investigator-agent-definition.md

## Overview

This feature introduces `agents/sentinel-investigator.md`, a Claude Code subagent that performs forensic investigation in two modes: Mode A investigates a flagged package for supply-chain threats using live registry and repository APIs; Mode B investigates a scrubbed audit-log entry by ID, classifying the secret family and producing a blast-radius assessment with a remediation checklist. The agent is the runtime consumer of the Levenshtein helper (spec-01), secret-family metadata (spec-02), and top-500 package data (spec-03) built earlier in Sprint 08.

## What Was Built

- `agents/sentinel-investigator.md` — 207-line agent definition with YAML frontmatter and five structured sections
- README.md "Investigator agent" section — invocation examples and `make refresh-data` reference
- Mode A: seven-step package investigation (registry metadata, repo health, typosquat distance, install-script inspection, maintainer profile, risk scoring, recommendation)
- Mode B: four-step leak investigation (locate audit entry, classify family, blast-radius scan with three strategies, remediation and prevention)
- Family→remediation table with 14 rows covering all eleven hardcoded families plus `high_entropy`, `custom`, and unknown fallback
- Structured `recommendation` fenced-block output schema for both modes

## Technical Implementation

### Files Modified

- `agents/sentinel-investigator.md`: New file; agent definition with frontmatter (`name`, `description`, `tools: Read, Grep, Glob, WebFetch, Bash`) and full body
- `README.md`: Appended "Investigator agent" section with invocation examples and `make refresh-data` line

### Key Changes

- **YAML frontmatter** declares exactly five tools (`Read, Grep, Glob, WebFetch, Bash`) and a single-sentence description; `model`, `permissionMode`, and `hooks` are intentionally omitted — Claude Code plugin-path agents only require `name` and `description`
- **Bash sub-allowlist** constrains the agent to `git log`, `git grep`, `git show`, `git remote` — all network requests go through `WebFetch`, not Bash, preventing package-manager or curl invocations inside the agent
- **Evidence bar guardrail** makes "looks fine" / "nothing suspicious" an explicit failure mode; the agent must cite ≥5 evidence points from ≥2 sources or respond with "insufficient evidence"
- **Mode B blast-radius uses three strategies in priority order**: (a) user-supplied `secret_prefix`, (b) transcript fallback via `~/.claude/projects/*/conversations/*.jsonl` filtered by `session_id`, (c) family-regex scan as last resort — each strategy must be explicitly named in the report
- **npm tarball-free inspection**: Step 4 reads the `scripts` block directly from the registry metadata JSON (`https://registry.npmjs.org/<name>/<version>`), avoiding disallowed `npm`/`tar`/`curl` in Bash
- **Risk scoring rubric**: five 0–10 categories (typosquat, install scripts, maintainer novelty, repository health, license/declarations) bucketed into `low | medium | high | critical` with corresponding `allow | warn | deny | escalate` verdicts

## How to Use

**Mode A — package investigation:**

1. Start a Claude Code session in the repo directory.
2. Invoke the agent:
   ```
   /agent sentinel-investigator
   ```
3. Provide a Mode A prompt:
   > Investigate the npm package `lod4sh` version `4.17.21`
4. The agent returns a report with one `##` heading per step and a fenced `recommendation` block:
   ```recommendation
   mode: A
   verdict: deny
   score: 28/50
   confidence: high
   top_evidence:
     - typosquat distance 1 from "lodash" (top-500 npm list)
     - postinstall script writes ~/.ssh/authorized_keys
     - maintainer account 3 days old, 1 other package (also flagged)
   ```

**Mode B — leak investigation:**

1. Find your audit entry ID in `~/.claude/sentinel/audit.jsonl` — it is the 26-char `id` field (ULID).
2. Invoke the agent:
   ```
   /agent sentinel-investigator
   ```
3. Provide a Mode B prompt:
   > Investigate audit entry `01HZ9K3V2P8QRMX4TNYW5D6J7B`, my secret prefix is `ghp_Ab`
4. The agent locates the entry, classifies the family, scans the blast radius using the supplied prefix (strategy A), and emits a remediation checklist with the exact revocation URL plus a proposed `diff` against `.claude/sentinel.json`.

## Configuration

No new configuration keys are introduced by this spec. The agent reads existing Sentinel config indirectly:

- `config.audit.path` / `$CLAUDE_PLUGIN_DATA/audit.jsonl` / `~/.claude/sentinel/audit.jsonl` — three-layer path resolution for audit entries in Mode B
- `.claude/sentinel.json` `paths.deny` and `scrubber.extraPatterns` — Mode B step 4 proposes additions to these keys in a fenced `diff` block

The agent file is discovered by Claude Code automatically because it lives at `agents/sentinel-investigator.md` within the plugin path. No `agents:` entry in `hooks/sentinel.json` is required (it would be silently ignored anyway).

## Testing

**Manual smoke-test (primary):**

```bash
# Validate frontmatter parses correctly
node -e "
const { readFileSync } = await import('node:fs')
const src = readFileSync('agents/sentinel-investigator.md', 'utf8')
const match = src.match(/^---\n([\s\S]*?)\n---/)
if (!match) throw new Error('no frontmatter')
const fm = match[1]
if (!fm.includes('name: sentinel-investigator')) throw new Error('missing name')
if (!fm.includes('description:')) throw new Error('missing description')
if (!fm.includes('tools: Read, Grep, Glob, WebFetch, Bash')) throw new Error('missing tools')
console.log('frontmatter OK')
" --input-type=module
```

**Automated tests (pure helpers exercised by the agent):**

```bash
node --test tests/levenshtein.test.mjs    # Levenshtein distance + nearestPopular
node --test tests/secret-families.test.mjs # Family ID mapping + revocation URLs
node --test tests/                         # Full suite (must exit 0)
make validate                              # JSON validation + self-test
```

The agent itself runs inside Claude Code and cannot be exercised by `node --test`. The pure helpers it references (`levenshtein.mjs`, `secret-families.mjs`) are covered by their respective companion test files.

## Notes

- **Build order matters**: the agent's natural-language instructions reference `src/sentinel/levenshtein.mjs` (spec-01), `src/sentinel/secret-families.mjs` (spec-02), and `src/sentinel/data/top_packages_*.json` (spec-03). These must exist before the agent is useful.
- **"Insufficient evidence" is a valid verdict**: the evidence bar is designed to prevent false negatives. If registry, GitHub, and maintainer data are all unavailable, the correct response is "insufficient evidence — treat as untrusted", not a clean bill of health.
- **Mode B audit log never stores raw secrets**: `matched: null` is a design invariant for `scrub` events. Strategy B (transcript fallback) recovers the raw value from `~/.claude/projects/*/conversations/*.jsonl` where the pre-scrub tool result is preserved.
- **Six revocation URLs are acceptance-criteria literals**: `github_pat → https://github.com/settings/tokens`, `aws_akid → https://console.aws.amazon.com/iam/home#/security_credentials`, `stripe_live → https://dashboard.stripe.com/apikeys`, `slack → https://api.slack.com/apps`, `anthropic → https://console.anthropic.com/settings/keys`, `openai → https://platform.openai.com/api-keys`.
- **Levenshtein distance 0 is not a typosquat**: if the package name exactly matches a top-500 entry, Mode A step 3 must report "this IS a popular package" rather than flagging it.
