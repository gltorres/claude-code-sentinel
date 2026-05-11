import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBashBranch } from '../src/sentinel/hook.mjs'

// ─── Test harness helpers ──────────────────────────────────────────────────────

function envelope(eventName, extra = {}) {
  return { hookSpecificOutput: { hookEventName: eventName, ...extra } }
}

// Capture what would be emitted without exiting the process.
function makeCapture() {
  let captured = null
  function emitFn(obj, decisionCtx) {
    captured = { obj, decisionCtx }
  }
  return { captured: () => captured, emitFn }
}

// Stub fetchFn that returns a canned 404 response (package not found).
function stubFetch404() {
  return async (_url, _opts) => ({ ok: false, status: 404, json: async () => ({}) })
}

// Stub fetchFn that returns a clean 200 response for a widely-used package.
function stubFetchClean({ ageDays = 200, weeklyDownloads = 50000, hasHomepage = true, hasRepository = true } = {}) {
  return async (url, _opts) => {
    if (url.includes('api.npmjs.org/downloads')) {
      return { ok: true, status: 200, json: async () => ({ downloads: weeklyDownloads }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        time: { created: new Date(Date.now() - ageDays * 86_400_000).toISOString() },
        homepage: hasHomepage ? 'https://example.com' : null,
        repository: hasRepository ? { url: 'https://github.com/example/pkg' } : null,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': {} },
      }),
    }
  }
}

// Stub fetchFn that throws a network error.
function stubFetchNetworkError() {
  return async (_url, _opts) => { throw new TypeError('fetch failed') }
}

const BASE_OPTS = {
  cwd: '/tmp/project',
  home: '/tmp/home',
  config: {
    paths: {
      deny: ['**/.env', '**/.env.*'],
    },
    bash: {
      denyCommands: ['cat'],
    },
  },
  now: Date.now(),
  cache: {},
  envelope,
}

// ─── Sprint 04 regression tests — registry never runs for deny/ask from evaluateBash ─

test('runBashBranch: Sprint 04 deny (cat .env) short-circuits before registry', async () => {
  let fetchCalled = false
  const fetchFn = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) } }
  const { captured, emitFn } = makeCapture()
  await runBashBranch({ ...BASE_OPTS, command: 'cat .env', fetchFn, emit: emitFn })
  assert.equal(captured().obj.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(captured().decisionCtx.event, 'block')
  assert.equal(captured().decisionCtx.decision, 'deny')
  assert.equal(fetchCalled, false, 'fetch must NOT be called when evaluateBash denies')
})

test('runBashBranch: Sprint 04 ask (heredoc) short-circuits before registry', async () => {
  let fetchCalled = false
  const fetchFn = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) } }
  const { captured, emitFn } = makeCapture()
  await runBashBranch({ ...BASE_OPTS, command: 'cat <<EOF\nfoo\nEOF', fetchFn, emit: emitFn })
  assert.equal(captured().obj.hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(captured().decisionCtx.event, 'ask')
  assert.equal(fetchCalled, false, 'fetch must NOT be called when evaluateBash asks')
})

// ─── Acceptance criterion 1 — fake package → deny ─────────────────────────────

test('runBashBranch: npm install fake-pkg (404) → deny, event: block, rule: registry.not_found', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install slopsquatted-fake-pkg-xyzzy',
    fetchFn: stubFetch404(),
    emit: emitFn,
  })
  const { obj, decisionCtx } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(
    obj.hookSpecificOutput.permissionDecisionReason.startsWith('Sentinel: '),
    'reason must start with BANNER_PREFIX',
  )
  assert.equal(decisionCtx.event, 'block')
  assert.equal(decisionCtx.decision, 'deny')
  assert.equal(decisionCtx.rule, 'registry.not_found')
  assert.ok(decisionCtx.matched, 'matched should be the package name')
})

// ─── Acceptance criterion 2 — <14-day-old package → ask ──────────────────────

