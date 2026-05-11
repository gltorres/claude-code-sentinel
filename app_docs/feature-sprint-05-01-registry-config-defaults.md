# Registry Config Defaults

**Task ID:** sprint-05/spec-01-registry-config-defaults
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-01-registry-config-defaults.md

## Overview

Populates `config/defaults.json` with fully specified `registry` and `ecosystems` sub-objects, replacing the empty `{}` placeholders that were added as Sprint 05 stubs. All later Sprint 05 modules (`registry-clients.mjs`, `registry-cache.mjs`, `registry-policy.mjs`) and the hook wiring read these values through the existing three-layer config loader without needing inline fallbacks for the basic numeric and boolean knobs.

## What Was Built

- Six `registry` policy knobs added to `config/defaults.json`: `cacheTtlHours`, `minAgeDays`, `minWeeklyDownloads`, `requireHomepage`, `timeoutMs`, `cacheMaxEntries`
- Three `ecosystems` boolean toggles added: `npm`, `pypi`, `crates`
- One new test appended to `tests/config.test.mjs` asserting every new sub-key has the correct default value and type

## Technical Implementation

### Files Modified

- `config/defaults.json`: Replaced `"registry": {}` and `"ecosystems": {}` with fully populated sub-objects
- `tests/config.test.mjs`: Appended one new `test()` block asserting all nine new sub-key defaults

### Key Changes

- `registry.cacheTtlHours = 1` — TTL in hours for the in-process registry cache; consumed by `registry-cache.mjs`
- `registry.minAgeDays = 14` — packages published fewer than 14 days ago trigger an `ask` decision
- `registry.minWeeklyDownloads = 100` — packages below this npm/PyPI download threshold trigger `ask`; skipped for crates (no weekly count exposed)
- `registry.requireHomepage = true` — packages with neither `homepage` nor `repository` trigger `ask`; disable by setting `false` in `sentinel.json`
- `registry.timeoutMs = 250` — per-fetch `AbortSignal.timeout` budget for registry HTTP calls; separate from the 5 s hook-level deadline in `hooks/sentinel.json`
- `registry.cacheMaxEntries = 1024` — entry count ceiling for trim-before-write eviction in `registry-cache.mjs`
- `ecosystems.npm/pypi/crates = true` — enable registry checks per ecosystem; can be toggled off in user or project `sentinel.json`

## How to Use

### Reading values in a consumer module

```js
const regCfg = (config && config.registry) || {}
const cacheTtlHours   = regCfg.cacheTtlHours    ?? 1
const minAgeDays      = regCfg.minAgeDays        ?? 14
const minWeeklyDl     = regCfg.minWeeklyDownloads ?? 100
const requireHomepage = regCfg.requireHomepage    !== false
const timeoutMs       = regCfg.timeoutMs          ?? 250
const cacheMaxEntries = regCfg.cacheMaxEntries    ?? 1024

const ecoCfg = (config && config.ecosystems) || {}
const npmEnabled    = ecoCfg.npm    !== false
const pypiEnabled   = ecoCfg.pypi   !== false
const cratesEnabled = ecoCfg.crates !== false
```

The `?? default` value in each guard is always identical to the value in `config/defaults.json`. A user or project override that sets a key to `null` or omits it falls through to the `??` fallback.

### Disabling an ecosystem

Add to `~/.claude/sentinel.json` or `<project>/.claude/sentinel.json`:

```json
{
  "ecosystems": {
    "crates": false
  }
}
```

The deep-merge in `config.mjs` applies user → project precedence; setting any sub-key `false` overrides the default `true`.

## Configuration

All nine keys live under the `registry` and `ecosystems` top-level sections of `config/defaults.json`. They are overridable at user (`~/.claude/sentinel.json`) or project (`.claude/sentinel.json`) scope.

| Key | Default | Type | Notes |
|-----|---------|------|-------|
| `registry.cacheTtlHours` | `1` | number | Cache entry lifetime |
| `registry.minAgeDays` | `14` | number | Package age floor for `allow` |
| `registry.minWeeklyDownloads` | `100` | number | Download floor; npm/PyPI only |
| `registry.requireHomepage` | `true` | boolean | Require `homepage` or `repository` |
| `registry.timeoutMs` | `250` | number | Per-fetch HTTP timeout |
| `registry.cacheMaxEntries` | `1024` | number | LRU eviction ceiling |
| `ecosystems.npm` | `true` | boolean | Enable npm registry checks |
| `ecosystems.pypi` | `true` | boolean | Enable PyPI registry checks |
| `ecosystems.crates` | `true` | boolean | Enable crates.io registry checks |

## Testing

```bash
node --test tests/config.test.mjs   # includes the new registry/ecosystems assertion
node --test tests/                  # full suite, zero regressions
make validate                       # manifest + hook config + self-test + node --test
```

The new test `'defaults include populated registry and ecosystems sub-keys'` exercises `loadConfig({ home, cwd })` with empty temp directories, asserting each of the nine sub-keys by value and type.

## Notes

- `minWeeklyDownloads` is stored in defaults even though crates.io has no weekly-download count. The policy layer (`registry-policy.mjs`, spec-05) skips rule 3 (`low_downloads`) for the crates ecosystem.
- `requireHomepage: true` uses the `!== false` guard idiom in consumers so the rule is active even if the key is absent. Both `?? true` and `!== false` are acceptable for spec-05.
- `timeoutMs: 250` is the per-fetch `AbortSignal.timeout` budget. The hook-level `"timeout": 5` (seconds) in `hooks/sentinel.json` is a separate outer deadline; both exist and serve different purposes.
- `cacheMaxEntries: 1024` is an entry count, not a byte limit. Eviction happens before each write in `registry-cache.mjs`.
- Adding sub-keys inside existing top-level objects is additive and safe: `deepMerge` in `config.mjs` recurses into plain objects, and no prior test pinned `registry` or `ecosystems` to `{}`.
