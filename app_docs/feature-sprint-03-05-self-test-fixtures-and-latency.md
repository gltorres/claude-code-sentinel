# Self-Test Fixtures and Latency Assertion

**Task ID:** sprint-03-05
**Date:** 2026-05-10
**Specification:** specs/sprint-03-path-read-deny/spec-05-self-test-fixtures-and-latency.md

## Overview

Replaces the stub `--self-test` branch in `src/sentinel/hook.mjs` with a fixture-loading loop that runs all path-fixture scenarios in-process through `matchPath`, asserts each result against an expected outcome, and reports timing. Ten JSON fixture files under `tests/fixtures/paths/` cover the canonical deny/allow paths from the sprint brief, and a new latency test in `tests/hook.test.mjs` enforces a < 20 ms per-fixture budget using the self-reported in-process timing.

## What Was Built

- 10 fixture JSON files under `tests/fixtures/paths/`, each with `{ event, expect }` shape covering deny/allow cases for `Read`, `Edit`, `Grep`, `Glob`, and `NotebookEdit` tools
- Full rewrite of the `--self-test` branch in `src/sentinel/hook.mjs` to load and evaluate all fixtures in-process via `matchPath`, with per-fixture timing via `performance.now()`
- Exit-1-on-mismatch behavior with a descriptive stderr failure message identifying the failing fixture, expected values, and actual values
- Latency assertion test in `tests/hook.test.mjs` that spawns `--self-test`, parses `(<N> fixtures, <ms> ms total)` from stderr, and asserts per-fixture average < 20 ms
- `PreToolUse` path-deny wiring in `hook.mjs` integrated alongside the self-test branch, forwarding `decisionCtx` to `writeAuditLine` for deny events

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `readdirSync` to the `node:fs` import; added static imports for `homedir` from `node:os` and `matchPath` from `./paths.mjs`; rewrote the `--self-test` branch body; wired `matchPath` into `PreToolUse` dispatch with `decisionCtx` forwarding
- `tests/hook.test.mjs`: Appended integration tests for `PreToolUse` deny/allow behavior and the `--self-test` latency assertion
- `tests/audit.test.mjs`: Extended with audit record assertions for deny events
- `tests/config.test.mjs`: Extended with path-fixture config assertions
- `tests/glob.test.mjs`: New test file for `compileGlob`/`matchGlob` unit coverage
- `tests/paths.test.mjs`: New test file for `matchPath` unit coverage
- `config/defaults.json`: Updated with path deny/allow lists exercised by the fixtures

### New Files

- `tests/fixtures/paths/read-env-deny.json` — `Read` on `<cwd>/.env`; expects deny / `**/.env`
- `tests/fixtures/paths/read-env-example-allow.json` — `Read` on `<cwd>/.env.example`; expects allow / `**/.env.example`
- `tests/fixtures/paths/edit-pem-deny.json` — `Edit` on `<cwd>/certs/server.pem`; expects deny / `**/*.pem`
- `tests/fixtures/paths/grep-aws-credentials-deny.json` — `Grep` on `/home/testuser/.aws/credentials`; expects deny / `**/.aws/credentials`
- `tests/fixtures/paths/glob-secrets-yaml-deny.json` — `Glob` pattern on `secrets.yml`; expects deny / `**/secrets*.y?ml`
- `tests/fixtures/paths/notebookedit-zshrc-deny.json` — `NotebookEdit` on `/home/testuser/.zshrc`; expects deny / `**/.zshrc`
- `tests/fixtures/paths/read-pub-allow.json` — `Read` on `/home/testuser/.ssh/id_ed25519.pub`; expects allow / `**/*.pub`
- `tests/fixtures/paths/read-ssh-id-deny.json` — `Read` on `/home/testuser/.ssh/id_ed25519`; expects deny / `**/.ssh/id_*`
- `tests/fixtures/paths/read-ssh-id-pub-allow.json` — `Read` on `/home/testuser/.ssh/id_rsa.pub`; expects allow / `**/*.pub`
- `tests/fixtures/paths/read-netrc-deny.json` — `Read` on `/home/testuser/.netrc`; expects deny / `**/.netrc`

### Key Changes

- The `--self-test` branch resolves the fixtures directory via `new URL('../../tests/fixtures/paths', import.meta.url).pathname`, making it CWD-independent regardless of where `node src/sentinel/hook.mjs --self-test` is invoked
- `loadConfig()` is called once outside the loop with no args (shipped defaults only), so fixture results are environment-independent
- Path extraction handles all three tool-input shapes: `file_path` (Read/Edit/Grep), `pattern` (Glob), and `notebook_path ?? file_path` (NotebookEdit)
- `result.rule ?? null` and `result.matched ?? null` normalise `undefined` before comparing against fixture `expect` values that carry explicit `null` for allow-without-rule cases
- Exit 1 on any mismatch is intentional — `--self-test` is a developer harness, not a production code path; the research brief's "no `process.exit(1)`" applies only to the production hook path

## How to Use

1. Run the self-test directly:
   ```sh
   node src/sentinel/hook.mjs --self-test
   ```
   On success, stderr shows: `Sentinel: self-test ok (10 fixtures, X.X ms total)`
   On failure, stderr identifies the failing fixture and the expected vs. actual values, then exits 1.

2. Run as part of `make validate` (the self-test is the third pipeline step):
   ```sh
   make validate
   ```

3. Run the full test suite including the latency assertion:
   ```sh
   node --test tests/
   ```

## Configuration

Fixtures exercise `config/defaults.json` path deny/allow lists only — no user or project `sentinel.json` overrides. To add new fixtures, place a `{ event, expect }` JSON file under `tests/fixtures/paths/`; the self-test loop picks it up automatically via `readdirSync`.

## Testing

- `node src/sentinel/hook.mjs --self-test` must exit 0 and print fixture count + timing to stderr
- `node --test tests/` must exit 0 with the latency assertion passing (`--self-test: per-fixture in-process latency < 20 ms`)
- `make validate` exercises all four pipeline steps: manifest JSON parse, hook config JSON parse, `--self-test`, and `node --test tests/`

## Notes

- All fixture paths use `/home/testuser/` as the home prefix to avoid accidental matches against real developer files; none use `~` prefix so `homedir()` is only consulted for tilde expansion, not fixture matching
- The latency test parses the self-reported in-process ms (not wall-clock around `spawnSync`); Node cold-start on darwin-arm64 is ~30 ms, which would always exceed the 20 ms budget if measured externally
- `tests/fixtures/secret-bash.json` is in the parent `tests/fixtures/` directory and is unaffected — the `--self-test` loop walks `tests/fixtures/paths/` only
