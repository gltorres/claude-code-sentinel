# Sprint 05: Registry Check for Install Commands

**Band**: pretool · **Blocked by**: 04

## Goal
Catch slopsquatted packages — names Claude hallucinated, that an attacker has already registered on npm/PyPI/crates.io — before `npm install` / `pip install` / `cargo add` ships malware into the user's environment. Decision is fast (sub-300 ms, timeout-bounded) and fails open so offline workflows never break.

## What we're building
An install-command branch inside the Sprint 04 Bash walker. When a segment matches a supported install command, the hook fires an async `fetch()` against the registry, applies a decision tree to the response, and caches the result on disk. Network failures and timeouts fall through to `allow` with a warning audit entry — Sentinel must never make a developer's offline session feel broken.

Supported install commands:
- `npm install <pkg>`, `npm i <pkg>`
- `pnpm add <pkg>`
- `yarn add <pkg>`
- `pip install <pkg>`
- `uv add <pkg>`
- `cargo add <pkg>`

## Acceptance criteria
1. `npm install nonexistent-pkg-xxxxx-zzzzz` (a name registered nowhere) is denied with reason "package not found in registry — likely hallucinated".
2. A real package created in the last 14 days returns `ask` with reason citing the age in days.
3. A real npm/PyPI package with weekly downloads below 100 returns `ask` with reason citing downloads.
4. A real package with no homepage and no repository field returns `ask` with reason citing missing public source.
5. A widely-used, well-attested package (e.g. `lodash`, `requests`, `serde`) is allowed silently — no `ask`, no `deny`.
6. With `globalThis.fetch` stubbed to throw a network error, install commands are allowed with a warning audit entry.
7. Second invocation for the same `<ecosystem>:<name>` within the cache TTL hits the cache (verified by stubbed-fetch call count being 1, not 2).
8. The whole hook entry returns within 300 ms wall-clock for a cache miss and within 50 ms for a cache hit.
9. `node --test tests/` uses only stubbed `fetch` — no live network calls in CI.

## Context & constraints

**Registry endpoints:**
- npm: `https://registry.npmjs.org/<pkg>`
- PyPI: `https://pypi.org/pypi/<pkg>/json`
- crates: `https://crates.io/api/v1/crates/<pkg>`

**Decision tree** (PRD §6.4, with config-driven thresholds):
1. Registry returns 404 → `deny` ("package not found in registry — likely hallucinated").
2. Created < `registry.minAgeDays` (default 14) ago → `ask` ("very new package — confirm intent").
3. Weekly downloads < `registry.minWeeklyDownloads` (default 100) — npm and PyPI only — → `ask` ("low usage — confirm intent").
4. No homepage AND no repository field, when `registry.requireHomepage` is true → `ask` ("no public source — confirm intent").
5. All checks pass → `allow` silently.

**Per-fetch timeout:** Use `AbortSignal.timeout(registry.timeoutMs)` (default 250 ms). Per-fetch, not per-hook-invocation — but the hook-level `"timeout": 5` in the hook config still bounds worst-case.

**Cache.** On-disk LRU at `${CLAUDE_PLUGIN_DATA}/cache.json`. **Not** under `~/.claude/sentinel/` directly — `${CLAUDE_PLUGIN_DATA}` is the stable per-plugin data directory exposed by Claude Code and survives plugin updates. TTL: `registry.cacheTtlHours` (default 1). Keyed `<ecosystem>:<name>`. Load synchronously at hook start, write synchronously at hook exit (the cache is small enough that sync write is faster than spawning an async flush).

**Fail-open on errors.** Network timeout, DNS failure, non-2xx response other than 404, malformed JSON — all of these fall through to `allow` with `decision: allow, event: warn, rule: registry.unavailable` in the audit log. The point is to protect, not to nag.

**Per-hook timeout in `hooks/sentinel.json`:** set `"timeout": 5` seconds for this matcher so a stuck `fetch` can never hang a tool call.

**Hook decision envelope** same shape as Sprint 03/04. For an `ask` decision use `"permissionDecision": "ask"` (this is a valid value — do **not** confuse with the unrelated `"defer"` value used in non-interactive `-p` mode).

## Dependencies
- Sprint 04: This sprint extends the Bash walker with an install-command branch. The walker dispatches install segments here; non-install segments stay in Sprint 04's path.
- Sprint 02: Reads `registry.*` and `ecosystems.*` config; writes audit lines.

## Open questions
- crates.io has no weekly-download equivalent — confirm whether `registry.minWeeklyDownloads` is skipped for crates or whether a proxy metric (recent downloads on the version endpoint) is used.
