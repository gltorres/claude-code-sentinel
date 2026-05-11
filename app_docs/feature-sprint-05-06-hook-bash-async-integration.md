# Hook Bash Async Integration

**Task ID:** sprint-05/spec-06-hook-bash-async-integration
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-06-hook-bash-async-integration.md

## Overview

This feature converts the `Bash` branch of `src/sentinel/hook.mjs` from synchronous to async and wires in `evaluateRegistry` as a second evaluation stage that runs only when `evaluateBash` returns `allow`. A Bash allow from Sprint 04's exfil check now proceeds to a registry check that may upgrade the outcome to `deny` (fake/not-found package) or `ask` (too new, low downloads, no source). Network failures are fail-open: the hook emits `allow` with a `warn` audit line. All Sprint 03/04 deny and ask paths short-circuit before the registry call is ever made.

## What Was Built

- **`runBashBranch` exported async function** in `src/sentinel/hook.mjs` — the full Bash branch logic extracted into a testable, dependency-injected async function accepting `fetchFn`, `cache`, `emit`, and `envelope` as parameters.
- **Async dispatch wiring** — the `else if (tool === 'Bash')` block now loads the cache synchronously then `await`s an async IIFE that calls `runBashBranch` with production dependencies (`globalThis.fetch`, `Date.now()`, loaded cache).
- **`SENTINEL_TEST_FETCH_FIXTURES` env var stub** — when set, the production Bash branch replaces `globalThis.fetch` with a URL-prefix-keyed stub that reads a JSON fixture map, enabling hermetic E2E tests without a real network.
- **Module guard** — the dispatch switch is now wrapped in `if (process.argv[1] === fileURLToPath(import.meta.url))` so `hook.mjs` can be imported in-process by tests without executing the hook dispatch block.
- **12 registry fixture JSON files** under `tests/fixtures/registry/` covering deny-not-found, ask-too-new, ask-low-downloads, ask-no-source, allow-popular, allow-unavailable-network-error, allow-unavailable-timeout, deny-wins-compound, pypi-too-new, crates-allow-no-weekly, allow-noop-bare-install, and allow-non-install cases.
- **`tests/hook-registry.test.mjs`** — 11 in-process unit tests covering Sprint 04 regressions, all six registry decision shapes, and cache-hit/miss latency assertions.

## Technical Implementation

### Files Modified

- `src/sentinel/hook.mjs`: Added `evaluateRegistry` and cache imports; added `fileURLToPath` import; extracted sync Bash branch into exported async `runBashBranch`; wrapped dispatch in module-guard; added `SENTINEL_TEST_FETCH_FIXTURES` fetch stub in production Bash dispatch path.
- `config/defaults.json`: Extended with `registry` and `ecosystems` config keys (Sprint 05 specs 01–05 prerequisite).
- `tests/hook.test.mjs`: Minor update to stay green with the new module structure.

### Files Added

- `src/sentinel/install-commands.mjs`: Pure parser for install segments (Sprint 05 spec 02).
- `src/sentinel/registry-cache.mjs`: Five cache exports — `resolveCachePath`, `loadCache`, `getCached`, `setCached`, `flushCache` (Sprint 05 spec 04).
- `src/sentinel/registry-clients.mjs`: Multi-ecosystem `fetchPackageMetadata` (npm, PyPI, crates) (Sprint 05 spec 03).
- `src/sentinel/registry-policy.mjs`: `evaluateRegistry` async decision function with 5-step deny-wins tree (Sprint 05 spec 05).
- `tests/hook-registry.test.mjs`: In-process unit tests for `runBashBranch`.
- `tests/fixtures/registry/*.json` (12 files): Canned fixture responses for self-test and E2E stubs.
- `tests/install-commands.test.mjs`, `tests/registry-cache.test.mjs`, `tests/registry-clients.test.mjs`, `tests/registry-policy.test.mjs`: Unit test suites for each new module.

### Key Changes

