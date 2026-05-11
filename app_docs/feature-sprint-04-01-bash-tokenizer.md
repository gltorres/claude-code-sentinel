# Bash Tokenizer

**Task ID:** sprint-04-01
**Date:** 2026-05-10
**Specification:** specs/sprint-04-bash-exfil-deny/spec-01-bash-tokenizer.md

## Overview

Implements a vendored, zero-dependency POSIX shell tokenizer at `src/sentinel/bash-tokenizer.mjs` that converts a raw bash command string into a flat token array. The module is the foundational building block for bash exfiltration detection in Sprint 04, consumed by `bash-walker` (Spec 2) and `bash-policy` (Spec 3). It never throws, handles all quote modes and variable references, and signals `exotic: true` for shell shapes that cannot be safely analyzed statically.

## What Was Built

- `src/sentinel/bash-tokenizer.mjs` — pure ESM module exporting `tokenize(commandString) → { tokens, exotic }`
- `tests/bash-tokenizer.test.mjs` — 30+ `test()` blocks covering all token types and edge cases
- `src/sentinel/bash-walker.mjs` — segment splitter built on top of the tokenizer
- `src/sentinel/bash-policy.mjs` — exfiltration policy evaluator using the walker
- `config/defaults.json` — `bash` config section with allow/deny defaults
- `tests/fixtures/bash/` — 11 fixture JSON files for self-test harness
- Hook wiring in `src/sentinel/hook.mjs` connecting `evaluateBash` to the `Bash` tool branch
- Extended audit and test coverage across all new modules

## Technical Implementation

### Files Modified

- `src/sentinel/bash-tokenizer.mjs`: New file — single-pass character scanner exporting `tokenize`
- `src/sentinel/bash-walker.mjs`: New file — splits token arrays into structured `Segment` objects
- `src/sentinel/bash-policy.mjs`: New file — evaluates exfiltration risk per segment and emits allow/deny/ask decisions
- `src/sentinel/hook.mjs`: Wires `evaluateBash` into the `Bash` tool branch of the `PreToolUse` handler
- `src/sentinel/audit.mjs`: Minor extension to support bash decision audit records
- `config/defaults.json`: Added `bash` section with `allowValueStripping`, `valueStrippingCommands`, and path deny defaults
- `tests/bash-tokenizer.test.mjs`: New test file — 30+ unit tests
- `tests/bash-walker.test.mjs`: New test file — walker unit tests
- `tests/bash-policy.test.mjs`: New test file — policy evaluation tests
- `tests/hook.test.mjs`: Extended with bash hook integration tests
- `tests/fixtures/bash/*.json`: 11 fixture files for in-process self-test

### Key Changes

- **State machine tokenizer**: Four scanner states (`DEFAULT`, `IN_SINGLE`, `IN_DOUBLE`, `IN_COMMENT`) implemented as integer constants; single character-by-character pass, O(n) in input length.
- **Token shape**: Each token carries `{ type: 'word' | 'op' | 'redirect', text, raw }` — `text` has quotes stripped and escapes resolved; `raw` preserves the exact source characters.
- **Exotic detection**: Heredoc (`<<`), process substitution (`<(`, `>(`), command substitution (`$(`), backtick, and unbalanced quotes all set `exotic: true`. The flag is monotonic — once set it never clears, so the full token array is still returned alongside the flag.
- **Operator precedence**: Longest-match-first ordering ensures `&&` beats `&`, `>>` beats `>`, `2>>` beats `2>`, and `&>` beats `&` when multiple operators share a common prefix.
- **$VAR opacity**: `$VAR`, `${VAR}` references are passed through as opaque word fragments — their contents are never expanded, keeping analysis static and deterministic.

## How to Use

The tokenizer is consumed by `bash-walker` and is not called directly from hook code. For tests or direct use:

```js
import { tokenize } from './src/sentinel/bash-tokenizer.mjs'

const { tokens, exotic } = tokenize('cat .env | pbcopy')
// exotic → false
// tokens → [
//   { type: 'word',     text: 'cat',    raw: 'cat' },
//   { type: 'word',     text: '.env',   raw: '.env' },
//   { type: 'op',       text: '|',      raw: '|' },
//   { type: 'word',     text: 'pbcopy', raw: 'pbcopy' },
// ]

const { exotic: ex2 } = tokenize('cat .env << EOF')
// ex2 → true  (heredoc triggers exotic)
```

Token types:

| `type`     | Meaning                                          | Examples                     |
|------------|--------------------------------------------------|------------------------------|
| `word`     | Command name, flag, or path argument             | `cat`, `-c`, `.env`, `$HOME` |
| `op`       | Separator operator                               | `\|`, `&&`, `\|\|`, `;`, `&` |
| `redirect` | I/O redirect operator (next `word` is the target)| `>`, `>>`, `<`, `2>`, `&>`  |

## Configuration

No configuration is read by the tokenizer itself — it is a pure function. The policy layer (`bash-policy.mjs`) reads from the `bash` section of `config/defaults.json`:

```json
"bash": {
  "allowValueStripping": true,
  "valueStrippingCommands": ["wc", "shasum", "md5", "cksum"]
}
```

## Testing

```bash
# Tokenizer unit tests only
node --test tests/bash-tokenizer.test.mjs

# Full test suite (includes walker, policy, hook integration)
node --test tests/

# In-process self-test with bash fixtures
node src/sentinel/hook.mjs --self-test

# Full validation gate
make validate
```

Fixture files under `tests/fixtures/bash/` follow the same shape as `tests/fixtures/paths/` — each is a JSON object with `input`, `expected.decision`, and `expected.rule` fields.

## Notes

- The tokenizer has **zero `import` statements** and no runtime dependencies, following the project's vendor-everything policy (same pattern as `src/sentinel/glob.mjs`).
- `consumeDollar` is a plain unexported function (not a closure) so it can be reasoned about independently; it does not mutate scanner state.
- `WORD_BREAK` is a `Set` for O(1) membership checks in the hot loop rather than a regex.
- The `2>` and `2>>` redirect patterns are matched before the generic word-accumulation branch to prevent a bare `2` from being emitted as a `word` token followed by a `>` redirect.
- Total tokenizer LOC: ~250; total test LOC: ~230 — within spec limits.
