# Sprint 10: Demo Script & Launch Readiness

**Band**: launch · **Blocked by**: 03, 04, 05, 06, 07, 09

## Goal
Ship the v1 launch artifact. A `make demo` that runs end-to-end on macOS and Linux, a README install flow a colleague can reproduce in under five minutes, and a final pass against the PRD §13 success criteria. This sprint is the difference between "Sentinel works on my machine" and "Sentinel is launchable".

## What we're building
1. A `make demo` target that runs a scripted four-step session demonstrating the three threat classes plus the review skill.
2. A README rewritten to match the actual Claude Code plugin install flow (the PRD's `/plugin install ./path` shorthand does not exist).
3. Cross-platform notes — what works on macOS/Linux today, what Windows users need.
4. An explicit out-of-scope section calling out the malicious-settings attack vector documented as CVE-2025-59536, so users aren't surprised that a defensive plugin installed via the same hook mechanism it defends against is not immune to that mechanism being weaponised.
5. A final validation pass against every §13 success criterion.

## Acceptance criteria
1. `make demo` runs end-to-end on a fresh clone on macOS and on Linux with no setup beyond a working Node ≥ 20.10. The four steps in order:
   - Claude attempts `cat .env` → `deny` from Sprint 04.
   - Claude attempts `pip install huggingface-cli-utils` (or any real slopsquat target) → `ask` from Sprint 05.
   - A synthetic `tool_response` containing `sk-ant-abc123…` → next-turn scrub from Sprint 06 (with the limitation surfaced honestly in the demo output).
   - `/sentinel-review` shows the three audit entries from Sprint 09.
2. A colleague following the README on a fresh machine has a working install in under five minutes.
3. `make validate` passes from a fresh clone with no `npm install` step.
4. All 30+ fixture payloads (path-deny + bash + registry + scrubber, accumulated across Sprints 03–06) block / ask / allow as expected via `node src/sentinel/hook.mjs --self-test`.
5. Plugin loads in Claude Code with no schema errors visible in the session.
6. `sentinel-investigator` produces a report with ≥ 5 evidence points in both modes on the demo inputs.
7. `node --test tests/` runs green with zero `npm install` invocations.
8. README documents the malicious-settings vector (CVE-2025-59536) as an explicit non-goal.
9. README documents the Windows-via-WSL caveat.

## Context & constraints

**Actual install flow (correct against current Claude Code docs — the PRD §11.1 example is wrong):**

```bash
# Prereq: Node.js >= 20.10
node --version  # confirm

# 1. Clone
git clone https://github.com/gltorres/claude-code-sentinel.git
cd claude-code-sentinel

# 2. Validate before installing
make validate

# 3. Install into Claude Code
/plugin marketplace add ./claude-code-sentinel
/plugin install sentinel@claude-code-sentinel
/reload-plugins
```

There is **no** `/plugin install ./<path>` shorthand. Local installs go through the marketplace layer. The README must match this exactly or first-time users will see "command not found" or "plugin not found" and bounce.

**Windows support.** First-class platforms are macOS and Linux. On Windows, Claude Code's default shell is PowerShell, and `node` resolution + `${CLAUDE_PLUGIN_ROOT}` interpolation are unreliable from PowerShell for our hook entry. Document the supported Windows path as **WSL** (Ubuntu or any current distro) — once inside WSL the install is identical to Linux. A `.cmd` wrapper is theoretically possible but adds maintenance burden for a small user base; not worth shipping in v1.

**Out-of-scope: malicious-settings attack vector.** Check Point Research published CVE-2025-59536 / CVE-2026-21852 in late 2025 demonstrating that a malicious `.claude/settings.json` can register hooks that exfiltrate API keys, RCE the developer's machine, etc. Sentinel is installed via the same hook mechanism it defends against. A user who already trusts a malicious settings file is past the point where Sentinel can help them. Document this honestly in the README:

> **Out of scope.** Sentinel defends against Claude Code mis-use during a trusted session. It cannot defend against a malicious `.claude/settings.json` that registers its own hooks before Sentinel's run (CVE-2025-59536). Use `git status` to check for untrusted settings files before opening any repo.

**Demo script shape.** A `make demo` target that drives `claude` non-interactively with a scripted prompt sequence. Should record the output (transcript or screencap) into `demo/` so the README can embed it without requiring the reader to run it.

**Fixture accumulation.** By Sprint 10, the fixtures from Sprints 03 (path-deny), 04 (bash), 05 (registry), and 06 (scrubber) should sum to ≥ 30. If short, add until the count meets PRD §13.2.

**§13 success criteria** (all must pass to call v1 done):
1. `make validate` passes from a fresh clone with no setup beyond Node ≥ 20.10.
2. All 30+ fixtures block/ask/allow as expected.
3. Demo runs end-to-end on macOS and Linux.
4. Plugin loads in Claude Code with no schema errors.
5. `sentinel-investigator` produces ≥ 5 evidence points in both modes.
6. README install reproduces on a colleague's machine in < 5 minutes.
7. `node --test tests/` runs green with zero `npm install` invocations.

## Dependencies
- Sprint 03: `.env` deny powers demo step 1.
- Sprint 04: Bash exfil deny is the actual gate for `cat .env` in demo step 1.
- Sprint 05: Registry check powers demo step 2.
- Sprint 06: Scrubber powers demo step 3.
- Sprint 07: SessionStart banner is part of what users see during the demo.
- Sprint 09: `/sentinel-review` is demo step 4.

## Open questions
- Should `make demo` be fully automated (scripted prompt → recorded transcript) or a human-driven walkthrough with `make demo` opening Claude Code and printing the four prompts to run? Fully automated is harder but better for CI.
