# Bash Policy and Config Defaults

**Task ID:** sprint-04-03
**Date:** 2026-05-10
**Specification:** specs/sprint-04-bash-exfil-deny/spec-03-bash-policy-and-defaults.md

## Overview

This feature introduces `src/sentinel/bash-policy.mjs`, the decision core for Bash exfiltration detection in Sprint 04. It consumes the parsed segment tree from `bash-walker.mjs`, evaluates each segment's candidate paths against the existing `matchPath` oracle, and applies a command-class policy matrix to return a `{ decision, rule, matched, matched_segment }` envelope. The `config/defaults.json` `bash` section is also populated with canonical deny/allow command lists, and `hook.mjs` is wired to route `Bash` tool events through `evaluateBash`.

## What Was Built

- `src/sentinel/bash-policy.mjs` — pure decision function `evaluateBash` that classifies bash commands as `allow`, `deny`, or `ask`
- Populated `config/defaults.json` `bash` section with 22 deny commands and 8 value-stripping commands
- Updated `src/sentinel/hook.mjs` to dispatch `Bash` tool events through `evaluateBash` and emit structured deny/ask/allow responses
- Extended `hook.mjs --self-test` to iterate both `tests/fixtures/paths/` and `tests/fixtures/bash/` directories
- 11 bash fixture JSON files under `tests/fixtures/bash/` covering all acceptance-criteria cases
- Test suites: `tests/bash-policy.test.mjs` (12 cases), `tests/bash-tokenizer.test.mjs`, `tests/bash-walker.test.mjs`, extended `tests/hook.test.mjs`

## Technical Implementation

### Files Modified

- `src/sentinel/bash-policy.mjs`: New module — exports `evaluateBash({ command, cwd, home, config })`
- `config/defaults.json`: Replaced `"bash": {}` placeholder with fully populated bash policy config
- `src/sentinel/hook.mjs`: Added `evaluateBash` import; wired `Bash` branch in `PreToolUse` dispatch; extended `--self-test` to cover both fixture directories
- `src/sentinel/audit.mjs`: Minor updates for bash-aware audit context
- `tests/bash-policy.test.mjs`: New — 12 unit test cases covering all 8 AC-mapped commands plus exotic and allow paths
- `tests/bash-tokenizer.test.mjs`: New — 230-line tokenizer test suite
- `tests/bash-walker.test.mjs`: New — 173-line walker test suite
- `tests/hook.test.mjs`: Extended with 83 lines of bash hook integration tests
- `tests/fixtures/bash/*.json`: 11 fixture files for `--self-test` dispatch

### Key Changes

- **`evaluateBash` decision algorithm**: Walk → check exotic → iterate segments → collect candidate paths → `matchPath` per path → apply command-class matrix (value-strip allowance → count-bounded allowance → deny). First deny terminates; all-clear returns allow.
- **Candidate path extraction**: Positional args with `/`, `~`, or file extension; `@`-prefixed values (e.g. `curl --data-binary @.env`) stripped of leading `@`; only `<` (stdin read) redirects — write redirects (`>`, `>>`, `2>`, etc.) are excluded as they are not exfil vectors.
- **Value-strip allowance**: Commands in `valueStrippingCommands` (`wc`, `file`, `stat`, `ls`, `du`, `shasum`, `sha256sum`, `md5sum`) are allowed even when they touch secret paths, because their output is metadata (counts/sizes), not file content.
- **Count-bounded allowance**: `grep -c` / `grep --count` and bare `wc` are safe because output is a count; handled by `isCountBounded` independent of the value-strip list.
- **Fail-closed for unknown commands**: Any command not in `denyCommands` and not in `valueStrippingCommands` that touches a secret path returns `rule: 'bash.unknown-command-touching-secret'` — deny rather than allow.
- **`matched_segment` safety**: Capped at 80 characters and scrubbed through the `sk-ant-` regex before storage, preventing API key leakage via audit logs.
- **Exotic escalation**: `walk()` returning `exotic: true` (heredocs, `$(...)`, backticks, brace/arithmetic expansions, unbalanced quotes) immediately returns `{ decision: 'ask', rule: 'bash.exotic' }` without evaluation.
- **Hook wiring**: `hook.mjs` `Bash` branch calls `evaluateBash`, emits `permissionDecision: 'deny'/'ask'/'allow'`, and populates the audit `decisionCtx` envelope with `rule`, `matched`, and `matched_segment`.
- **Extended `--self-test`**: Now iterates `fixtureDirs = ['paths', 'bash']`; uses key-subset matching (`expectKeys.every(...)`) instead of full-object equality, enabling sparse fixture `expect` objects.

