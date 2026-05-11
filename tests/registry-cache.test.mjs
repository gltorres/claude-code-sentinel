// Registry cache tests — Sprint 05, Spec 04.
// Covers: load missing, load corrupt, getCached hit, getCached miss (TTL),
// set+flush+load round-trip, eviction, write to read-only dir (fail-open),
// and resolveCachePath honouring CLAUDE_PLUGIN_DATA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveCachePath,
  loadCache,
  getCached,
  setCached,
  flushCache,
} from '../src/sentinel/registry-cache.mjs'

const NOW = Date.now()
const TTL = 3_600_000 // 1 hour in ms

// (a) loadCache on a path that does not exist returns an empty object.
test('loadCache missing file returns {}', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const result = loadCache(join(tmp, 'no-such-file.json'))
  assert.deepEqual(result, {})
})

// (b) loadCache on a file containing invalid JSON returns an empty object (fail-open).
test('loadCache corrupt JSON returns {}', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const cachePath = join(tmp, 'cache.json')
  writeFileSync(cachePath, '{ this is not valid json }{{{')
  const result = loadCache(cachePath)
  assert.deepEqual(result, {})
})

// (c) getCached returns the entry when ts is within TTL.
test('getCached returns entry when within TTL', () => {
  const cache = {}
  const key = 'npm:lodash'
  const value = { decision: 'allow', reason: null, rule: null }
  setCached(cache, key, value, NOW - 100) // stored 100 ms ago
  const hit = getCached(cache, key, TTL, NOW)
  assert.ok(hit !== undefined, 'expected a cache hit')
  assert.equal(hit.decision, 'allow')
})

// (d) getCached returns undefined when ts is past TTL.
test('getCached returns undefined past TTL', () => {
  const cache = {}
  const key = 'npm:fake-pkg'
  const value = { decision: 'deny', reason: 'not found', rule: 'registry.not_found' }
  // Store the entry with a ts 2 hours in the past
  setCached(cache, key, value, NOW - 2 * TTL)
  const miss = getCached(cache, key, TTL, NOW)
  assert.equal(miss, undefined)
})

// (e) setCached + flushCache + loadCache round-trip preserves all fields.
test('set + flush + load round-trip preserves data', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const cachePath = join(tmp, 'cache.json')
  const cache = {}
  const key = 'pypi:requests'
  const value = { decision: 'ask', reason: 'package is too new', rule: 'registry.too_new' }
  setCached(cache, key, value, NOW)
  flushCache(cachePath, cache, 1024)
  const loaded = loadCache(cachePath)
  assert.ok(loaded[key], 'expected key to survive round-trip')
  assert.equal(loaded[key].decision, 'ask')
  assert.equal(loaded[key].rule, 'registry.too_new')
  assert.equal(loaded[key].ts, NOW)
})

// (f) flushCache evicts oldest entries when count exceeds maxEntries.
test('flushCache evicts oldest entries down to maxEntries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const cachePath = join(tmp, 'cache.json')
  const maxEntries = 5
  const total = maxEntries + 5 // insert 10, evict 5

  const cache = {}
  for (let i = 0; i < total; i++) {
    // Spread ts so oldest entries are unambiguously identifiable
    setCached(cache, `npm:pkg-${i}`, { decision: 'allow', reason: null, rule: null }, NOW + i)
  }
  flushCache(cachePath, cache, maxEntries)
  const loaded = loadCache(cachePath)
  const remaining = Object.keys(loaded)
  assert.equal(remaining.length, maxEntries, `expected ${maxEntries} entries, got ${remaining.length}`)
  // The oldest 5 (pkg-0 through pkg-4) should be gone
  for (let i = 0; i < total - maxEntries; i++) {
    assert.ok(!loaded[`npm:pkg-${i}`], `pkg-${i} should have been evicted`)
  }
  // The newest 5 (pkg-5 through pkg-9) should survive
  for (let i = total - maxEntries; i < total; i++) {
    assert.ok(loaded[`npm:pkg-${i}`], `pkg-${i} should survive eviction`)
  }
})

// (g) flushCache writing to a read-only directory swallows the error (fail-open).
test('flushCache to read-only directory does not throw', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const roDir = join(tmp, 'readonly')
  // Create a subdirectory, write a file into it, then make it read-only
  mkdirSync(roDir)
  const cachePath = join(roDir, 'cache.json')
  writeFileSync(cachePath, '{}')
  chmodSync(roDir, 0o444) // remove write permission from the directory

  const cache = { 'npm:react': { ts: NOW, decision: 'allow', reason: null, rule: null } }
  // Must not throw
  assert.doesNotThrow(() => flushCache(cachePath, cache, 1024))

  // Restore permissions so the temp dir can be cleaned up by the OS
  chmodSync(roDir, 0o755)
})

// (h) resolveCachePath honours the CLAUDE_PLUGIN_DATA environment variable.
test('resolveCachePath uses CLAUDE_PLUGIN_DATA when set', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-cache-'))
  const resolved = resolveCachePath({ CLAUDE_PLUGIN_DATA: tmp })
  assert.equal(resolved, join(tmp, 'cache.json'))
})
