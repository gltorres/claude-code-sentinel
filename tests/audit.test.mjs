// Audit writer tests — Sprint 02, Spec 3.
// Covers schema shape, ULID format, field enum membership, secret suppression,
// size-cap rotation, and single-level rotation overwrite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writeAuditLine, summariseInput, tailAuditEntries, findAuditEntryById, summariseByEventClass } from '../src/sentinel/audit.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXPECTED_KEYS = [
  'id', 'ts', 'session_id', 'cwd', 'event', 'hook',
  'tool', 'rule', 'matched', 'input_summary', 'decision', 'metadata',
]

const VALID_EVENTS = new Set(['block', 'ask', 'scrub', 'warn'])
const VALID_DECISIONS = new Set(['deny', 'ask', 'allow'])
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

// Build a minimal synthetic config pointing the audit path at a temp dir
function makeTempConfig(tmpDir) {
  return { audit: { path: join(tmpDir, 'audit.jsonl'), maxSizeMb: 10 } }
}

// (a) A single writeAuditLine call produces one JSON-parseable line with all
// twelve PRD §10 fields in the documented order.
test('writeAuditLine produces one parseable line with all twelve fields in order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/foo.txt' } })
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(parsed), EXPECTED_KEYS)
})

// (b) The id field matches the 26-char Crockford-base32 ULID alphabet.
test('id matches ULID alphabet and length', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.match(parsed.id, ULID_RE)
})

// (c) event is one of {block, ask, scrub, warn} and decision is one of {deny, ask, allow}.
test('event and decision values are within their allowed sets', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'SessionStart', {})
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.ok(VALID_EVENTS.has(parsed.event), `event '${parsed.event}' not in allowed set`)
  assert.ok(VALID_DECISIONS.has(parsed.decision), `decision '${parsed.decision}' not in allowed set`)
})

// (d) Feeding the secret-bash.json fixture in produces an input_summary whose
// stringified JSON does NOT contain the fake secret.
test('secret-bash fixture input_summary excludes verbatim secret', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  const fixturePath = resolve(__dirname, 'fixtures', 'secret-bash.json')
  const eventJson = JSON.parse(readFileSync(fixturePath, 'utf8'))
  writeAuditLine(config, 'PreToolUse', eventJson)
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  const summary = JSON.stringify(parsed.input_summary)
  assert.ok(
    !summary.includes('sk-ant-FAKE_FAKE_FAKE_DO_NOT_USE'),
    'input_summary must not contain the verbatim fake secret'
  )
})

// (e) Setting maxSizeMb to a tiny value and writing enough bytes causes rotation:
// audit.jsonl.1 exists afterwards and the active audit.jsonl is small.
test('exceeding maxSizeMb causes rotation to audit.jsonl.1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const auditPath = join(tmp, 'audit.jsonl')
  // Write a seed file that is already over the tiny cap
  const config = { audit: { path: auditPath, maxSizeMb: 0.0001 } }
  // First write to create and pre-fill the file above the cap
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo seed' } })
  // Manually inflate the file past the cap (0.0001 MB = ~102 bytes)
  const padding = 'x'.repeat(200)
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + padding)
  const inflatedSize = statSync(auditPath).size
  // Second write should trigger rotation
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo trigger' } })
  assert.ok(existsSync(auditPath + '.1'), 'audit.jsonl.1 should exist after rotation')
  const freshSize = statSync(auditPath).size
  assert.ok(freshSize < inflatedSize, `active audit.jsonl should be small after rotation, got ${freshSize} bytes`)
})

// (f) A second over-cap write overwrites the previous audit.jsonl.1 (single-level rotation, no .2).
test('second rotation overwrites audit.jsonl.1 without creating .2', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const config = { audit: { path: auditPath, maxSizeMb: 0.0001 } }

  // First rotation cycle
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo a' } })
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + 'x'.repeat(200))
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo b' } })
  // audit.jsonl.1 now exists from first rotation

  // Inflate the newly created audit.jsonl for second rotation
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + 'x'.repeat(200))
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo c' } })

  assert.ok(existsSync(auditPath + '.1'), 'audit.jsonl.1 should still exist after second rotation')
  assert.ok(!existsSync(auditPath + '.2'), 'audit.jsonl.2 must NOT exist — single-level rotation only')
})

