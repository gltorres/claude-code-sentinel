---
date: 2026-05-11
sprint: 10
status: pending
---

# Sentinel v1 Launch Validation Checklist

This document is the final gate before the v1 tag is cut. The launch operator
executes every command below on a fresh clone on both macOS and Linux, records
the result in the sign-off table, and confirms every checkbox before tagging.

**Depends on**: specs 10-01 (marketplace manifest), 10-02 (demo driver),
10-03 (make demo target + transcript), 10-04 (README rewrite).

---

## §13 Success Criteria

The 7 PRD §13 criteria are listed first (items 1–7), followed by the two
additional sprint AC requirements (items 8–9).

### Criterion 1 — `make demo` runs end-to-end on macOS and Linux

`make demo` produces `demo/transcript.md` in under 60 seconds on a fresh clone
with no setup beyond Node ≥ 20.10. The four steps complete in order:
  - Step 1: `cat .env` → `deny` (bash.cat rule).
  - Step 2: `pip install <target>` → `ask` (registry rule).
  - Step 3: synthetic `tool_response` with `sk-ant-…` → `additionalContext`
    containing `<REDACTED:anthropic>` plus an honest-limitation footer.
  - Step 4: `/sentinel-review recent 3` → 3 audit lines from steps 1–3.

- [ ] **Verification**:

  ```bash
  make clean-demo && make demo && test -f demo/transcript.md
  ```

  Expected: exits 0; `demo/transcript.md` is non-empty; each of the four
  step headers appears in the transcript.

---

### Criterion 2 — README install reproduces in < 5 minutes

A colleague starting from zero (no prior Sentinel install) can follow the
README and reach a working `/plugin install sentinel@claude-code-sentinel`
in under five minutes on a fresh macOS or Linux machine.

- [ ] **Verification** (timed manual run):

  1. Open a stopwatch.
  2. On a machine with no prior Sentinel install, open a new terminal.
  3. Run the following sequence exactly as written in the README:

     ```bash
     node --version          # confirm >= 20.10
     git clone https://github.com/gltorres/claude-code-sentinel.git
     cd claude-code-sentinel
     make validate
     ```

  4. In Claude Code, run:

     ```
     /plugin marketplace add ./claude-code-sentinel
     /plugin install sentinel@claude-code-sentinel
     /reload-plugins
     ```

  5. Stop the stopwatch. Record elapsed time in the sign-off table.
  6. Confirm Claude Code shows no "plugin not found" or schema error.

  Expected: elapsed time < 5 minutes; plugin loads without error.

---

### Criterion 3 — `make validate` passes from a fresh clone, no `npm install`

`make validate` runs the full JSON-lint + test suite + self-test with zero
`npm install` invocations.

- [ ] **Verification**:

  ```bash
  rm -rf node_modules && make validate
  ```

  Expected: exits 0. Output includes one `ok` line per JSON file linted,
  followed by the node test suite results, followed by
  `Sentinel: self-test ok (N fixtures, X ms total)` on stderr, followed by
  `validate: ok`.

---

### Criterion 4 — 30+ fixtures pass via `--self-test`

All fixture payloads across the four PRD-counted buckets (paths, bash,
registry, scrubber) replay with the expected decision.

- [ ] **Verification**:

  ```bash
  node src/sentinel/hook.mjs --self-test 2>&1 | grep 'self-test ok'
  ```

  Expected: one line matching `Sentinel: self-test ok (N fixtures, X ms total)`
  where N ≥ 30. At authoring time the count is 41 (10 paths + 11 bash +
  12 registry + 8 scrubber; `research/2026-05-11-sprint-10-demo-and-launch.md:154`).
  If N < 30, stop and file a follow-up before proceeding.

  Full exit-code check:

  ```bash
  node src/sentinel/hook.mjs --self-test
  echo "exit: $?"
  ```

  Expected: `exit: 0`.

---

### Criterion 5 — Plugin loads in Claude Code with no schema errors

The plugin loads cleanly after `/plugin install sentinel@claude-code-sentinel`
with no schema-validation errors visible in the Claude Code debug log.

- [ ] **Verification** (manual):

  1. Enable Claude Code debug logging:

     ```bash
     claude --debug 2>debug.log &
     ```

  2. In the Claude Code session, run:

     ```
     /plugin marketplace add ./claude-code-sentinel
     /plugin install sentinel@claude-code-sentinel
     /reload-plugins
     ```

  3. Inspect the debug log:

     ```bash
     grep -i 'schema error' debug.log && echo "SCHEMA ERROR FOUND" || echo "no schema errors"
     ```

  Expected: `no schema errors` printed; plugin appears in the active-plugins
  list.

---

### Criterion 6 — `sentinel-investigator` produces ≥ 5 evidence points

Running `/agents sentinel-investigator` against a seeded audit log (containing
at least one `block`, one `ask`, and one `scrub` entry) produces a report with
≥ 5 distinct evidence points drawn from ≥ 2 sources.

- [ ] **Verification** (manual):

  1. Ensure `demo/audit.jsonl` exists from a previous `make demo` run (it
     contains exactly 3 entries covering block, ask, and scrub events).
  2. Set the audit path environment variable so the investigator reads the
     demo audit log:

     ```bash
     export CLAUDE_PLUGIN_DATA=$(pwd)/demo/
     ```

  3. In Claude Code, run:

     ```
     /agents sentinel-investigator
     ```

     When prompted for a mode, choose both "recent blocks" and "package audit"
     to exercise both investigator paths.

  4. Inspect the response. Confirm:
     - The report contains ≥ 5 numbered evidence points.
     - Evidence points are drawn from ≥ 2 distinct sources (e.g., audit log
       entries + registry metadata or package age data).

  Expected: report body lists ≥ 5 evidence points as defined in
  `agents/sentinel-investigator.md:7-13`.

