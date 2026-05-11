# Marketplace Manifest

**Task ID:** sprint-10/spec-01-marketplace-manifest
**Date:** 2026-05-11
**Specification:** specs/sprint-10-demo-and-launch/spec-01-marketplace-manifest.md

## Overview

This feature unblocks the Claude Code plugin install flow by adding the missing `.claude-plugin/marketplace.json` manifest. Without it, the `/plugin marketplace add` command fails silently, making the README install instructions non-functional. The change adds one JSON file, one new test file, and a one-line Makefile extension.

## What Was Built

- `.claude-plugin/marketplace.json` — minimal single-plugin marketplace manifest declaring `sentinel` at `./`
- `tests/marketplace.test.mjs` — three regression tests asserting plugin count, slug, and source path
- `Makefile` — `marketplace.json` added to the JSON-lint loop in the `validate` target

## Technical Implementation

### Files Modified

- `.claude-plugin/marketplace.json`: New file. Single-entry `plugins` array with `name: "sentinel"`, `source: "./"`, and a `description` mirroring `plugin.json`.
- `tests/marketplace.test.mjs`: New test file using `node:test` + `node:assert/strict`. Reads and parses `marketplace.json` from disk; asserts array length, slug, and source.
- `Makefile`: `.claude-plugin/marketplace.json` added to the `for` loop on the `validate` target's JSON-lint line. Also adds `clean-demo` target and wires the `demo` target to `tools/demo.mjs`.

### Key Changes

- `marketplace.json` declares `plugins[0].name === "sentinel"` so the install slug `sentinel@claude-code-sentinel` resolves correctly in the `/plugin install` command.
- `plugins[0].source === "./"` points the marketplace loader at the repository root where `plugin.json` lives.
- `make validate` now JSON-lints `marketplace.json` in the same Python loop as `plugin.json` and `hooks/sentinel.json`, catching malformed edits before a human attempts the install flow.
- The new test file is automatically picked up by `node --test tests/*.mjs` — no Makefile change needed for test discovery.
- `plugin.json` is unchanged; the existing `tests/manifest.test.mjs` undefined-field assertions are undisturbed.

## How to Use

1. Clone the repository.
2. Run `/plugin marketplace add ./claude-code-sentinel` in Claude Code — the marketplace loader reads `.claude-plugin/marketplace.json` and registers the `sentinel` plugin.
3. Run `/plugin install sentinel@claude-code-sentinel` — the slug resolves via the manifest and the plugin is installed.
4. Run `/reload-plugins` to activate.

To verify the manifest is valid without entering Claude Code:

```
make validate
```

Expected output includes `.claude-plugin/marketplace.json: ok` in the lint loop.

## Configuration

No configuration options. The manifest is a static JSON file. The `name` field (`"sentinel"`) must stay in sync with `.claude-plugin/plugin.json`'s `name` field — if the plugin slug is ever changed, both files must be updated.

## Testing

```
node --test tests/marketplace.test.mjs   # 3 passing tests
node --test tests/                       # full suite, 0 regressions
make validate                            # lint + tests + self-test
```

## Notes

- The `description` field in the marketplace manifest entry is optional for the loader but included for discoverability.
- Manual E2E verification (running `/plugin marketplace add` + `/plugin install` in a real Claude Code session) is the launch artifact check for AC 7 and is tracked in the spec-10-05 launch checklist — it is not automated here.
- This spec has no dependencies on other Sprint 10 specs and must be built first. Specs 10-02 through 10-05 all assume the install flow is working.
