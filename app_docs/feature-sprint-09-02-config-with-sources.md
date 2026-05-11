# Config With Sources (`loadConfigWithSources`)

**Task ID:** sprint-09-spec-02
**Date:** 2026-05-11
**Specification:** specs/sprint-09-sentinel-review-skill/spec-02-config-with-sources.md

## Overview

This feature adds `loadConfigWithSources({ home, cwd })` to `src/sentinel/config.mjs` — a new named export that returns both the merged config value and a parallel `sources` object in which every leaf is labeled `'default'`, `'user'`, or `'project'`, identifying which config layer last contributed that value. The existing `loadConfig` export is unchanged; the new function is strictly additive.

## What Was Built

- `tagLeaves(obj, label)` — a private recursive helper that walks a config object and replaces every leaf (scalar or array) with the string `label`. Plain objects are recursed into; arrays are opaque leaves matching `deepMerge`'s last-write-wins semantics.
- `loadConfigWithSources({ home, cwd })` — a new exported function that loads all three config layers (defaults, user, project), computes `value` (identical to `loadConfig`), and computes `sources` by tagging and merging the same three layers with their respective labels.
- Five new unit tests in `tests/config.test.mjs` covering all attribution scenarios.

## Technical Implementation

### Files Modified

- `src/sentinel/config.mjs`: appended `tagLeaves` helper and `loadConfigWithSources` export after the existing `loadConfig` (no existing lines modified)
- `tests/config.test.mjs`: added `loadConfigWithSources` to the named import on line 8; appended five new `test()` blocks after the existing suite

### Key Changes

- `tagLeaves(obj, label)` mirrors `deepMerge`'s array-guard invariant: when the input is `null`, a scalar, or an array, it returns `label` directly (opaque leaf replacement). Plain objects are recursed key-by-key into a new output object — no mutation.
- `loadConfigWithSources` calls `loadLayer` independently three times for `value` (same logic as `loadConfig`, not delegating to it) to keep both exports independently testable without shared internal state.
- Source attribution uses the same two-call `deepMerge` chain as `loadConfig`: `deepMerge(deepMerge(tagDefaults, tagUser), tagProject)`. Because `deepMerge` is last-write-wins for scalars and arrays, the resulting sources object carries the label of whichever layer last wrote each leaf.
- `tagLeaves({}, label)` returns `{}`. When a layer is absent (`loadLayer` returns `{}`), the tagged object contributes no keys to the merge — leaving upstream labels undisturbed.
- `value` is guaranteed to `deepEqual` `loadConfig({ home, cwd })` for the same inputs; every new test asserts this invariant explicitly.

## How to Use

Import the new export alongside or instead of `loadConfig`:

```js
import { loadConfigWithSources } from './src/sentinel/config.mjs'

const { value, sources } = loadConfigWithSources()
// value — the fully merged config (identical to loadConfig())
// sources — parallel structure; every leaf is 'default' | 'user' | 'project'

// Example: render key attribution
console.log(`audit.maxSizeMb = ${value.audit.maxSizeMb} [${sources.audit.maxSizeMb}]`)
```

For testing, inject `home` and `cwd` to control which `sentinel.json` files are read:

```js
const { value, sources } = loadConfigWithSources({ home: '/tmp/fake-home', cwd: '/tmp/fake-project' })
```

## Configuration

No new config keys or runtime dependencies are introduced. `loadConfigWithSources` reads the same three layers as `loadConfig`:

1. **defaults** — `config/defaults.json` (bundled with the plugin)
2. **user** — `~/.claude/sentinel.json`
3. **project** — `.claude/sentinel.json` in the current working directory

## Testing

```bash
node --test tests/config.test.mjs   # runs existing + 5 new tests
node --test tests/                  # full suite regression check
make validate                       # lint + full test suite
```

The five new test cases:

| Test | What it asserts |
|---|---|
| defaults-only | every `sources` leaf is `'default'`; `value` deepEquals `loadConfig` |
| user scalar override | overridden leaf is `'user'`; siblings and unrelated leaves remain `'default'` |
| all three layers | project > user > default precedence per leaf; `value` deepEquals `loadConfig` |
| nested independent leaves | two leaves within the same sub-object carry different source labels |
| array override | project array fully shadows user array; source label is the string `'project'` (not per-element) |

## Notes

- **Arrays are opaque leaves.** Per-element source attribution is not supported — a project array fully shadows a user array, and the entire array leaf is labeled `'project'`. This matches `deepMerge`'s existing `!Array.isArray(sv)` guard.
- **Why not call `loadConfig` internally.** Calling `loadLayer` independently keeps `value` and `sources` on parallel, independently testable code paths with no shared state.
- **Future CLI consumption.** `loadConfigWithSources` returns `{ value, sources }` — not formatted output. The `key.path = value [source]` rendering used by `/sentinel-review config` belongs to `src/sentinel/review-cli.mjs` (Spec 04).
- **No Spec 01 dependency.** This spec is fully independent of the audit-readers feature (Spec 01); the two can be built in either order.
