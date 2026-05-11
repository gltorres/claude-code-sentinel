# Sprint 09 E2E Runbook — Sentinel Review Skill

**Task ID:** sprint-09-spec-06
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-06-sentinel-review-e2e.md

## Overview

This deliverable creates the end-to-end (E2E) runbook for Sprint 09 at `.claude/commands/e2e/test_sprint_09_sentinel_review.md`. The runbook validates every user-visible artifact introduced by Sprint 09 (Specs 01–05) in sequence, covering the `/sentinel-review` slash command, the `review-cli.mjs` subcommands, the `--dry-run` hook flag, the investigator dispatch wiring, and a no-regression check for unit tests and the hook self-test. No production code is added or modified; the sole deliverable is the new E2E markdown file.

## What Was Built

- `.claude/commands/e2e/test_sprint_09_sentinel_review.md` — eight-scenario E2E runbook covering all Sprint 09 user-visible artifacts
- Eight numbered scenarios exercising `commands/sentinel-review.md`, `review-cli.mjs summary/recent/config`, `hook.mjs --dry-run` deny/allow paths, slash command body wording, and the no-regression unit-test + self-test gate
- A `## Pass Criteria` section enumerating all eight assertions with expected exit codes and output fragments
- Fixture reuse strategy: scenarios 2–4 point `CLAUDE_PLUGIN_DATA` at `tests/fixtures/review-cli/` (created by Spec 04) to maintain consistency with the unit tests

## Technical Implementation

### Files Modified

- `.claude/commands/e2e/test_sprint_09_sentinel_review.md`: New E2E runbook with eight scenarios, Setup, Teardown, and Pass Criteria sections

### Key Changes

- **Scenario 1** — Verifies `commands/sentinel-review.md` exists with valid YAML frontmatter (`name`, `description`, `allowed-tools` keys) and that `allowed-tools` includes `Agent`
- **Scenarios 2–4** — Spawn `review-cli.mjs summary`, `recent 3`, and `config` as Node subprocesses with `CLAUDE_PLUGIN_DATA=tests/fixtures/review-cli`; assert output tokens and line counts
- **Scenarios 5–6** — Dry-run deny/allow paths: create an isolated temp `audit.jsonl`, capture `statSync` mtime/size before and after the hook subprocess, assert both are unchanged and the output contains `decision=deny` or `decision=allow`; temp dirs cleaned in `finally` blocks
- **Scenario 7** — Reads `commands/sentinel-review.md` body (after frontmatter) and asserts the literal strings `Agent` and `sentinel-investigator` are present
- **Scenario 8** — Bare-shell assertions: `node --test tests/*.mjs` exits 0 and `node src/sentinel/hook.mjs --self-test` exits 0 with `>= 43` reported fixtures

## How to Use

1. Set the repo root: `export REPO="$(pwd)"`
2. Confirm Node >= 20.10: `node --version`
3. Run each scenario block top-to-bottom as shell or via the Claude Code `test_e2e.md` workflow
4. All eight scenarios must print `PASS:` and exit 0 for the Sprint 09 E2E to be considered passing

```bash
# Quick full-suite validation (prerequisite before running the E2E)
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
```

## Configuration

- `CLAUDE_PLUGIN_DATA` — overrides the audit log and config paths used by `review-cli.mjs` and `hook.mjs`; scenarios 2–6 set this to fixture or temp directories they own
- `SENTINEL_HOME` / `SENTINEL_CWD` — override home and cwd for config resolution in `review-cli.mjs config`; scenario 4 uses `HOME` (which `loadConfigWithSources` reads) pointed at the fixture directory

## Testing

Run the runbook's eight scenarios sequentially against the fully-implemented `sprint/09-sentinel-review-skill` branch. Each scenario exits non-zero with a `FAIL:` message at the first failed assertion. The intended failure mode is fast-fail: running the runbook against a partial implementation surfaces exactly which spec is missing.

```bash
# Scenario 8 regression gate (also safe to run standalone)
node --test "$REPO/tests/"*.mjs
node "$REPO/src/sentinel/hook.mjs" --self-test
```

## Notes

- The runbook coexists with the sprint-level E2E at `.claude/commands/e2e/test_sprint_09_sentinel_review_skill.md`; neither file depends on the other
- Scenarios 5–6 temp dirs are named `/tmp/sentinel-e2e-s5-*` and `/tmp/sentinel-e2e-s6-*`; if a process is killed mid-scenario, remove them manually with `rm -rf /tmp/sentinel-e2e-s{5,6}-*`
- The `size == 0` guard on the audit log is reliable across APFS (ns-resolution mtime) and ext4: any write to the empty file changes both mtime and size
- `wc -l README.md` was chosen for the allow-path scenario (Scenario 6) because it is benign, contains no shell operators, and passes all default Sentinel policy checks