// (g) Passing a deny decision context writes event:'block', decision:'deny',
// rule, and matched verbatim into the audit record.
test('audit deny line carries block/deny fields', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  const denyCtx = { event: 'block', decision: 'deny', rule: 'paths.deny', matched: '**/.env' }
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Read', tool_input: { file_path: '/project/.env' } },
    denyCtx,
  )
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.equal(parsed.event, 'block')
  assert.equal(parsed.decision, 'deny')
  assert.equal(parsed.rule, 'paths.deny')
  assert.equal(parsed.matched, '**/.env')
})

// (h) summariseInput with tool === 'NotebookEdit' returns the notebook path.
test('summariseInput returns notebook path for NotebookEdit tool', () => {
  const summary = summariseInput(
    'PreToolUse',
    'NotebookEdit',
    { tool_input: { notebook_path: '/project/analysis.ipynb' } },
  )
  assert.deepEqual(summary, { path: '/project/analysis.ipynb' })
})

// (i) Calling writeAuditLine without a decision argument keeps the Sprint 02
// defaults: event:'warn' and decision:'allow'.
test('writeAuditLine without decision arg keeps warn/allow defaults', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/ok.txt' } })
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.equal(parsed.event, 'warn')
  assert.equal(parsed.decision, 'allow')
  assert.equal(parsed.rule, null)
  assert.equal(parsed.matched, null)
})

// (j) For a Bash deny decision, input_summary.matched_segment is populated from
// decisionCtx.matched_segment (not null). Top-level field order is unchanged.
// NOTE: We do NOT re-assert Object.keys order here — that is covered by test (a)
// at lines 31-40. Only the sub-object value changes.
test('Bash deny audit line has non-null input_summary.matched_segment', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-bash-'))
  const config = makeTempConfig(tmp)
  const denyCtx = {
    event: 'block',
    decision: 'deny',
    rule: 'bash.deny',
    matched: '**/.env',
    matched_segment: 'cat .env',
  }
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Bash', tool_input: { command: 'cat .env' } },
    denyCtx,
  )
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.equal(parsed.event, 'block')
  assert.equal(parsed.decision, 'deny')
  assert.equal(parsed.rule, 'bash.deny')
  assert.equal(
    parsed.input_summary.matched_segment,
    'cat .env',
    'matched_segment must be populated from decisionCtx on a Bash deny',
  )
})

// ── audit-readers: tailAuditEntries — empty file ──────────────────────────────

test('tailAuditEntries returns empty array for empty audit file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-tail-'))
  const auditPath = join(tmp, 'audit.jsonl')
  writeFileSync(auditPath, '')
  const config = { audit: { path: auditPath } }
  const results = tailAuditEntries({ config, n: 10, paths: [auditPath] })
  assert.deepEqual(results, [])
})

// ── audit-readers: tailAuditEntries — single entry ───────────────────────────

test('tailAuditEntries returns a single entry from a one-line file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-tail-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const config = { audit: { path: auditPath } }
  // Write one real record via the writer so the schema is guaranteed correct
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
    { event: 'warn', decision: 'allow', rule: null, matched: null },
  )
  const results = tailAuditEntries({ config, n: 5, paths: [auditPath] })
  assert.equal(results.length, 1)
  assert.equal(typeof results[0].id, 'string')
  assert.equal(results[0].hook, 'PreToolUse')
})

// ── audit-readers: tailAuditEntries — across rotation boundary ───────────────

