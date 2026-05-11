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
import { writeAuditLine, summariseInput } from '../src/sentinel/audit.mjs'

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
