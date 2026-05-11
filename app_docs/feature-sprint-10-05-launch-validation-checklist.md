# Launch Validation Checklist

**Task ID:** sprint-10/spec-05-launch-validation-checklist
**Date:** 2026-05-11
**Specification:** specs/sprint-10-demo-and-launch/spec-05-launch-validation-checklist.md

## Overview

This feature creates `mvp-prd/launch-validation.md`, the final gate document before the v1 tag is cut. It provides a single operator-executable checklist covering all 9 acceptance criteria (7 PRD §13 + 2 sprint-brief additions), an integration audit for plugin slug consistency, and a sign-off table for macOS and Linux verification.

## What Was Built

- `mvp-prd/launch-validation.md` — 342-line human-operator checklist with front-matter, all 9 criterion sections, integration audit, sign-off table, and known-gaps section.

## Technical Implementation

### Files Modified

- `mvp-prd/launch-validation.md`: New file created from scratch; contains front-matter (`date`, `sprint`, `status: pending`), 9 criterion entries each with exact verification commands and empty checkboxes, an integration audit section for plugin slug cross-checks, a sign-off table with `macOS result` and `Linux result` columns, and a `## Known Gaps / Follow-ups` section.

### Key Changes

- **9 acceptance criteria** documented with exact shell commands: criteria 1–7 are the PRD §13 set; criteria 8–9 verify the CVE-2025-59536 callout and WSL caveat in `README.md`.
- **Criterion 4** explicitly records fixture count at authoring time (41: 10 paths + 11 bash + 12 registry + 8 scrubber) and asserts N ≥ 30 so the check stays valid after future fixture additions.
- **Integration audit section** placed between criterion table and sign-off table; includes `jq` command and `python3` fallback for slug extraction, plus a `grep` cross-check of the README install commands.
- **Sign-off table** has 10 rows (9 criteria + integration audit) with all result cells intentionally blank — must be filled by a human operator before tagging.
- **No production code changed** — this is a documentation-only spec; existing `make validate`, `node --test tests/`, and `--self-test` all pass as regression assertions.

## How to Use

1. Ensure specs 10-01 through 10-04 are all implemented (marketplace manifest, demo driver, make demo target, README rewrite).
2. Open `mvp-prd/launch-validation.md` and execute each criterion's verification command(s) in order on a fresh clone.
3. For each criterion, record `pass` or `fail (reason)` in the sign-off table under the appropriate platform column.
4. If any criterion fails, add an entry to `## Known Gaps / Follow-ups` before continuing (do not skip).
5. Run the integration audit commands to confirm the plugin slug is consistent between `marketplace.json` and the README.
6. Once all 10 rows show `pass` on both macOS and Linux, fill in the sign-off lines with operator name and date, then update the front-matter `status` to `verified`.

## Configuration

No configuration required. The checklist is static Markdown. The verification commands inside it use the existing Sentinel validation stack (`make validate`, `node --test`, `--self-test`) with no additional setup beyond Node ≥ 20.10 on a fresh clone.

For Criterion 6 (investigator ≥5 evidence points), set the hermetic audit path before running:

```bash
export CLAUDE_PLUGIN_DATA=$(pwd)/demo/
```

## Testing

```bash
# No production code was added; run regression suite only:
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
make demo
```

All four commands must exit 0 before the checklist document can be considered valid.

## Notes

- **Why 9 criteria, not 7.** PRD §13 lists 7 success criteria. The sprint brief adds ACs 8 (CVE callout) and 9 (WSL caveat), giving 9 total. The checklist covers all 9.
- **Fixture count is 41.** The N ≥ 30 threshold is intentional to allow future additions without doc updates.
- **AC 2 (< 5 minutes) is manual.** No automated CI can verify wall-clock install time on a zero-state machine; the operator records elapsed time via stopwatch.
- **Integration audit placement.** The slug cross-check is a final consistency gate, not tied to a single AC, so it sits between the criterion table and sign-off table.
