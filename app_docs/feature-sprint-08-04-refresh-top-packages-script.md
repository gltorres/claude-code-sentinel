# Refresh Top-Packages Script

**Task ID:** sprint-08-spec-04
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-04-refresh-top-packages-script.md

## Overview

Adds `tools/refresh_top_packages.mjs`, a zero-dependency Node.js ESM script that fetches the latest top-500 package lists from npm, PyPI, and crates.io, normalises each list (lowercase, deduplicated, sorted), and atomically overwrites the three JSON seed files under `src/sentinel/data/`. Operator entry points (`make refresh-data`, `npm run refresh-data`) and a monthly GitHub Actions workflow are wired in so the investigator agent's typosquat detection data stays current without manual editing.

## What Was Built

- `tools/refresh_top_packages.mjs` — self-contained ESM CLI refresh script with three async fetchers and atomic write guarantees
- `Makefile` — added `refresh-data` to `.PHONY` and appended the recipe; also updated the `validate` recipe to use a Python-backed for-loop that parses all JSON files under `src/sentinel/data/`
- `package.json` — added `"refresh-data": "node tools/refresh_top_packages.mjs"` script entry
- `README.md` — added a `## Data refresh` section documenting automatic cadence and manual fallback, plus a `## Investigator agent` section with usage examples
- `.github/workflows/refresh-top-packages.yml` — GitHub Actions workflow that runs on the first of every month (06:00 UTC) and opens a PR via `peter-evans/create-pull-request@v6` if any data file changed

## Technical Implementation

### Files Modified

- `tools/refresh_top_packages.mjs` (new): three async fetchers (`fetchNpm`, `fetchPypi`, `fetchCrates`), a `normalise()` helper, an `atomicWrite()` helper, and a sequential top-level `await` main block with a single `try/catch` that calls `process.exit(1)` on any failure
- `Makefile`: `.PHONY` extended to include `refresh-data`; `validate` recipe rewritten to use `python3 -c "import json,sys; json.load(open(sys.argv[1]))"` in a for-loop across `src/sentinel/data/*.json`; `refresh-data` recipe appended
- `package.json`: `"refresh-data"` script added to the scripts block
- `README.md`: `## Data refresh` and `## Investigator agent` sections added
- `.github/workflows/refresh-top-packages.yml` (new): monthly cron + `workflow_dispatch` trigger, Node 20, runs the refresh script, conditionally opens a PR using `peter-evans/create-pull-request@v6`

### Key Changes

- **Atomic write** — `atomicWrite(finalPath, arr)` writes to `finalPath + '.tmp'` via `writeFileSync`, then calls `renameSync(tmp, final)`. On POSIX systems this is atomic within the same filesystem, so an interrupted run leaves the prior data file intact.
- **Upstream sources** — npm uses the community-maintained `anvaka/npm-rank` `popular.txt` (one name per line); PyPI uses `hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json` (pre-sorted BigQuery data); crates.io paginates the official downloads API across pages 1–5 with a polite `User-Agent` header.
- **Normalisation** — `normalise(raw)` lowercases, deduplicates via `new Set`, sorts ascending, and slices to 500 entries. Applied after fetch so `Requests` and `requests` collapse to one entry.
- **Error propagation** — any thrown error (timeout, non-200 HTTP, JSON parse failure) reaches the top-level `catch`, which logs to `stderr` and exits 1, leaving all prior data files untouched.
- **Path resolution** — `__dirname` is derived from `import.meta.url` via `fileURLToPath` + `dirname`, matching the established convention in `src/sentinel/config.mjs`.

## How to Use

**Manual refresh (network-available environment):**

```bash
make refresh-data
# or equivalently
npm run refresh-data
# or directly
node tools/refresh_top_packages.mjs
```

On success, prints three summary lines and exits 0:
```
npm: 500 entries written
pypi: 500 entries written
crates: 500 entries written
```

**Automatic monthly refresh:**

The GitHub Actions workflow `.github/workflows/refresh-top-packages.yml` runs automatically on the first of every month at 06:00 UTC. If any data file changed it opens a pull request on branch `chore/refresh-top-packages-<run_number>` for human review. The workflow can also be triggered manually from the Actions UI via `workflow_dispatch`.

## Configuration

No configuration options — the script is deliberately simple. Relevant constants defined at the top of `tools/refresh_top_packages.mjs`:

| Constant | Value | Purpose |
|---|---|---|
| `TIMEOUT_MS` | `15_000` | Per-request abort timeout (ms) |
| `UA` | `claude-code-sentinel-refresh (...)` | User-Agent for crates.io crawler policy |
| `DATA_DIR` | `src/sentinel/data/` | Resolved relative to `tools/` via `import.meta.url` |

## Testing

Automated tests for the network fetchers are out of scope (inherently flaky). Manual verification:

```bash
make refresh-data
# Expect: exits 0, prints 3 summary lines

jq 'length, .[0:3]' src/sentinel/data/top_packages_npm.json
# Expect: 500, then 3 lowercased sorted names

make validate
# Expect: exits 0 (no regressions in JSON parse or self-test)

node --test tests/
# Expect: exits 0
```

Network-failure simulation: block outbound HTTPS, run `make refresh-data`, confirm exit 1 and data files unchanged.

## Notes

- **npm source caveat** — `anvaka/npm-rank` `popular.txt` is rebuilt on the maintainer's schedule, not real-time. If the file becomes unavailable, the script exits 1 and leaves the prior npm list intact. The top-of-file comment documents this and notes the alternative (no public top-N API without an API key).
- **crates.io rate limiting** — five sequential page fetches (pages 1–5) spaced by natural HTTP round-trip latency are within the documented rate limit. Parallelising the crates pages would be impolite and is not done.
- **Spec 03 dependency** — if `src/sentinel/data/` does not exist, `atomicWrite` throws `ENOENT` and the script exits 1. Spec 03 must be merged before this script can succeed.
- **`.tmp` cleanup** — interrupted runs may leave `*.tmp` files in `src/sentinel/data/`. Adding `src/sentinel/data/*.tmp` to `.gitignore` is recommended as follow-up housekeeping.
- **GitHub Actions workflow scope** — the original spec deferred the CI workflow to Spec 06, but the workflow was implemented here alongside the script, making this spec fully self-contained for automated monthly refresh.
