# Refresh Cadence and Docs

**Task ID:** sprint-08-spec-06
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-06-refresh-cadence-and-docs.md

## Overview

This feature adds a monthly GitHub Actions workflow that automatically refreshes the bundled top-500 package lists used by the forensic investigator agent's typosquat detection, and documents the refresh process in `README.md`. No runtime Node.js code was modified — the deliverables are purely operational infrastructure and prose documentation.

## What Was Built

- `.github/workflows/refresh-top-packages.yml` — GitHub Actions workflow with monthly cron and `workflow_dispatch` triggers that runs the refresh script and opens a PR if any data file changed
- `README.md` `## Data refresh` section — documents the automatic monthly cadence, the manual `make refresh-data` fallback, and what the bundled data is used for

## Technical Implementation

### Files Modified

- `.github/workflows/refresh-top-packages.yml`: New file; first entry in the `.github/` directory for this project. Encodes monthly cron schedule, change detection, and conditional PR creation.
- `README.md`: New `## Data refresh` section inserted after `## Status`, plus a new `## Investigator agent` section at the end with invocation examples.

### Key Changes

- **Monthly cron trigger:** `cron: '0 6 1 * *'` — runs on the first of every month at 06:00 UTC. Also supports `workflow_dispatch` for manual one-off runs with no required inputs.
- **Change-detection step:** Runs `git status --porcelain src/sentinel/data/` after the refresh script; writes `files_changed=true` to `$GITHUB_OUTPUT` only when output is non-empty. The PR step is gated with `if: steps.check.outputs.files_changed == 'true'`.
- **PR via `peter-evans/create-pull-request@v6`:** Branch name `chore/refresh-top-packages-<run_number>` guarantees uniqueness across monthly runs. `delete-branch: true` keeps the remote tidy after merge or close. The PR body names all three data files and links back to the investigator agent's Mode A typosquat step.
- **Workflow-level permissions:** `contents: write` and `pull-requests: write` are declared at the workflow level, overriding any repository default-token restrictions for this workflow only. No personal access token is required.
- **README `## Data refresh` section:** Covers automatic cadence, manual fallback (`make refresh-data` and the equivalent `node tools/refresh_top_packages.mjs`), and what the data is used for (Levenshtein distance check against top-500 lists in the investigator agent's Mode A, step 3).

## How to Use

### Monthly automation (no action required)

The workflow fires automatically on the first of each month. If `src/sentinel/data/top_packages_{npm,pypi,crates}.json` changed, a PR titled `chore: refresh bundled top-500 package lists` is opened against the default branch. Review the PR using the checklist in its body and merge or close.

### Manual refresh

```bash
make refresh-data
```

Or equivalently:

```bash
node tools/refresh_top_packages.mjs
```

### Manual workflow trigger

From the GitHub Actions UI, navigate to the `Refresh top-500 package lists` workflow and click **Run workflow**. No inputs are required.

## Configuration

The workflow is self-contained and requires no repository secrets. The `GITHUB_TOKEN` injected automatically by GitHub Actions is sufficient when `permissions: { contents: write, pull-requests: write }` is declared at the workflow level (as it is).

The cron schedule (`0 6 1 * *`) is fixed. To change the cadence, edit the `cron:` field in `.github/workflows/refresh-top-packages.yml`.

## Testing

1. **YAML validity** (ad-hoc, not automated):
   ```bash
   python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/refresh-top-packages.yml
   ```
   Must exit 0 with no output.

2. **README section presence:**
   ```bash
   grep -n "## Data refresh" README.md
   grep "make refresh-data" README.md
   ```
   Both must return a match.

3. **Regression suite** (no code was modified, but required by the standard gate):
   ```bash
   make validate
   node --test tests/
   node src/sentinel/hook.mjs --self-test
   ```

## Notes

- `.github/` was created for the first time in this sprint. No other workflow files exist in this repo.
- `node-version: '20'` in `setup-node` resolves to the latest 20.x LTS, satisfying the project's `"engines": { "node": ">=20.10" }` constraint.
- The `delete-branch: true` flag applies on both merge and close — branches are always cleaned up.
- If branch-protection rules require review before merging, the automatically opened PR is subject to those rules; no bypass is configured.
- `github.run_number` is an integer that increments with each workflow run, guaranteeing a unique branch name even if a prior month's PR was not merged.
- Optional linting tools (`actionlint`, `yq`) are acceptable for local contributor use but are not added to `make validate` or any automated build step.