## How to Use

1. Sentinel automatically intercepts `Bash` tool calls via the `PreToolUse` hook — no manual invocation needed.
2. When a bash command reads a secret file (e.g. `cat .env`), the hook blocks it with a deny reason: `Sentinel: bash segment 'cat .env' reads **/.env (bash.cat)`.
3. When a bash command has an unanalysable shape (heredoc, subshell), the hook escalates with `ask`: `Sentinel: bash shape not statically analysable; confirm before running`.
4. Safe commands (`cat README.md`, `wc -l .env`, `grep -c FOO .env`) pass through with `permissionDecision: 'allow'`.

## Configuration

`config/defaults.json` `bash` section:

```json
"bash": {
  "denyCommands": ["cat","head","tail","less","more","bat","view","xxd","hexdump",
                   "base64","grep","rg","awk","sed","perl","cp","mv","tee",
                   "pbcopy","xclip","nc","curl"],
  "warnCommands": [],
  "allowValueStripping": true,
  "valueStrippingCommands": ["wc","file","stat","ls","du","shasum","sha256sum","md5sum"]
}
```

Override any of these in your user (`~/.claude/sentinel.json`) or project (`.claude/sentinel.json`) config. Setting `allowValueStripping: false` disables the value-strip allowance — `wc .env` would be denied.

## Testing

```bash
# Unit tests for bash-policy
node --test tests/bash-policy.test.mjs

# Full suite (zero regressions)
node --test tests/

# In-process fixture self-test (covers both paths/ and bash/ fixtures)
node src/sentinel/hook.mjs --self-test

# Full plugin validation
make validate
```

Key test scenarios verified:
- `cat .env` → `deny` (rule: `bash.cat`)
- `wc -l .env` → `allow` (value-strip allowance)
- `cat .env | pbcopy` → `deny` on first segment (`bash.cat`)
- `cp .env /tmp/x` → `deny` (rule: `bash.cp`)
- `cat .env > /tmp/x` → `deny` (`cat` reads secret; write redirect ignored)
- `grep -c FOO .env` → `allow` (count-bounded)
- `grep FOO .env` → `deny` (rule: `bash.grep`)
- `ls && cat .env` → `deny` (first deny wins in compound command)
- `echo hello && wc -l .env` → `allow`
- `cat <<EOF\nhello\nEOF` → `ask` (exotic heredoc shape)

## Notes

- Write redirects (`>`, `>>`, `2>`, `2>>`, `&>`, `>&`) are intentionally excluded from candidate path extraction — they are output destinations, not exfil vectors. Only `<` (stdin read) redirects are evaluated.
- `cp .env /tmp/x`: both args are candidate paths; `matchPath` denies on `.env` and the loop short-circuits before reaching `/tmp/x`.
- The `evaluateBash` return envelope always includes all four fields (`decision`, `rule`, `matched`, `matched_segment`) with `null` on allow/ask — unlike `matchPath` which omits fields on allow. This ensures Spec 4 hook wiring and Spec 5 fixture assertions receive a fully-shaped object.
- Hook wiring (`hook.mjs` Bash branch) arrived in this sprint alongside `bash-policy.mjs` rather than a separate spec, because the policy module is a prerequisite for any meaningful hook output.
