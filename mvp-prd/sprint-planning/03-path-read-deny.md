# Sprint 03: Path-Based Read Deny

**Band**: pretool · **Blocked by**: 02

## Goal
Ship the first protective layer Sentinel was built for: deny reads of secret-bearing paths through `Read`, `Edit`, `Grep`, `Glob`, and `NotebookEdit` before the file's contents ever reach the model or the on-disk transcript. This is the **primary defence** in the PRD — every other matcher exists because this one can be bypassed.

## What we're building
A vendored glob matcher (small enough to live next to the rest of the lib code — supports `**`, `*`, `?`, character classes) and a path matcher that consults the merged config's `paths.deny` and `paths.allow` lists. The PreToolUse hook entry, when invoked with a Read-family tool, extracts the target path from `tool_input.file_path`, asks the path matcher, and emits a `deny` decision with a reason naming the matched rule when the path is denied.

Allow rules take precedence over deny rules so legitimate `.env.example` and `*.pub` reads remain unobstructed.

Every block writes one audit-log entry via the Sprint 02 audit module.

## Acceptance criteria
1. Read on `.env` is denied with a `permissionDecisionReason` that names the matched rule (e.g. `Sentinel: read of **/.env blocked by paths.deny`).
2. Read on `.env.example`, `.env.sample`, `.env.template` is allowed despite the `**/.env.*` deny pattern.
3. `Edit`, `Grep`, `Glob`, and `NotebookEdit` on `.env` are all denied via the same matcher.
4. A read on `~/.ssh/id_ed25519` is denied; a read on `~/.ssh/id_ed25519.pub` is allowed.
5. Every deny writes an audit entry with the matched rule and glob.
6. At least 10 fixture payloads cover the path-deny matrix and pass through `node src/sentinel/hook.mjs --self-test`.
7. Hook latency stays under ~20 ms wall-clock per invocation in the test harness, including Node cold start.

## Context & constraints

**Default deny list** (PRD §6.2 — ship these as the shipped defaults; users can extend in `.claude/sentinel.json`):
- `**/.env`, `**/.env.*` (with allowlist for `.env.example`, `.env.sample`, `.env.template`)
- `**/.envrc`
- `**/credentials*.json`
- `**/secrets*.y?ml`
- `**/.bashrc`, `**/.zshrc`, `**/.profile`, `**/.bash_profile`
- `**/*.pem`, `**/*.key` (allowlist: `**/*.pub`, `**/*.public.*`)
- `**/.aws/credentials`, `**/.aws/config`
- `**/.kube/config`
- `**/.ssh/id_*` (excluding `*.pub`)
- `**/.npmrc`, `**/.pypirc`, `**/.git-credentials`
- `**/.netrc`

**Hook decision envelope** (corrected against the Claude Code hook API — the PRD's exit-code assumptions are wrong):
```json
{"hookSpecificOutput": {
  "hookEventName": "PreToolUse",
  "permissionDecision": "deny",
  "permissionDecisionReason": "Sentinel: read of **/.env blocked by paths.deny"
}}
```
Written to stdout, then `process.exit(0)`. Never use `process.exit(1)` to block — exit 1 is treated as a soft error and does **not** deny.

**Path source.** Read the target path from `tool_input.file_path` on the event JSON piped to stdin. Do **not** assume `cwd` is the project root — Claude Code runs the hook from the plugin directory context, while `cwd` in the stdin payload reflects the session working directory. Use the stdin `cwd` only to resolve relative paths before matching.

**Latency budget:** < 20 ms total, including Node cold-start (~30 ms — the budget assumes the entry script avoids dynamic `import()`).

## Dependencies
- Sprint 02: Reads `paths.deny` / `paths.allow` from the merged config and writes deny events through the audit module.
- Sprint 01: Uses the hook entry script's `PreToolUse` dispatch slot.

## Open questions
—