---

### Criterion 7 — `node --test tests/` runs green, zero `npm install`

The full test suite runs to completion with zero failures and no dependency
installation step.

- [ ] **Verification**:

  ```bash
  rm -rf node_modules && node --test tests/
  ```

  Expected: all test files pass; output ends with a line like
  `# tests N` with zero `not ok` lines; exit code 0.

---

### Criterion 8 — README documents CVE-2025-59536 as an explicit non-goal

The README contains the verbatim CVE callout from the sprint brief.

- [ ] **Verification**:

  ```bash
  grep -q 'CVE-2025-59536' README.md && echo "CVE callout found" || echo "MISSING — AC 8 FAIL"
  ```

  Expected: `CVE callout found`.

  Full verbatim text to confirm is present (grep for the distinctive substring):

  ```bash
  grep -A 3 'CVE-2025-59536' README.md
  ```

  Expected output must include the phrase "It cannot defend against a malicious
  `.claude/settings.json`".

---

### Criterion 9 — README documents Windows-via-WSL caveat

The README explicitly states that Windows support requires WSL, and that
PowerShell is not a supported shell for Sentinel's hook entry.

- [ ] **Verification**:

  ```bash
  grep -q 'WSL' README.md && echo "WSL caveat found" || echo "MISSING — AC 9 FAIL"
  ```

  Expected: `WSL caveat found`.

  Confirm the caveat is substantive (not just a passing mention):

  ```bash
  grep -B 1 -A 5 'WSL' README.md
  ```

  Expected: the surrounding context explains that Windows users must use WSL
  and that PowerShell's `${CLAUDE_PLUGIN_ROOT}` interpolation is unreliable.

---

## Integration Audit — Plugin Slug Consistency

Before signing off, verify that the plugin slug used in the README install
commands exactly matches the slug declared in `.claude-plugin/marketplace.json`
(created by spec 10-01). A mismatch causes a "plugin not found" error for any
user following the README.

- [ ] **Step 1** — Extract the slug from the marketplace manifest:

  ```bash
  # Requires: jq installed (or use python3 fallback below)
  jq -r '.plugins[0].slug' .claude-plugin/marketplace.json

  # python3 fallback (no jq needed):
  python3 -c "import json; m=json.load(open('.claude-plugin/marketplace.json')); print(m['plugins'][0]['slug'])"
  ```

  Record the slug. It should be `sentinel`.

- [ ] **Step 2** — Extract the marketplace directory name from the same manifest
  (this is what `/plugin marketplace add <path>` resolves to):

  ```bash
  python3 -c "import json; m=json.load(open('.claude-plugin/marketplace.json')); print(m.get('name','(no name field)'))"
  ```

- [ ] **Step 3** — Confirm the README install commands use the correct composite
  slug (`sentinel@claude-code-sentinel`):

  ```bash
  grep 'plugin install' README.md
  ```

  Expected: output contains `sentinel@claude-code-sentinel`.

- [ ] **Step 4** — Cross-check: the composite slug format is
  `<plugin_slug>@<marketplace_directory_name>`. Confirm both halves match:

  ```bash
  grep -o 'sentinel@[a-z0-9_-]*' README.md
  ```

  Expected: `sentinel@claude-code-sentinel` (where `claude-code-sentinel` is
  the directory name passed to `/plugin marketplace add`).

If any slug mismatch is found, **do not proceed to sign-off**. File a follow-up
in `## Known Gaps / Follow-ups` below and fix the discrepancy in spec 10-01
(manifest) or spec 10-04 (README) as appropriate.

---

## Verification Sign-off

The launch operator fills in this table after executing every command above on
both platforms. A cell left blank means the criterion was not yet verified on
that platform — the tag MUST NOT be cut until all cells are filled.

| Criterion | Command summary | macOS result | Linux result | Notes |
|-----------|----------------|--------------|--------------|-------|
| 1. `make demo` end-to-end | `make clean-demo && make demo && test -f demo/transcript.md` | | | |
| 2. README install < 5 min | timed manual run (stopwatch) | | | record elapsed time |
| 3. `make validate` no npm | `rm -rf node_modules && make validate` | | | |
| 4. ≥30 fixtures via `--self-test` | `node src/sentinel/hook.mjs --self-test 2>&1 \| grep 'self-test ok'` | | | record N |
| 5. Plugin loads, no schema errors | `grep -i 'schema error' debug.log` | | | manual install step |
| 6. Investigator ≥5 evidence points | manual `/agents sentinel-investigator` | | | |
| 7. `node --test tests/` green | `rm -rf node_modules && node --test tests/` | | | |
| 8. CVE-2025-59536 callout | `grep -q 'CVE-2025-59536' README.md` | | | |
| 9. WSL caveat | `grep -q 'WSL' README.md` | | | |
| Integration audit | slug cross-check (`jq` + `grep`) | | | |

**Sign-off** (operator fills in name and date when all rows are green):

- macOS verified by: _____________________ on ___________
- Linux verified by:  _____________________ on ___________

---

## Known Gaps / Follow-ups

_Leave this section empty at first authoring. When running the checklist, if
any criterion fails or a non-blocking observation is noted, file a GitHub issue
and add an entry here in the format below before continuing._

**How to file**: open an issue at
`https://github.com/gltorres/claude-code-sentinel/issues/new` with the label
`launch-gap` and title `[Launch gap] <brief description>`. Paste the failing
command output and the criterion number.

_No known gaps at authoring time (2026-05-11). Fixture count verified at 41._
