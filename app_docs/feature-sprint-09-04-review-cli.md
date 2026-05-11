# Review CLI (`review-cli.mjs`)

**Task ID:** sprint-09-04
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-04-review-cli.md

## Overview

This feature adds `src/sentinel/review-cli.mjs`, a zero-dependency Node.js CLI entry point that backs the `/sentinel-review` slash command with three deterministic subcommands: `summary`, `recent [N]`, and `config`. All output is line-oriented and ANSI-free so the slash command body and downstream tooling can parse it by splitting on newlines and pipes.

## What Was Built

- `src/sentinel/review-cli.mjs` — CLI entry point with `summary`, `recent [N]`, and `config` subcommands
- `commands/sentinel-review.md` — slash command dispatcher that routes `$ARGUMENTS` to the CLI subcommands and renders output to the user
- `tests/review-cli.test.mjs` — 17 `node:test` subprocess tests covering all three subcommands and error paths
- `tests/fixtures/review-cli/audit.jsonl` — 8-entry fixture log spanning all four event classes with timestamps inside and outside the 7-day window
- `tests/fixtures/review-cli/home/.claude/sentinel.json` — static user-layer fixture (sets `audit.maxSizeMb: 5`, `registry.minAgeDays: 7`)
- `tests/fixtures/review-cli/cwd/.claude/sentinel.json` — static project-layer fixture (sets `paths.deny` with two entries)

## Technical Implementation

### Files Modified

- `src/sentinel/review-cli.mjs`: New CLI entry point — shebang, `parseArgv`, `flattenLeaves` generator, and `main()` dispatcher
- `commands/sentinel-review.md`: New slash command — routes `summary`, `recent [N]`, `config`, `test <cmd>`, `investigate <id>`, and `investigate-pkg <name>` branches
- `tests/review-cli.test.mjs`: New subprocess test suite — 17 tests using `spawnSync` with `SENTINEL_HOME`/`SENTINEL_CWD` injection
- `tests/fixtures/review-cli/audit.jsonl`: New fixture — 8 JSONL entries with fixed timestamps anchored to `2026-05-10T12:00:00.000Z`
- `tests/fixtures/review-cli/home/.claude/sentinel.json`: New user-layer fixture config
- `tests/fixtures/review-cli/cwd/.claude/sentinel.json`: New project-layer fixture config

### Key Changes

- **`flattenLeaves` generator** (`src/sentinel/review-cli.mjs:12-26`): Recursively walks the merged config `value` and parallel `sources` object in lockstep, yielding `{ path, value, source }` triples. Arrays are treated as opaque leaves (matching `deepMerge` semantics), so `paths.deny` appears as a single line in `config` output.

- **`summary` subcommand** (`src/sentinel/review-cli.mjs:28-35`): Calls `summariseByEventClass({ config, sinceMs: Date.now() - 7d })` and prints 5 right-padded lines (`block:`, `ask:`, `scrub:`, `warn:`, `total:`). Labels use `.padEnd(6)` for column alignment.

- **`recent [N]` subcommand** (`src/sentinel/review-cli.mjs:37-51`): Calls `tailAuditEntries({ config, n })` (default `N=20`) and prints pipe-delimited lines in the format `ts | event | rule | matched | input_summary` (newest first). The `input_summary` field is `JSON.stringify`-ed for deterministic splitting.

- **`config` subcommand** (`src/sentinel/review-cli.mjs:53-61`): Calls `loadConfigWithSources({ home, cwd })`, flattens all leaves, sorts alphabetically by `path`, and prints `key.path = JSON.stringify(value) [source]` lines.

- **Environment-variable path injection** (`src/sentinel/review-cli.mjs:65-66`): `SENTINEL_HOME` and `SENTINEL_CWD` override `os.homedir()` and `process.cwd()` respectively, avoiding any argv tokenizer while keeping tests isolated from the real user environment.

## How to Use

1. **From the slash command** — invoke `/sentinel-review` (or `/sentinel-review summary`) in Claude Code to see a 7-day event-class summary.

2. **Recent entries** — run `/sentinel-review recent 10` to list the 10 newest audit entries.

3. **Config inspection** — run `/sentinel-review config` to see every config leaf with its source label (`default`, `user`, or `project`).

4. **Dry-run test** — run `/sentinel-review test cat /etc/shadow` to see what decision the hook would make without logging.

5. **Direct CLI invocation**:
   ```sh
   node src/sentinel/review-cli.mjs summary
   node src/sentinel/review-cli.mjs recent 20
   node src/sentinel/review-cli.mjs config
   ```

## Configuration

| Environment Variable | Purpose | Default |
|---|---|---|
| `SENTINEL_HOME` | Override home directory for user config layer | `os.homedir()` |
| `SENTINEL_CWD` | Override CWD for project config layer | `process.cwd()` |

The CLI reads `audit.path` from the merged config (set via user or project `sentinel.json`) to locate the audit log. No `audit.path` flag is exposed; inject the path through a user-layer config file or via the test helper `makeTempHome()`.

## Testing

Run the full subprocess test suite:

```sh
node --test tests/review-cli.test.mjs
```

Or validate everything at once:

```sh
make validate
node --test tests/
node src/sentinel/hook.mjs --self-test
```

Tests use `makeTempHome()` to write a temporary `sentinel.json` with the resolved absolute path to `tests/fixtures/review-cli/audit.jsonl` at runtime, so fixture paths are machine-independent. The static fixture files (`home/.claude/sentinel.json`, `cwd/.claude/sentinel.json`) are used only for source-attribution assertions where `audit.path` is irrelevant.

## Notes

- **`summary` uses live `Date.now()`**: Count assertions in tests are structural (5 lines, non-negative integers, `total` last) rather than exact values, because the fixture timestamps are anchored to `2026-05-10` and will eventually fall outside the 7-day window as real time passes.
- **No `--help` flag**: The slash command body is the canonical user-facing help; unknown subcommands print a one-line hint to stderr and exit 1.
- **Zero runtime npm dependencies**: Only `node:os`, `node:process`, and two local ESM imports (`./audit.mjs`, `./config.mjs`).
- **Array leaves are opaque**: `flattenLeaves` does not recurse into arrays, so `paths.deny` and similar array-valued leaves appear as a single line in `config` output with the source of the last writer.
