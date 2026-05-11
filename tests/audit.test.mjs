// Audit writer tests — Sprint 02, Spec 3.
// Covers schema shape, ULID format, field enum membership, secret suppression,
// size-cap rotation, and single-level rotation overwrite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writeAuditLine, summariseInput, tailAuditEntries, findAuditEntryById, summariseByEventClass } from '../src/sentinel/audit.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Module-scope SENTINEL_HOME redirect: every writeAuditLine in this test file
// now persists a pointer file. Without this default redirect, the pointer
// would land in the developer's real ~/.claude/sentinel/.audit-path on every
// test run. Individual tests that need a different override set/restore it
// inline; the module default keeps tests fail-safe.
if (!process.env.SENTINEL_HOME) {
  process.env.SENTINEL_HOME = mkdtempSync(join(tmpdir(), 'sentinel-test-home-'))
}

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

// Synthetic decisionCtx used by tests that exercise writer mechanics rather
// than policy — must include a rule so it is not suppressed as a no-op warn.
const SYN = { event: 'warn', decision: 'allow', rule: 'test.synthetic', matched: null }

// (a) A single writeAuditLine call produces one JSON-parseable line with all
// twelve PRD §10 fields in the documented order.
test('writeAuditLine produces one parseable line with all twelve fields in order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/foo.txt' } }, SYN)
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
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, SYN)
  const raw = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim()
  const parsed = JSON.parse(raw.split('\n')[0])
  assert.match(parsed.id, ULID_RE)
})

// (c) event is one of {block, ask, scrub, warn} and decision is one of {deny, ask, allow}.
test('event and decision values are within their allowed sets', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'SessionStart', {}, SYN)
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
  writeAuditLine(config, 'PreToolUse', eventJson, SYN)
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
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo seed' } }, SYN)
  // Manually inflate the file past the cap (0.0001 MB = ~102 bytes)
  const padding = 'x'.repeat(200)
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + padding)
  const inflatedSize = statSync(auditPath).size
  // Second write should trigger rotation
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo trigger' } }, SYN)
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
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo a' } }, SYN)
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + 'x'.repeat(200))
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo b' } }, SYN)
  // audit.jsonl.1 now exists from first rotation

  // Inflate the newly created audit.jsonl for second rotation
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + 'x'.repeat(200))
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo c' } }, SYN)

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

// (i) Calling writeAuditLine without a decision argument is now suppressed
// as a no-op warn (Phase 1 noise cut). Verify nothing is written.
test('writeAuditLine without decision arg is suppressed (no-op warn)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(config, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/ok.txt' } })
  const auditPath = join(tmp, 'audit.jsonl')
  assert.equal(existsSync(auditPath), false, 'no-op warn must not create the audit file')
})

// (i.b) Phase 1: explicit no-op warn shape (warn + null rule + null matched)
// is also suppressed regardless of how it arrives.
test('writeAuditLine: explicit no-op warn (no rule, no matched) is suppressed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-audit-noop-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Read' },
    { event: 'warn', decision: 'allow', rule: null, matched: null },
  )
  const auditPath = join(tmp, 'audit.jsonl')
  assert.equal(existsSync(auditPath), false, 'no audit file should have been created')
})

