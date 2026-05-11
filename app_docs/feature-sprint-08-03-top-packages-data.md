# Top-Packages Seed Data

**Task ID:** sprint-08-spec-03
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-03-top-packages-data.md

## Overview

Three seed JSON files were added under `src/sentinel/data/` containing 50 well-known package names each for npm, PyPI, and crates.io ecosystems. These lists are the primary data source for the forensic investigator agent's typosquat-distance check: the agent loads the relevant list and uses the Levenshtein helper (spec-01) to flag any candidate package within edit distance ≤ 2 of a known-popular name. The `make validate` recipe was also unified to JSON-parse all data files via a `python3` for-loop.

## What Was Built

- `src/sentinel/data/top_packages_npm.json` — 50-entry sorted, deduped, lowercase npm package names (includes scoped `@babel/` and `@types/` packages)
- `src/sentinel/data/top_packages_pypi.json` — 50-entry sorted, deduped, lowercase PyPI package names
- `src/sentinel/data/top_packages_crates.json` — 50-entry sorted, deduped, lowercase crates.io crate names (hyphen-normalised)
- Updated `Makefile` `validate` recipe: replaced two individual `node -e` JSON-parse lines with a unified `python3` for-loop covering all JSON manifests and the new `src/sentinel/data/*.json` glob

## Technical Implementation

### Files Modified

- `Makefile`: replaced `validate` recipe body with a `python3` for-loop; added `refresh-data` phony target
- `src/sentinel/data/top_packages_npm.json`: new file, 50 entries
- `src/sentinel/data/top_packages_pypi.json`: new file, 50 entries
- `src/sentinel/data/top_packages_crates.json`: new file, 50 entries

### Key Changes

- The `validate` recipe iterates `for f in .claude-plugin/plugin.json hooks/sentinel.json src/sentinel/data/*.json` — the shell glob automatically picks up any future data files without further Makefile edits
- `python3 -c "import json,sys; json.load(open(sys.argv[1]))"` is used for JSON parsing (system Python 3, no new dependency); `|| exit 1` aborts the recipe immediately on any parse failure
- `$$f` escapes the Make variable sigil so the shell sees `$f`; each valid file prints `<path>: ok` to stdout
- Crate names use hyphens as the canonical separator (e.g. `serde-json`, not `serde_json`), matching crates.io API conventions
- npm seed includes scoped packages (`@babel/core`, `@types/node`, etc.) since scoped names are high-value typosquat targets; the Levenshtein helper compares full scoped names including the `@scope/` prefix

## How to Use

1. Run `make validate` — the recipe now parses all three data files and prints `src/sentinel/data/top_packages_*.json: ok` for each
2. The investigator agent (spec-05) loads the relevant file at runtime via `readFileSync` + `JSON.parse` and passes the array to `nearestPopular(candidateName, list)` from `src/sentinel/levenshtein.mjs`
3. Any candidate package with Levenshtein distance ≤ 2 to a name in the list is flagged as a potential typosquat

## Configuration

No new config keys. The data files are referenced by filesystem path relative to `src/sentinel/` in the agent definition. The `refresh-data` Makefile target (`node tools/refresh_top_packages.mjs`) expands the lists to 500 entries on demand (spec-04 deliverable).

## Testing

```sh
make validate
# Expect three lines: src/sentinel/data/top_packages_*.json: ok

node --test tests/
node src/sentinel/hook.mjs --self-test
```

No new unit tests were added — the data files are static JSON arrays with no logic to unit test. `make validate` serves as the integration/parse-validity test.

## Notes

- These are curated seeds, not download-rank data. They cover the most-targeted packages; the spec-04 refresh script replaces them with live-fetched, rank-ordered lists of up to 500 entries.
- The `src/sentinel/data/` directory is version-controlled (not in `.gitignore`).
- Shell glob expansion order is locale-dependent; the acceptance criteria check for presence of all three `*: ok` lines, not for a specific order.
- The hook does not load these files at startup — they are loaded on demand by the agent at investigation time, with no impact on hook latency.
