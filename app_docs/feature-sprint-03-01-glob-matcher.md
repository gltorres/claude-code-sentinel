# Glob Matcher

**Task ID:** sprint-03-path-read-deny-1
**Date:** 2026-05-10
**Specification:** specs/sprint-03-path-read-deny/spec-01-glob-matcher.md

## Overview

A vendored, pure-function glob matcher module (`src/sentinel/glob.mjs`) that translates glob patterns into anchored `RegExp` objects and tests paths against them. It is the foundational dependency for the Sprint 03 path-deny system — the path matcher (Spec 2) calls into it to enforce `paths.deny` and `paths.allow` lists without embedding regex logic inline.

## What Was Built

- `src/sentinel/glob.mjs` — ESM module exporting `compileGlob(pattern) → RegExp` and `matchGlob(pattern, path) → boolean` with zero runtime dependencies and zero imports.
- `tests/glob.test.mjs` — 25-test suite covering all supported glob constructs and the four PRD canonical deny patterns.

## Technical Implementation

### Files Modified

- `src/sentinel/glob.mjs`: Created from scratch. Vendored glob-to-RegExp compiler; no imports; two named exports.
- `tests/glob.test.mjs`: Created from scratch. Full test suite using `node:test` and `node:assert/strict`.

### Key Changes

- **`compileGlob(pattern)`** compiles a glob pattern character-by-character into an anchored `RegExp`. It handles `**` (any segments including `/`), `*` (intra-segment wildcard), `?` (single non-`/` char), and `[…]` / `[!…]` character classes.
- **Anchoring rules**: patterns starting with `**/` get a `^(.*/?)?` prefix so they match at any depth (including depth 0). Patterns starting with `/` are anchored absolutely (`^`). Single-segment patterns without `/` are anchored strictly (`^…$`) so `*.md` does not match `docs/README.md`. Patterns with an embedded `/` but no `**/` prefix allow a leading path segment (`^(.*/?)?…$`).
- **POSIX negation translation**: `[!…]` inside a character class is converted to `[^…]` for JavaScript `RegExp` compatibility.
- **Stateful regex reset**: `REGEX_SPECIALS` uses the `/g` flag; `lastIndex` is reset to `0` after each `.test()` call inside the compiler loop to prevent position drift across iterations.
- **Zero imports**: the module is pure logic — no I/O, no Node built-ins, no `process.exit`. It follows the project's zero-runtime-dependency policy and ships as a self-contained vendored file (~110 LOC including comments).

## How to Use

```js
import { compileGlob, matchGlob } from './src/sentinel/glob.mjs'

// One-shot match
matchGlob('**/.env', '/home/user/proj/.env')  // → true
matchGlob('**/.env', '.env.example')           // → false

// Reusable compiled RegExp (cache for performance in hot paths)
const re = compileGlob('**/*.pem')
re.test('/etc/ssl/certs/server.pem')           // → true
re.test('/etc/ssl/certs/server.pub')           // → false
```

The caller is responsible for path resolution (tilde expansion, `cwd` joining) before passing paths to `matchGlob` — this module is pure pattern logic only.

## Configuration

No configuration required. The module is imported directly by the path matcher (`src/sentinel/paths.mjs`, Spec 2). The deny/allow glob patterns it compiles come from `config/defaults.json` under `paths.deny` and `paths.allow`.

## Testing

```bash
node --test tests/glob.test.mjs   # glob-specific tests only
node --test tests/                # full suite including prior Sprint 02 tests
make validate                     # full validation (manifest + hook config + self-test + node --test)
```

All 25 test cases pass with zero failures. Coverage includes: literal patterns, single-star intra-segment wildcard, `?` single-char wildcard, `**` multi-segment wildcard, character classes (`[abc]`, `[a-z]`, `[!a]`), leading-dot hidden files, absolute-path anchoring, `compileGlob` API (returns `RegExp`, reusable), and all four PRD canonical deny patterns (`**/.env`, `**/*.pem`, `**/.ssh/id_*`, `**/credentials*.json`).

## Notes

- `compileGlob` creates a new `RegExp` on every call. The path matcher (Spec 2) caches compiled regexps in a `Map<string, RegExp>` keyed by pattern string to avoid recompilation on each hook event.
- The `(.*\/)?` anchoring prefix makes the leading-path group optional, which is what allows `**/.env` to match the bare path `.env` (zero leading segments).
- Allow-overrides-deny logic is intentionally out of scope — that is Spec 2's responsibility. The deny patterns in this module are inclusive (e.g., `**/.ssh/id_*` matches `.pub` files); the allow list overrides them.
- The `REGEX_SPECIALS` constant escapes `. + ( ) { } | ^ $ [ ] \` — the exhaustive set of regex metacharacters that carry no glob meaning.
