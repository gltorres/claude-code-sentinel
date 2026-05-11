import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, '..', 'src', 'sentinel', 'hook.mjs')

function runHook(args, input = '{}') {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  })
}

function runHookEnv(args, input = '{}', env = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env },
  })
}

test('--self-test exits 0', () => {
  const r = runHook(['--self-test'], '')
  assert.equal(r.status, 0)
})

for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
  test(`${ev} returns valid envelope and exits 0`, () => {
    const r = runHook([ev], '{}')
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, ev)
  })
}

test('PreToolUse envelope carries permissionDecision allow', () => {
  const r = runHook(['PreToolUse'], '{}')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})

test('unknown event falls through to allow', () => {
  const r = runHook(['Foo'], '{}')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})

test('invalid JSON on stdin is fail-open', () => {
  const r = runHook(['PreToolUse'], 'not-json-{{')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})

test('PreToolUse writes one audit line to CLAUDE_PLUGIN_DATA', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const input = JSON.stringify({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  const r = runHookEnv(['PreToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
  assert.equal(r.status, 0)
  const auditPath = join(dataDir, 'audit.jsonl')
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
})

test('audit line has all twelve PRD schema fields and a valid ULID id', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-audit-'))
  const input = JSON.stringify({
    session_id: 'sess-2',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  })
  const r = runHookEnv(['PreToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
  assert.equal(r.status, 0)
  const auditPath = join(dataDir, 'audit.jsonl')
  const line = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)[0]
  const record = JSON.parse(line)
  const EXPECTED_FIELDS = [
    'id', 'ts', 'session_id', 'cwd', 'event', 'hook',
    'tool', 'rule', 'matched', 'input_summary', 'decision', 'metadata',
  ]
  for (const field of EXPECTED_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(record, field), `missing field: ${field}`)
  }
  assert.equal(record.id.length, 26)
  assert.ok(record.id.length > 0)
})
