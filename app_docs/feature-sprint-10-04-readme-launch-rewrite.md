# README v1 Launch Rewrite

**Task ID:** sprint-10-04
**Date:** 2026-05-11
**Specification:** specs/sprint-10-demo-and-launch/spec-04-readme-launch-rewrite.md

## Overview

Rewrote `README.md` from a developer-focused stub into a complete v1 launch document. The rewrite replaces the "Early development. Not yet installable." status with "v1 — installable", adds a full install sequence, demo instructions, and two previously absent launch-blocker sections: cross-platform support (Windows via WSL only) and an out-of-scope callout for CVE-2025-59536.

## What Was Built

- **Status section** — replaced pre-launch placeholder with "v1 — installable" and a pointer to the Install section
- **Install (≤ 5 min) section** — full 6-command install sequence (node version check, git clone, make validate, plugin install) with troubleshooting notes
- **Demo section** — `make demo` invocation, four-step scenario list, and link to `demo/transcript.md`
- **What Sentinel defends against** — merged Architecture hook table and verbatim next-turn scrubber caveat into one section
- **Configuration section** — config merge hierarchy (`config/defaults.json` → user → project), key defaults, and `/sentinel-review config` inspection command
- **Reviewing what Sentinel has done** — `/sentinel-review` subcommand reference and investigator agent invocation (absorbed the former `## Investigator agent` top-level section)
- **Cross-platform support section** — macOS/Linux first-class; Windows via WSL 2 only with PowerShell `${CLAUDE_PLUGIN_ROOT}` caveat
- **Out of scope section** — CVE-2025-59536 paragraph and v1 non-goals

## Technical Implementation

### Files Modified

- `README.md`: complete structural rewrite from 91 lines to ~235 lines; 11-section document replacing a 4-section stub

### Key Changes

- The `## Architecture` heading was removed; its hook event table was relocated into `## What Sentinel defends against` with the verbatim scrubber caveat blockquote appended immediately after
- `## Local development install` (3-command stub) was replaced by `## Install (≤ 5 min)` with a complete 6-command sequence including Node version prereq, `make validate`, and bounce-back recovery instructions
- `## Investigator agent` was removed as a top-level section; its content is now the second half of `## Reviewing what Sentinel has done`
- Two net-new sections — `## Cross-platform support` and `## Out of scope` — address the two launch blockers flagged in the research doc (CVE-2025-59536 injection and Windows PowerShell incompatibility)
- `## Data refresh` content was preserved verbatim from the previous README

## How to Use

The README is the primary first-contact document for new users installing Sentinel.

1. User reads `## Status` to confirm the plugin is installable
2. User follows `## Install (≤ 5 min)` — Node prereq check → `git clone` → `make validate` → `/plugin marketplace add` → `/plugin install`
3. User runs `make demo` to see all four defenses fire before committing to the install
4. User reads `## What Sentinel defends against` for the full hook event table and scrubber limitation
5. User customises rules via `## Configuration` and inspects audit state via `## Reviewing what Sentinel has done`
6. Windows users read `## Cross-platform support` for WSL-only guidance
7. Security-conscious users read `## Out of scope` for CVE-2025-59536 boundary

## Configuration

No new configuration keys were introduced by this spec. The README documents existing keys from `config/defaults.json`:

| Key | Default | Effect |
|---|---|---|
| `paths.deny` | glob list | Files Sentinel blocks Claude from reading |
| `bash.denyCommands` | command list | Shell commands blocked when used with denied paths |
| `registry.minAgeDays` | `14` | Packages younger than N days trigger `ask` |
| `registry.minWeeklyDownloads` | `100` | Packages below N downloads trigger `ask` |
| `scrubber.enabled` | `true` | Set `false` to disable output scrubbing |

## Testing

The spec specifies no new unit tests (README is not executable). Structural validation:

```bash
grep -n "Early development" README.md          # must return zero lines
grep -n "Install (≤ 5 min)" README.md          # must return >= 1 line
grep -n "node --version" README.md             # must return >= 1 line
grep -n "make validate" README.md              # must return >= 1 line
grep -n "make demo" README.md                  # must return >= 1 line
grep -n "demo/transcript.md" README.md         # must return >= 1 line
grep -n "CVE-2025-59536" README.md             # must return >= 1 line
grep -n "WSL only" README.md                   # must return >= 1 line
```

Full validation commands (no regressions):
```bash
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
make demo
```

## Notes

- **Verbatim strings are non-negotiable**: the CVE-2025-59536 paragraph and the WSL-only sentence are exact-match acceptance criteria. Do not paraphrase them.
- **Dependency order**: this spec must execute after spec-01 (marketplace manifest slug confirmed), spec-02 (demo driver), and spec-03 (`demo/transcript.md` artifact committed). The Demo section links to `demo/transcript.md` — a broken link at launch is a blocker.
- **Removed headings**: `## Architecture`, `## Local development install`, and `## Investigator agent` no longer exist as top-level headings. External `#architecture` or `#local-development-install` anchor links are broken (acceptable for v1 — no public links existed before launch).
- **`make demo` in validation**: included specifically because the Demo section describes the `make demo` invocation. If `make demo` exits non-zero, the README is misleading.
