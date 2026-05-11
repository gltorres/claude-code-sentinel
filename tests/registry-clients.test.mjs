// registry clients tests — Sprint 05.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPackageMetadata } from '../src/sentinel/registry-clients.mjs'

const TIMEOUT = 250

// ── Stub factory ──────────────────────────────────────────────────────────────

// Returns a fetchFn that maps URL prefixes to canned responses.
// Each entry in `routes` is { match: string|RegExp, status, body, throws }.
function makeStub(routes) {
  return async function stubFetch(url) {
    for (const route of routes) {
      const hit = typeof route.match === 'string'
        ? url.includes(route.match)
        : route.match.test(url)
      if (!hit) continue
      if (route.throws) throw new Error(route.throws)
      const body = route.body ?? {}
      return {
        status: route.status ?? 200,
        ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
        json: async () => JSON.parse(JSON.stringify(body)),
      }
    }
    // Default: 404
    return { status: 404, ok: false, json: async () => ({}) }
  }
}

// ── NPM: 200 with full metadata ───────────────────────────────────────────────

test('npm: 200 response returns status ok with normalised meta', async () => {
  const created = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const fetchFn = makeStub([
    {
      match: 'registry.npmjs.org',
      status: 200,
      body: {
        time: { created },
        homepage: 'https://example.com',
        repository: { url: 'https://github.com/example/pkg' },
      },
    },
    {
      match: 'api.npmjs.org',
      status: 200,
      body: { downloads: 5000 },
    },
  ])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'lodash', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.ok(r.meta.ageDays >= 29 && r.meta.ageDays <= 31, 'ageDays should be ~30')
  assert.equal(r.meta.weeklyDownloads, 5000)
  assert.equal(r.meta.hasHomepage, true)
  assert.equal(r.meta.hasRepository, true)
})

// ── NPM: 404 → not_found ──────────────────────────────────────────────────────

test('npm: 404 response returns status not_found', async () => {
  const fetchFn = makeStub([{ match: 'registry.npmjs.org', status: 404 }])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'definitely-not-real-xyzzy', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'not_found')
  assert.equal(r.meta, undefined)
})

// ── NPM: 500 → error ──────────────────────────────────────────────────────────

