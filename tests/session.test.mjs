// Session audit reader and banner composer tests — Sprint 07, Spec 01.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { summariseAuditWindow, composeBanner } from '../src/sentinel/session.mjs'

// Build a minimal config pointing audit.path at the given file path.
function makeConfig(auditPath) {
  return { audit: { path: auditPath, maxSizeMb: 10 } }
}

// Build a synthetic audit line as a JSON string for a given event and age in days.
// now must be an epoch ms value.
function makeLine(event, ageMs, now) {
  const ts = new Date(now - ageMs).toISOString()
  return JSON.stringify({
    id: 'TEST0000000000000000000000',
    ts,
    session_id: 'test-session',
    cwd: '/tmp',
    event,
    hook: 'PreToolUse',
    tool: null,
    rule: null,
    matched: null,
    input_summary: {},
    decision: 'allow',
    metadata: {},
  })
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

// --- summariseAuditWindow ---

test('missing audit log — returns empty summary (hasAny false, all counts zero)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const config = makeConfig(join(tmp, 'nonexistent-audit.jsonl'))
  const result = summariseAuditWindow({ config, now: Date.now() })
  assert.equal(result.hasAny, false)
  assert.equal(result.counts.block, 0)
  assert.equal(result.counts.scrub, 0)
  assert.equal(result.counts.ask, 0)
})

test('empty audit log file — returns empty summary', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const auditPath = join(tmp, 'audit.jsonl')
  writeFileSync(auditPath, '')
  const config = makeConfig(auditPath)
  const result = summariseAuditWindow({ config, now: Date.now() })
  assert.equal(result.hasAny, false)
  assert.equal(result.counts.block, 0)
})

test('mixed-event log within 7d — correct counts per bucket', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const now = Date.now()
  const lines = [
    makeLine('block', 1 * ONE_DAY_MS, now),
    makeLine('block', 2 * ONE_DAY_MS, now),
    makeLine('scrub', 3 * ONE_DAY_MS, now),
    makeLine('ask',   4 * ONE_DAY_MS, now),
    makeLine('warn',  5 * ONE_DAY_MS, now), // warn must be excluded
  ]
  writeFileSync(auditPath, lines.join('\n') + '\n')
  const config = makeConfig(auditPath)
  const result = summariseAuditWindow({ config, now })
  assert.equal(result.hasAny, true)
  assert.equal(result.counts.block, 2, 'block count must be 2')
  assert.equal(result.counts.scrub, 1, 'scrub count must be 1')
  assert.equal(result.counts.ask, 1, 'ask count must be 1')
})

test('entries older than 7d are excluded from counts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const now = Date.now()
  const lines = [
    makeLine('block', 1 * ONE_DAY_MS, now),  // inside 7d — counts
    makeLine('block', 8 * ONE_DAY_MS, now),  // outside 7d — excluded
    makeLine('scrub', 9 * ONE_DAY_MS, now),  // outside 7d — excluded
  ]
  writeFileSync(auditPath, lines.join('\n') + '\n')
  const config = makeConfig(auditPath)
  const result = summariseAuditWindow({ config, now })
  assert.equal(result.counts.block, 1, 'only the within-7d block must be counted')
  assert.equal(result.counts.scrub, 0, 'scrub outside 7d must not be counted')
  assert.equal(result.hasAny, true)
})

test('malformed line is skipped without throwing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const now = Date.now()
  const lines = [
    makeLine('block', 1 * ONE_DAY_MS, now),
    '{not valid json {{{{',
    makeLine('scrub', 2 * ONE_DAY_MS, now),
  ]
  writeFileSync(auditPath, lines.join('\n') + '\n')
  const config = makeConfig(auditPath)
  let result
  assert.doesNotThrow(() => {
    result = summariseAuditWindow({ config, now })
  }, 'summariseAuditWindow must never throw')
  assert.equal(result.counts.block, 1)
  assert.equal(result.counts.scrub, 1)
})

test('warn events are excluded from all counts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-session-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const now = Date.now()
  const lines = [
    makeLine('warn', 1 * ONE_DAY_MS, now),
    makeLine('warn', 2 * ONE_DAY_MS, now),
  ]
  writeFileSync(auditPath, lines.join('\n') + '\n')
  const config = makeConfig(auditPath)
  const result = summariseAuditWindow({ config, now })
  assert.equal(result.hasAny, false, 'warn-only log must yield hasAny:false')
  assert.equal(result.counts.block, 0)
  assert.equal(result.counts.scrub, 0)
  assert.equal(result.counts.ask, 0)
})

// --- composeBanner ---

test('banner length is always under 500 characters', () => {
  const longCounts = { block: 9999, scrub: 9999, ask: 9999 }
  const banner = composeBanner({ counts: longCounts, hasAny: true })
  assert.ok(banner.length < 500, `banner length ${banner.length} must be < 500`)
})

test('banner always contains "next-turn-only" and "PreToolUse"', () => {
  const banner = composeBanner({ counts: { block: 1, scrub: 0, ask: 0 }, hasAny: true })
  assert.ok(banner.includes('next-turn-only'), 'banner must include "next-turn-only"')
  assert.ok(banner.includes('PreToolUse'), 'banner must include "PreToolUse"')
})

test('empty banner contains "no events yet"', () => {
  const banner = composeBanner({ counts: { block: 0, scrub: 0, ask: 0 }, hasAny: false })
  assert.ok(banner.includes('no events yet'), 'empty banner must include "no events yet"')
  assert.ok(banner.includes('next-turn-only'), 'empty banner must include "next-turn-only"')
  assert.ok(banner.includes('PreToolUse'), 'empty banner must include "PreToolUse"')
  assert.ok(banner.length < 500, 'empty banner must be under 500 chars')
})

test('banner with events includes count strings', () => {
  const banner = composeBanner({ counts: { block: 7, scrub: 3, ask: 2 }, hasAny: true })
  // Canonical example from research §4.2
  assert.ok(banner.includes('7 blocks'), 'banner must include "7 blocks"')
  assert.ok(banner.includes('3 scrubs'), 'banner must include "3 scrubs"')
  assert.ok(banner.includes('2 asks'), 'banner must include "2 asks"')
})

test('banner pluralises singular counts correctly', () => {
  const banner = composeBanner({ counts: { block: 1, scrub: 1, ask: 1 }, hasAny: true })
  assert.ok(banner.includes('1 block'), 'singular block must not be "blocks"')
  assert.ok(!banner.includes('1 blocks'), '"1 blocks" must not appear')
  assert.ok(banner.includes('1 scrub'), 'singular scrub must not be "scrubs"')
  assert.ok(banner.includes('1 ask'), 'singular ask must not be "asks"')
})