test('runBashBranch: npm install brand-new-pkg (<14 days) → ask, rule: registry.too_new', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install brand-new-pkg',
    fetchFn: stubFetchClean({ ageDays: 3, weeklyDownloads: 5000, hasHomepage: true, hasRepository: true }),
    emit: emitFn,
  })
  const { obj, decisionCtx } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'ask')
  assert.ok(obj.hookSpecificOutput.permissionDecisionReason.startsWith('Sentinel: '))
  assert.equal(decisionCtx.event, 'ask')
  assert.equal(decisionCtx.decision, 'ask')
  assert.equal(decisionCtx.rule, 'registry.too_new')
})

// ─── Acceptance criterion 3 — <100/wk downloads → ask ────────────────────────

test('runBashBranch: npm install niche-pkg (<100 wk downloads) → ask, rule: registry.low_downloads', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install niche-pkg',
    fetchFn: stubFetchClean({ ageDays: 200, weeklyDownloads: 40, hasHomepage: true, hasRepository: true }),
    emit: emitFn,
  })
  const { obj, decisionCtx } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(decisionCtx.rule, 'registry.low_downloads')
})

// ─── Acceptance criterion 4 — no homepage and no repo → ask ──────────────────

test('runBashBranch: npm install orphaned-pkg (no homepage, no repo) → ask, rule: registry.no_source', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install orphaned-pkg',
    fetchFn: stubFetchClean({ ageDays: 200, weeklyDownloads: 5000, hasHomepage: false, hasRepository: false }),
    emit: emitFn,
  })
  const { obj, decisionCtx } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(decisionCtx.rule, 'registry.no_source')
})

// ─── Acceptance criterion 5 — widely-used package → silent allow ──────────────

test('runBashBranch: npm install lodash (clean) → allow', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install lodash',
    fetchFn: stubFetchClean({ ageDays: 3000, weeklyDownloads: 1_000_000, hasHomepage: true, hasRepository: true }),
    emit: emitFn,
  })
  const { obj } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'allow')
})

// ─── Acceptance criterion 6 — network failure → allow + warn ──────────────────

test('runBashBranch: network failure → allow, event: warn, rule: registry.unavailable', async () => {
  const { captured, emitFn } = makeCapture()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install some-pkg',
    fetchFn: stubFetchNetworkError(),
    emit: emitFn,
  })
  const { obj, decisionCtx } = captured()
  assert.equal(obj.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(decisionCtx.event, 'warn')
  assert.equal(decisionCtx.rule, 'registry.unavailable')
})

// ─── Latency assertions ────────────────────────────────────────────────────────

test('runBashBranch: cache-hit path completes in < 50 ms', async () => {
  const cache = {
    'npm:lodash': {
      ts: Date.now() - 1000,
      decision: 'allow',
      reason: null,
      rule: null,
    },
  }
  let fetchCalled = false
  const fetchFn = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) } }
  const { captured, emitFn } = makeCapture()
  const t0 = performance.now()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install lodash',
    fetchFn,
    cache,
    emit: emitFn,
  })
  const elapsed = performance.now() - t0
  assert.equal(fetchCalled, false, 'fetch must NOT be called on cache-hit')
  assert.ok(elapsed < 50, `cache-hit latency ${elapsed.toFixed(1)} ms >= 50 ms`)
  assert.equal(captured().obj.hookSpecificOutput.permissionDecision, 'allow')
})

test('runBashBranch: cache-miss path completes in < 300 ms', async () => {
  const fetchFn = stubFetchClean({ ageDays: 500, weeklyDownloads: 500_000, hasHomepage: true, hasRepository: true })
  const { captured, emitFn } = makeCapture()
  const t0 = performance.now()
  await runBashBranch({
    ...BASE_OPTS,
    command: 'npm install some-popular-package',
    fetchFn,
    cache: {},
    emit: emitFn,
  })
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 300, `cache-miss latency ${elapsed.toFixed(1)} ms >= 300 ms`)
  assert.equal(captured().obj.hookSpecificOutput.permissionDecision, 'allow')
})