test('npm: 500 response returns status error', async () => {
  const fetchFn = makeStub([{ match: 'registry.npmjs.org', status: 500 }])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'pkg', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── NPM: network throw → error ────────────────────────────────────────────────

test('npm: network throw returns status error without re-throwing', async () => {
  const fetchFn = makeStub([{ match: 'registry.npmjs.org', throws: 'ECONNREFUSED' }])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'pkg', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── NPM: AbortSignal.timeout abort → error ────────────────────────────────────

test('npm: AbortError from timeout returns status error', async () => {
  const fetchFn = makeStub([{ match: 'registry.npmjs.org', throws: 'AbortError' }])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'pkg', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── NPM: malformed JSON → error ───────────────────────────────────────────────

test('npm: malformed JSON body returns status error', async () => {
  const fetchFn = async () => ({
    status: 200,
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token') },
  })
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'pkg', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── NPM: scoped package URL encoding ─────────────────────────────────────────

test('npm: scoped package name is URL-encoded in the fetch URL', async () => {
  const seenUrls = []
  const created  = new Date(Date.now() - 5 * 86_400_000).toISOString()
  const fetchFn  = async (url) => {
    seenUrls.push(url)
    if (url.includes('api.npmjs.org')) {
      return { status: 200, ok: true, json: async () => ({ downloads: 100 }) }
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ time: { created }, homepage: null, repository: null }),
    }
  }
  await fetchPackageMetadata({ ecosystem: 'npm', name: '@scope/pkg', fetchFn, timeoutMs: TIMEOUT })
  const pkgUrl = seenUrls.find(u => u.includes('registry.npmjs.org'))
  assert.ok(pkgUrl, 'should have fetched registry.npmjs.org')
  // The slash in @scope/pkg must be encoded
  assert.ok(!pkgUrl.includes('@scope/pkg'), 'raw slash must not appear in URL')
  assert.ok(pkgUrl.includes('%40scope%2Fpkg') || pkgUrl.includes('%40scope'), 'scope must be encoded')
})

// ── NPM: downloads fetch fails gracefully ────────────────────────────────────

test('npm: downloads fetch failure leaves weeklyDownloads null, status is still ok', async () => {
  const created = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const fetchFn = makeStub([
    {
      match: 'registry.npmjs.org',
      status: 200,
      body: { time: { created }, homepage: 'https://x.com', repository: null },
    },
    { match: 'api.npmjs.org', throws: 'ECONNREFUSED' },
  ])
  const r = await fetchPackageMetadata({ ecosystem: 'npm', name: 'pkg', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.equal(r.meta.weeklyDownloads, null)
})

// ── PyPI: 200 with full metadata ──────────────────────────────────────────────

test('pypi: 200 response returns status ok with normalised meta', async () => {
  const uploadTime = new Date(Date.now() - 100 * 86_400_000).toISOString()
  const fetchFn = makeStub([
    {
      match: 'pypi.org',
      status: 200,
      body: {
        info: {
          home_page: 'https://example.com',
          project_urls: { Repository: 'https://github.com/example/pkg' },
        },
        releases: { '1.0.0': [{ upload_time_iso_8601: uploadTime }] },
      },
    },
    {
      match: 'pypistats.org',
      status: 200,
      body: { data: { last_week: 8000 } },
    },
  ])
  const r = await fetchPackageMetadata({ ecosystem: 'pypi', name: 'requests', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.ok(r.meta.ageDays >= 99 && r.meta.ageDays <= 101)
  assert.equal(r.meta.weeklyDownloads, 8000)
  assert.equal(r.meta.hasHomepage, true)
  assert.equal(r.meta.hasRepository, true)
})

// ── PyPI: 404 → not_found ─────────────────────────────────────────────────────

test('pypi: 404 response returns status not_found', async () => {
  const fetchFn = makeStub([{ match: 'pypi.org', status: 404 }])
  const r = await fetchPackageMetadata({ ecosystem: 'pypi', name: 'nonexistent-xyzzy', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'not_found')
})

// ── PyPI: network throw → error ───────────────────────────────────────────────

test('pypi: network throw returns status error', async () => {
  const fetchFn = makeStub([{ match: 'pypi.org', throws: 'ETIMEDOUT' }])
  const r = await fetchPackageMetadata({ ecosystem: 'pypi', name: 'requests', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── PyPI: weekly downloads via pypistats.org ──────────────────────────────────

test('pypi: weekly downloads come from pypistats.org, not pypi.org', async () => {
  const seenUrls = []
  const uploadTime = new Date(Date.now() - 200 * 86_400_000).toISOString()
  const fetchFn = async (url) => {
    seenUrls.push(url)
    if (url.includes('pypistats.org')) {
      return { status: 200, ok: true, json: async () => ({ data: { last_week: 12000 } }) }
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        info: { home_page: '', project_urls: {} },
        releases: { '0.1': [{ upload_time_iso_8601: uploadTime }] },
      }),
    }
  }
  const r = await fetchPackageMetadata({ ecosystem: 'pypi', name: 'flask', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.equal(r.meta.weeklyDownloads, 12000)
  assert.ok(seenUrls.some(u => u.includes('pypistats.org')), 'must have called pypistats.org')
})

// ── Crates: 200 with full metadata ────────────────────────────────────────────

test('crates: 200 response returns status ok with weeklyDownloads null', async () => {
  const createdAt = new Date(Date.now() - 500 * 86_400_000).toISOString()
  const fetchFn = makeStub([
    {
      match: 'crates.io',
      status: 200,
      body: {
        crate: {
          created_at: createdAt,
          homepage: 'https://serde.rs',
          repository: 'https://github.com/serde-rs/serde',
        },
      },
    },
  ])
  const r = await fetchPackageMetadata({ ecosystem: 'crates', name: 'serde', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.ok(r.meta.ageDays >= 499 && r.meta.ageDays <= 501)
  assert.equal(r.meta.weeklyDownloads, null, 'crates must always return weeklyDownloads: null')
  assert.equal(r.meta.hasHomepage, true)
  assert.equal(r.meta.hasRepository, true)
})

// ── Crates: 404 → not_found ───────────────────────────────────────────────────

test('crates: 404 response returns status not_found', async () => {
  const fetchFn = makeStub([{ match: 'crates.io', status: 404 }])
  const r = await fetchPackageMetadata({ ecosystem: 'crates', name: 'ghost-crate-xyzzy', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'not_found')
})

// ── Crates: network throw → error ────────────────────────────────────────────

test('crates: network throw returns status error', async () => {
  const fetchFn = makeStub([{ match: 'crates.io', throws: 'ECONNREFUSED' }])
  const r = await fetchPackageMetadata({ ecosystem: 'crates', name: 'serde', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})

// ── Crates: weeklyDownloads is always null ────────────────────────────────────

test('crates: weeklyDownloads is null even when crate data is present', async () => {
  const fetchFn = makeStub([
    {
      match: 'crates.io',
      status: 200,
      body: { crate: { created_at: new Date().toISOString(), homepage: null, repository: null } },
    },
  ])
  const r = await fetchPackageMetadata({ ecosystem: 'crates', name: 'tokio', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'ok')
  assert.equal(r.meta.weeklyDownloads, null)
})

// ── Unknown ecosystem → error ────────────────────────────────────────────────

test('unknown ecosystem returns status error', async () => {
  const fetchFn = makeStub([])
  const r = await fetchPackageMetadata({ ecosystem: 'rubygems', name: 'rails', fetchFn, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'error')
})
