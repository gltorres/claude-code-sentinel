# Bash Walker

**Task ID:** sprint-04-bash-exfil-deny / Spec 02
**Date:** 2026-05-10
**Specification:** specs/sprint-04-bash-exfil-deny/spec-02-bash-walker.md

## Overview

The bash walker (`src/sentinel/bash-walker.mjs`) is the second link in the Sprint 04 exfil-deny chain. It consumes the flat token stream produced by the bash tokenizer and splits it into structured `Segment` objects — one per logical command separated by `;`, `&&`, `||`, `|`, or `&`. Each segment exposes the command name, positional arguments, redirect pairs, and a `raw` source string that the audit log writes to `matched_segment`. If the upstream tokenizer marks the input exotic, the walker returns `{ segments: [], exotic: true }` immediately, signalling the hook to emit an `ask` decision.

## What Was Built

- `src/sentinel/bash-walker.mjs` — single-pass O(n) walker; named export `walk`; no default export; imports only `./bash-tokenizer.mjs`
- `tests/bash-walker.test.mjs` — 17 `test()` blocks covering single segments, compound commands, pipelines, redirects, exotic propagation, background `&`, trailing separators, and quoted arguments

## Technical Implementation

### Files Modified

- `src/sentinel/bash-walker.mjs`: new module; exports `walk(commandString) → { segments, exotic }`
- `tests/bash-walker.test.mjs`: new unit test suite using `node:test` + `node:assert/strict`

### Key Changes

- **Single-pass token iteration**: one `while` loop over the token array; no look-ahead beyond one token (for redirect targets). O(n) in token count.
- **Separator vs. redirect discrimination**: `SEPARATORS` set (`; && || | &`) and `REDIRECT_OPS` set (`> >> < 2> 2>> &> >&`) are checked on each `op`/`redirect` token before the word-accumulation path.
- **Redirect extraction**: when a `redirect`-type (or `op` in `REDIRECT_OPS`) token is encountered, the walker peeks at `tokens[i+1]`. If the next token is not a `word`, the walker returns `{ segments: [], exotic: true }` (fail-closed). Otherwise, the redirect pair `{ op, target }` is pushed onto `currentRedirects` and the target is **not** added to `args`.
- **Exotic fail-closed**: the tokenizer call is wrapped in `try/catch`; a throw is treated as exotic. An `exotic: true` result from the tokenizer also short-circuits immediately.
- **Empty-segment guard**: `flushSegment()` silently discards segments with zero words and zero redirects, preventing phantom segments from trailing or leading separators.

## How to Use

```js
import { walk } from './src/sentinel/bash-walker.mjs'

const { segments, exotic } = walk('cat .env | pbcopy')
// exotic === false
// segments[0] → { command: 'cat', args: ['.env'], redirects: [], raw: 'cat .env' }
// segments[1] → { command: 'pbcopy', args: [], redirects: [], raw: 'pbcopy' }

const exoticResult = walk('cat <<EOF\nfoo\nEOF')
// exoticResult.exotic === true
// exoticResult.segments → []
```

Callers (i.e., `bash-policy.mjs`) iterate `segments` and evaluate each `segment.command` and `segment.args` against the policy matrix. Per the policy semantics, **any** denied segment fails the entire command.

## Configuration

The walker has no configuration surface of its own. All policy decisions (allow/deny/ask) are made by the `bash-policy.mjs` caller using the structured segments this module produces.

## Testing

```bash
# This spec's unit tests
node --test tests/bash-walker.test.mjs

# Upstream dependency still green
node --test tests/bash-tokenizer.test.mjs

# Full suite, zero regressions
node --test tests/

# Full plugin validation
make validate
```

The test suite covers: single-command segments, `&&` / `;` / `||` / `|` compound splits, pipeline splitting, `>` / `>>` / `<` redirect extraction, `raw` field content, exotic propagation for heredocs / command substitution / process substitution, background `&` separator, trailing `;` edge case, and quoted arguments.

## Notes

- **`raw` field**: `flushSegment` joins `currentWords` with a space. The spec plan described using `tok.raw` concatenation, but the implementation uses the simpler `currentWords.join(' ')` approach which produces a reliable trimmed representation for the audit log's `matched_segment` field.
- **Token-type duality**: the tokenizer may emit redirect operators as either `type: 'redirect'` or `type: 'op'`; the walker handles both by checking `tok.type === 'redirect' || (tok.type === 'op' && REDIRECT_OPS.has(tok.text))`.
- **Chain position**: tokenizer (Spec 1) → **walker (Spec 2)** → policy (Spec 3) → hook integration (Spec 4) → fixtures/self-test (Spec 5). The walker is unaware of config, audit, or hook — it is a pure transformation function.