test('tailAuditEntries spans primary and rotated file to reach n results', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-tail-'))
  const primaryPath = join(tmp, 'audit.jsonl')
  const rotatedPath = primaryPath + '.1'
  const config = { audit: { path: primaryPath } }

  // Write 2 entries to the rotated file (older), 1 entry to primary (newer)
  const olderRecord1 = JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(Date.now() - 3000).toISOString(),
    session_id: '', cwd: '/old', event: 'block', hook: 'PreToolUse',
    tool: 'Bash', rule: 'bash.deny', matched: '**/.env',
    input_summary: {}, decision: 'deny', metadata: {},
  })
  const olderRecord2 = JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FBV',
    ts: new Date(Date.now() - 4000).toISOString(),
    session_id: '', cwd: '/old2', event: 'ask', hook: 'PreToolUse',
    tool: 'Read', rule: null, matched: null,
    input_summary: {}, decision: 'ask', metadata: {},
  })
  writeFileSync(rotatedPath, olderRecord1 + '\n' + olderRecord2 + '\n')
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Read', tool_input: { file_path: '/foo.txt' } },
    { event: 'warn', decision: 'allow', rule: null, matched: null },
  )

  // Request 3 entries: should come from both files (1 from primary, 2 from rotated)
  const results = tailAuditEntries({ config, n: 3, paths: [primaryPath, rotatedPath] })
  assert.equal(results.length, 3, 'should return 3 entries spanning both files')
  // The primary-file entry is newest, so it should be first
  assert.equal(results[0].cwd !== '/old' && results[0].cwd !== '/old2', true,
    'first result should be from the primary (newer) file')
})

// ── audit-readers: findAuditEntryById — hit and miss ─────────────────────────

test('findAuditEntryById returns matching record on hit, null on miss', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-byid-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const targetRecord = JSON.stringify({
    id: TARGET_ID,
    ts: new Date().toISOString(),
    session_id: '', cwd: '/some/path', event: 'block', hook: 'PreToolUse',
    tool: 'Bash', rule: 'bash.deny', matched: '.env',
    input_summary: { command_prefix: 'cat .env', matched_segment: null },
    decision: 'deny', metadata: {},
  })
  writeFileSync(auditPath, targetRecord + '\n')

  const config = { audit: { path: auditPath } }
  // Hit: id present in the file
  const found = findAuditEntryById({ config, id: TARGET_ID, paths: [auditPath] })
  assert.ok(found !== null, 'should find the record')
  assert.equal(found.id, TARGET_ID)
  assert.equal(found.event, 'block')

  // Miss: id not present
  const notFound = findAuditEntryById({
    config,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FZZ',
    paths: [auditPath],
  })
  assert.equal(notFound, null, 'should return null for an id not in the file')
})

// ── audit-readers: summariseByEventClass — 7-day window cutoff ───────────────

test('summariseByEventClass counts only records within the sinceMs window', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-summary-'))
  const auditPath = join(tmp, 'audit.jsonl')
  const now = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

  // Inside window — 1 day ago
  const inside = JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    session_id: '', cwd: '/', event: 'block', hook: 'PreToolUse',
    tool: 'Bash', rule: 'bash.deny', matched: '.env',
    input_summary: {}, decision: 'deny', metadata: {},
  })
  // Outside window — 8 days ago
  const outside = JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FBV',
    ts: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    session_id: '', cwd: '/', event: 'ask', hook: 'PreToolUse',
    tool: 'Read', rule: null, matched: null,
    input_summary: {}, decision: 'ask', metadata: {},
  })
  writeFileSync(auditPath, inside + '\n' + outside + '\n')

  const config = { audit: { path: auditPath } }
  const sinceMs = now - sevenDaysMs
  const result = summariseByEventClass({ config, sinceMs, paths: [auditPath] })

  assert.equal(result.block, 1, 'block count should be 1 (inside window)')
  assert.equal(result.ask, 0, 'ask count should be 0 (outside window)')
  assert.equal(result.scrub, 0)
  assert.equal(result.warn, 0)
  assert.equal(result.total, 1, 'total should be 1')
})