// (i.c) A warn line that carries a rule is still recorded (forensic value).
test('writeAuditLine: warn with a rule is still recorded', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-warn-rule-'))
  const config = makeTempConfig(tmp)
  writeAuditLine(
    config,
    'PreToolUse',
    { tool_name: 'Bash' },
    { event: 'warn', decision: 'allow', rule: 'registry.unavailable', matched: null },
  )
  const lines = readFileSync(join(tmp, 'audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.rule, 'registry.unavailable')
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
    { event: 'warn', decision: 'allow', rule: 'test.synthetic', matched: null },
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
    { event: 'warn', decision: 'allow', rule: 'test.synthetic', matched: null },
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

// ── audit pointer file: cross-env writer/reader divergence ────────────────────

// Helper: redirect homedir() resolution for the in-process audit module by
// setting SENTINEL_HOME, which audit.mjs's auditPointerPath() honours. Returns
// a cleanup function that restores both SENTINEL_HOME and CLAUDE_PLUGIN_DATA.
function withEnv(overrides) {
  const prior = {}
  for (const key of Object.keys(overrides)) {
    prior[key] = process.env[key]
    if (overrides[key] === undefined) delete process.env[key]
    else process.env[key] = overrides[key]
  }
  return () => {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  }
}

// Reproduces the live-plugin/CLI env split: hook writes with
// CLAUDE_PLUGIN_DATA set, /sentinel-review reads without it. Before the fix
// the deny line was invisible to the reader. After the fix the pointer file
// at <home>/.claude/sentinel/.audit-path lets the reader discover the
// writer's path.
test('audit pointer file unlocks cross-env readability', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'sentinel-writerA-'))
  const homeOverride = mkdtempSync(join(tmpdir(), 'sentinel-home-'))
  const sentinelDir = join(homeOverride, '.claude', 'sentinel')
  mkdirSync(sentinelDir, { recursive: true })

  // Writer env: CLAUDE_PLUGIN_DATA=dirA, SENTINEL_HOME=homeOverride so the
  // pointer lands under the test-owned home, not the developer's real home.
  const restore = withEnv({
    CLAUDE_PLUGIN_DATA: dirA,
    SENTINEL_HOME: homeOverride,
  })

  try {
    // Empty config — writer falls through to the CLAUDE_PLUGIN_DATA branch.
    writeAuditLine(
      {},
      'PreToolUse',
      { tool_name: 'Read', tool_input: { file_path: '/x/.env' } },
      { event: 'block', decision: 'deny', rule: 'paths.deny', matched: '**/.env' },
    )

    // Pointer file exists and points at dirA/audit.jsonl.
    const pointerPath = join(sentinelDir, '.audit-path')
    assert.ok(existsSync(pointerPath), 'pointer file must exist after writeAuditLine')
    assert.equal(
      readFileSync(pointerPath, 'utf8').trim(),
      join(dirA, 'audit.jsonl'),
      'pointer must contain the resolved audit path',
    )

    // Reader env: clear CLAUDE_PLUGIN_DATA but keep SENTINEL_HOME so the
    // reader's listAuditPaths consults the same pointer file.
    delete process.env.CLAUDE_PLUGIN_DATA
    const records = tailAuditEntries({ config: {}, n: 5 })
    assert.equal(records.length, 1, 'reader must discover the deny record via pointer')
    assert.equal(records[0].event, 'block')
    assert.equal(records[0].decision, 'deny')
    assert.equal(records[0].matched, '**/.env')
  } finally {
    restore()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(homeOverride, { recursive: true, force: true })
  }
})

// Stale-pointer hygiene: if the pointer points at a path that no longer
// exists, tailAuditEntries returns an empty result rather than throwing.
test('audit pointer pointing at a missing path is filtered cleanly', () => {
  const staleDir = mkdtempSync(join(tmpdir(), 'sentinel-stale-'))
  const homeOverride = mkdtempSync(join(tmpdir(), 'sentinel-home-stale-'))
  const sentinelDir = join(homeOverride, '.claude', 'sentinel')
  mkdirSync(sentinelDir, { recursive: true })

  // Write a pointer that references a path under staleDir, then nuke staleDir
  // so the referenced audit file no longer exists.
  const pointerPath = join(sentinelDir, '.audit-path')
  const stalePath = join(staleDir, 'audit.jsonl')
  writeFileSync(pointerPath, stalePath + '\n')
  rmSync(staleDir, { recursive: true, force: true })

  const restore = withEnv({
    CLAUDE_PLUGIN_DATA: undefined,
    SENTINEL_HOME: homeOverride,
  })

  try {
    // No throws; empty result because no candidate path exists. The fallback
    // primary (homeOverride/.claude/sentinel/audit.jsonl) also doesn't exist,
    // so the merged result is empty — exactly the desired fail-open behaviour.
    const records = tailAuditEntries({ config: {}, n: 5 })
    assert.ok(Array.isArray(records), 'tailAuditEntries must return an array')
    assert.equal(records.length, 0, 'stale pointer must produce zero records, not throw')
  } finally {
    restore()
    rmSync(homeOverride, { recursive: true, force: true })
  }
})