- **Two-stage Bash evaluation**: `evaluateBash` runs first; only on `allow` does `evaluateRegistry` run. Sprint 04 deny/ask paths short-circuit immediately — no wasted network round-trip for commands like `cat .env`.
- **Fail-open on network errors**: If `evaluateRegistry` throws (network error, timeout), the catch block sets `reg = { decision: 'allow', rule: 'registry.unavailable', ... }` and the hook emits `allow` with `event: 'warn'` in the audit record.
- **Cache flush placement**: `flushCache` is called inside `runBashBranch` after `evaluateRegistry` resolves, before `emitFn`. This ensures the cache is written even on deny/ask paths (because `emitFn` calls `process.exit(0)` in production, making any post-`emitFn` code unreachable).
- **Silent allow audit behaviour**: Registry-clean packages pass `undefined` as `decisionCtx` to `emit`, causing `writeAuditLine` to apply its default `{ event: 'warn', decision: 'allow', rule: null, matched: null }` — identical to the existing Sprint 04 allow path.
- **Module-guard for in-process import**: `if (process.argv[1] === fileURLToPath(import.meta.url))` wraps the dispatch block so test files can `import { runBashBranch } from '../src/sentinel/hook.mjs'` without triggering hook dispatch.

## How to Use

The hook operates transparently via Claude Code's hook system — no manual invocation is needed.

**Manual smoke test (deny — fake package):**
```sh
echo '{"tool_name":"Bash","tool_input":{"command":"npm install slopsquatted-fake-pkg-xyzzy"}}' \
  | node src/sentinel/hook.mjs PreToolUse
# → permissionDecision: "deny", rule: "registry.not_found"
```

**Manual smoke test (allow — Sprint 04 regression):**
```sh
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | node src/sentinel/hook.mjs PreToolUse
# → permissionDecision: "deny" (evaluateBash short-circuits; registry never called)
```

**Hermetic E2E fetch stub:**
```sh
SENTINEL_TEST_FETCH_FIXTURES=/path/to/fixtures.json \
  node src/sentinel/hook.mjs PreToolUse < event.json
```
The fixture file is a JSON object mapping URL prefixes to `{ status, body }` or `{ throw: true }` entries.

## Configuration

All registry check behaviour is governed by `config/defaults.json` (overrideable via user/project `sentinel.json`):

| Key | Default | Description |
|-----|---------|-------------|
| `registry.cacheTtlMs` | `3600000` (1 h) | Cache entry TTL before a fresh fetch |
| `registry.cacheMaxEntries` | `1024` | Max entries before LRU eviction on flush |
| `registry.minAgeDays` | `14` | Packages newer than this trigger `ask` |
| `registry.minWeeklyDownloads` | `100` | Packages below this trigger `ask` |
| `registry.fetchTimeoutMs` | `250` | Per-request network timeout (ms) |
| `ecosystems.npm` / `ecosystems.pypi` / `ecosystems.crates` | `true` | Toggle checks per ecosystem |

## Testing

**Run the full unit test suite:**
```sh
node --test tests/
```

**Run only hook-registry tests (11 in-process tests):**
```sh
node --test tests/hook-registry.test.mjs
```

**Run Sprint 04 regression tests (must pass unchanged):**
```sh
node --test tests/hook.test.mjs
```

**Run make validate (manifest, hook config JSON, self-test, node --test):**
```sh
make validate
```

**Self-test (Sprint 03/04 bash fixtures):**
```sh
node src/sentinel/hook.mjs --self-test
```

## Notes

- `permissionDecision` on ask paths is always the literal string `'ask'`, never `'defer'` — `'defer'` is only for non-interactive `-p` mode.
- `permissionDecisionReason` always starts with `'Sentinel: '` on deny and ask paths.
- Exit code is always `0` regardless of decision — Claude Code reads the JSON envelope on stdout to determine the outcome.
- Spec 07 (registry-fixtures-and-selftest) extends the `--self-test` loop to cover the registry fixture bucket and bumps the fixture floor assertion in `tests/hook.test.mjs:299`.
- The `resolveCachePath` call inside `runBashBranch` reads `process.env.CLAUDE_PLUGIN_DATA`. Tests that pre-populate `cache` and pass it in can ignore the `flushCache` side effect since `flushCache` is fail-open on missing paths.
