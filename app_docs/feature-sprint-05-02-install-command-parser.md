# Install Command Parser

**Task ID:** sprint-05/spec-02-install-command-parser
**Date:** 2026-05-10
**Specification:** specs/sprint-05-registry-check/spec-02-install-command-parser.md

## Overview

Implements `src/sentinel/install-commands.mjs`, a pure synchronous parser that converts the output of `bash-walker.mjs` into an array of `{ ecosystem, name, segment }` registry-lookup records. It identifies what packages an install command would fetch — across npm, PyPI, and crates.io — without performing any network I/O, cache access, or policy decisions. This is the first step in the Sprint 05 registry-check pipeline, consumed by `registry-policy.mjs`.

## What Was Built

- `src/sentinel/install-commands.mjs` — zero-import ESM module exporting `parseInstallSegments`
- `tests/install-commands.test.mjs` — 26 `test()` blocks covering all acceptance cases

## Technical Implementation

### Files Modified

- `src/sentinel/install-commands.mjs`: New pure parser module (115 LOC). Named export `parseInstallSegments`, zero imports.
- `tests/install-commands.test.mjs`: New unit test suite (203 LOC). Self-contained `seg()` helper builds walked objects without calling `bash-walker.mjs`.

### Key Changes

- **`INSTALL_SPECS` map** — static module-level table mapping 7 binary names (`npm`, `pnpm`, `yarn`, `pip`, `pip3`, `uv`, `cargo`) to `{ ecosystem, verbs: Set }`. Construction cost paid once at module load.
- **`stripVersion(name)`** — normalises package name args by truncating at the first occurrence of `[ = < > ~ ! @` that is NOT at position 0. Preserves scoped npm packages (`@org/pkg`) while stripping version pinning (`@org/pkg@2.0` → `@org/pkg`).
- **`isFlag(arg)`** — returns `true` for args starting with `-`; used to skip `--save-dev`, `--user`, `-q`, etc. before treating positional args as package names.
- **`FILE_FLAGS` set** — `-r`, `--requirement`, `-c`, `--constraint` consume the following arg as a file path, not a package name (resolves pip `-r requirements.txt` trap).
- **`exotic` short-circuit** — returns `[]` immediately when `walked.exotic === true`, preventing any attempt to parse commands the tokenizer could not safely analyse.

## How to Use

`parseInstallSegments` is a pure function — import it and call it with the pre-walked result:

```js
import { parseInstallSegments } from './install-commands.mjs'
import { walk } from './bash-walker.mjs'

const walked = walk('npm install lodash react@18 @types/node@18')
const records = parseInstallSegments(walked, { ecosystems: { npm: true, pypi: true, crates: true } })
// [
//   { ecosystem: 'npm', name: 'lodash',      segment: { ... } },
//   { ecosystem: 'npm', name: 'react',       segment: { ... } },
//   { ecosystem: 'npm', name: '@types/node', segment: { ... } },
// ]
```

Each record carries:
- `ecosystem` — `'npm'` | `'pypi'` | `'crates'`
- `name` — normalised package name (version specifiers and extras stripped)
- `segment` — the original `Segment` object from `bash-walker.mjs` (for audit and policy use)

Return value is always an array and never throws.

## Configuration

The `ecosystems` option mirrors the `config.ecosystems` section from `config/defaults.json`. Setting a key to `false` suppresses all registry records for that ecosystem:

```js
// Disable PyPI checks while keeping npm and crates:
parseInstallSegments(walked, { ecosystems: { npm: true, pypi: false, crates: true } })
```

`pnpm`, `yarn`, and `npm` all map to `ecosystem: 'npm'` and are toggled together by `ecosystems.npm`.

## Testing

```bash
node --test tests/install-commands.test.mjs
```

The test file uses a self-contained `seg(commandLine)` helper that hand-splits command strings into walked objects — no dependency on `bash-walker.mjs`. This keeps tests isolated and fast.

Key acceptance cases covered:
- All 6 install command families (`npm install`, `npm i`, `pnpm add`, `yarn add`, `pip install`, `pip3 install`, `uv add`, `cargo add`)
- Scoped npm packages (`@babel/core`, `@types/node@18`)
- Version specifier stripping (`react@18`, `lodash==4.0.0`, `requests>=2.0`, `uvicorn[standard]`, `django~=4.2`)
- Flag-before-name patterns (`--save-dev`, `--user`)
- Multiple packages in one command
- Per-ecosystem `false` toggle
- Non-install commands (`cat`, `git push`) → `[]`
- `walked.exotic === true` → `[]`
- Bare `npm install` (no positional args) → `[]`
- `pip install -r requirements.txt` (file-driven) → `[]`

## Notes

- The module has zero `import` statements — all helpers are module-level declarations, consistent with the zero-import pattern of `src/sentinel/glob.mjs`.
- `stripVersion` walks from position 1 (never 0), so the leading `@` in scoped npm packages is always preserved; an inner `@` at position ≥1 triggers the version cut.
- `uv add` is treated as PyPI because `uv` resolves packages from PyPI by default. If `uv` gains a non-PyPI subcommand, a new `verbs` set entry in `INSTALL_SPECS` is sufficient to disambiguate.
- The sole planned consumer is `registry-policy.mjs` (spec-05). Spec-07 self-test fixtures exercise the full pipeline through the hook, not by calling this module directly.
- This module is intentionally scope-limited: no network I/O, no cache, no policy decision. Those are the responsibilities of `registry-clients.mjs`, `registry-cache.mjs`, and `registry-policy.mjs` respectively.
