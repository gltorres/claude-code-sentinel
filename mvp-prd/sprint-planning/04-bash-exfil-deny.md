# Sprint 04: Bash Exfil Deny

**Band**: pretool · **Blocked by**: 03

## Goal
Close the shell-shaped hole in the Sprint 03 path-deny. A user who can't `Read /Users/.../.env` can still ask Claude to run `cat .env`, `grep PASSWORD .env`, or `cp .env /tmp/x` via the `Bash` tool. This sprint blocks all of those paths before the command executes.

## What we're building
A vendored POSIX-shell tokenizer (~150 LOC — the patterns we care about are bounded: quoted strings, `;`, `&&`, `||`, `|`, `&`, redirects) and a bash walker that splits a command into segments and inspects each segment. The PreToolUse hook entry, when invoked with the `Bash` tool, runs the walker against `tool_input.command`, asks the Sprint 03 path matcher about any file argument it sees, and emits `deny` if any segment matches an exfil pattern against a secret path.

Value-stripping commands (which produce digests or counts, not content) are explicitly allowed against secret paths so legitimate operations like `wc -l .env` and `shasum .env` still work.

Every deny writes one audit-log entry naming the matched segment and rule.

## Acceptance criteria
1. `cat .env` is denied; `wc -l .env` is allowed.
2. `cat .env | pbcopy` is denied; `cp .env /tmp/x` is denied; `cat .env > /tmp/x` is denied.
3. `grep -c FOO .env` is allowed (count-only output); `grep FOO .env` is denied.
4. A compound command like `ls && cat .env` is denied — any deny segment fails the whole command.
5. `echo hello && wc -l .env` is allowed — every segment passes.
6. Audit entries record the matched segment, the matched path, and the rule that fired.
7. At least 10 Bash fixture payloads cover the exfil matrix and pass through `--self-test`.
8. Hook latency stays under ~50 ms wall-clock including Node cold start.

## Context & constraints

**Hard-deny commands when reading a secret path** (PRD §6.3): `cat`, `head`, `tail`, `less`, `more`, `bat`, `view`, `xxd`, `hexdump`, `base64`.

**Deny `grep`, `rg`, `awk`, `sed`, `perl`, `python -c`, `node -e`** against a secret path **unless** the output is bounded to a count: `grep -c`, `wc -l`. Anything else lets content escape via stdout.

**Deny redirection of a secret path into anything that prints, pipes, or copies.** Common exfil shapes:
- `cat <secret> | <anything>`
- `cp <secret> <somewhere>`
- `mv <secret> <somewhere>`
- `<command> > <secret>` is irrelevant (this is a *write*, not exfil) — leave it to the OS.
- `tee`, `pbcopy`, `xclip`, `nc`, `curl --data-binary @<secret>` — all denied.

**Allow value-stripping ops** (they reveal size/hash, not content): `wc`, `file`, `stat`, `ls -la`, `du`, `shasum`, `sha256sum`, `md5sum`. The config knob `bash.allowValueStripping` is on by default.

**Hook decision envelope** identical to Sprint 03. Exit 0 with the JSON; never exit 1 to block.

**Tokenizer scope.** The vendored tokenizer must handle: single and double-quoted strings (with escapes), `$VAR` and `${VAR}` references (treat as opaque — don't expand), comment stripping (`#` to end of line outside quotes), and the segment separators above. It does **not** need to be a complete POSIX shell parser — patterns beyond this list (process substitution, heredocs, etc.) should fall through to a conservative "ask" decision so we err on the side of safety without false-denying exotic legitimate commands.

**Latency budget:** < 50 ms including cold start. Tokenizing is cheap; the budget assumes no fetch and no fs reads beyond the audit log append.

## Dependencies
- Sprint 03: Reuses the path matcher and the `paths.deny` / `paths.allow` config.
- Sprint 02: Reads `bash.denyCommands`, `bash.warnCommands`, `bash.allowValueStripping` from config; writes audit lines.

## Open questions
—
