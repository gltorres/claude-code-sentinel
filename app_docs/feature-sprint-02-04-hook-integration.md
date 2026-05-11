# Hook Integration: Config Loader + Audit Writer

**Task ID:** sprint-02-04
**Date:** 2026-05-10
**Specification:** specs/sprint-02-config-and-audit/spec-04-hook-integration.md

## Overview

Wires the Sprint 02 config and audit services into `src/sentinel/hook.mjs`. Every hook invocation now loads the three-layer merged config once at startup and appends one JSONL audit line per tool decision via a fail-open `try/catch` — meaning a broken audit path never blocks a tool call.

## What Was Built

- Two new static imports in `hook.mjs` for `loadConfig` and `writeAuditLine`
- `const config = loadConfig({ cwd: event.cwd })` inserted between the JSON parse and the dispatch switch, replacing the old `void event` no-op placeholder
- Fail-open `try { writeAuditLine(config, which, event) } catch {}` call at the top of `emit()`, covering all five call sites (PreToolUse, PostToolUse, SessionStart, SessionEnd, and unknown-event default) with a single insertion
- `runHookEnv(args, input, env)` helper added to `tests/hook.test.mjs` to forward `CLAUDE_PLUGIN_DATA` into hook subprocesses without mutating the existing `runHook` signature
- Two new integration tests that exercise the full hook → config → audit path against isolated `mkdtempSync` temp directories

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `loadConfig`/`writeAuditLine` imports; replaced `void event` placeholder with `const config = loadConfig({ cwd: event.cwd })`; added fail-open audit call inside `emit()`
- `tests/hook.test.mjs`: Added `mkdtempSync`, `readFileSync`, `join`, `tmpdir` imports; added `runHookEnv` runner; added two integration test blocks

### Key Changes

- **Single insertion point**: placing the audit call inside `emit()` rather than in each switch case covers all five dispatch sites with one code change — minimum diff
- **Fail-open guarantee**: `try { writeAuditLine(...) } catch {}` ensures a disk-full condition or misconfigured path never propagates to the hook's stdout envelope or exit code
- **`void event` removed**: the suppression comment is intentional — `event` is now genuinely consumed as the third argument to `writeAuditLine`
- **`cwd`-aware config**: passing `{ cwd: event.cwd }` to `loadConfig` ensures the project-level `sentinel.json` overlay is resolved against the workspace being guarded, not the plugin install directory
- **`--self-test` isolation preserved**: the self-test branch exits at line 36 before `config` or `which` are declared, so audit is never invoked from self-test

## How to Use

Hook invocations are fully automatic — the Claude Code harness calls `hooks/sentinel.json` on every tool event. To observe audit output:

1. Ensure `CLAUDE_PLUGIN_DATA` points at a writable directory (e.g. `~/.claude/sentinel`)
2. Trigger any tool call through Claude Code
3. Inspect `$CLAUDE_PLUGIN_DATA/audit.jsonl` — each line is a JSON record with twelve PRD §10 fields

To verify the integration locally:

```bash
node src/sentinel/hook.mjs --self-test          # exits 0, no audit side effect
node --test tests/                              # all seven hook tests pass
make validate                                   # full suite including manifest checks
```

## Configuration

The audit path is resolved in priority order by `audit.mjs`:

1. `CLAUDE_PLUGIN_DATA` env var → `$CLAUDE_PLUGIN_DATA/audit.jsonl`
2. Config `paths.data` key from the merged config object
3. Fallback: `~/.claude/sentinel/audit.jsonl`

No changes are required to `hooks/sentinel.json` or `.claude-plugin/plugin.json` — the manifest is frozen for Sprint 02.

## Testing

Run the full test suite:

```bash
node --test tests/
```

The seven `hook.test.mjs` tests cover:

| Test | What it verifies |
|------|-----------------|
| `--self-test exits 0` | Self-test branch is unaffected by audit wiring |
| Four event-name envelope round-trips | Stdout envelope shape unchanged for all named events |
| `permissionDecision: allow` | Decision field propagated correctly |
| Unknown-event fallthrough | Default case still emits and audits |
| Invalid-JSON fail-open | Bad stdin does not crash the hook |
| PreToolUse writes one audit line | Full hook → audit path creates exactly one JSONL line |
| Twelve PRD fields + 26-char ULID id | Audit record schema completeness |

Integration tests use `mkdtempSync` isolation — they never read or write `~/.claude/sentinel/audit.jsonl`.

## Notes

- **Implementation order**: this spec depends on Spec 1 (`config.mjs`), Spec 2 (`ulid.mjs`), and Spec 3 (`audit.mjs`) being complete. Running `hook.mjs` before those modules exist fails at ESM import resolution.
- **`EVENT_NAMES` unchanged**: the constant remains `void`-discarded. `which` (from `argv[2]`) carries the hook event name to `writeAuditLine` without needing to enumerate valid names. A future sprint can promote `EVENT_NAMES` to a named export at that time.
- **No new runtime dependencies**: all new imports are stdlib (`node:fs`, `node:os`, `node:path`) or local modules added in earlier Sprint 02 specs.
- Sprint 02 writes `warn`/`allow` scaffold values for `rule`, `matched`, and `decision` fields — real policy logic arrives in Sprint 03+.
