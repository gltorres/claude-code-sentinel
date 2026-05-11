import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

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

// ─── Path-deny integration tests (Spec 04) ───────────────────────────────────

// Helper: build a PreToolUse event JSON string for a given tool + path field.
function makeReadEvent(toolName, filePath, cwd = '/tmp/project') {
  const tool_input =
    toolName === 'Glob'
      ? { pattern: filePath }
      : toolName === 'NotebookEdit'
      ? { notebook_path: filePath }
      : { file_path: filePath }
  return JSON.stringify({
    session_id: 'test-sess',
    cwd,
    tool_name: toolName,
    tool_input,
  })
}

// Helper: read the single audit record from a tmp CLAUDE_PLUGIN_DATA dir.
function readAuditRecord(dataDir) {
  const auditPath = join(dataDir, 'audit.jsonl')
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

// Test 1: Read .env -> deny
test('PreToolUse Read .env is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Read', '/tmp/project/.env'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(
      out.hookSpecificOutput.permissionDecisionReason.includes('paths.deny'),
      'reason should name paths.deny',
    )
    // Audit line must carry block/deny fields
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
    assert.equal(rec.rule, 'paths.deny')
    assert.ok(rec.matched, 'matched should be non-empty')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 2: Read .env.example -> allow
test('PreToolUse Read .env.example is allowed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Read', '/tmp/project/.env.example'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 3: Edit .env -> deny
test('PreToolUse Edit .env is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Edit', '/tmp/project/.env'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 4: Grep against a deny-listed path -> deny
test('PreToolUse Grep on credentials.json is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Grep', '/tmp/project/credentials.json'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
    assert.equal(rec.rule, 'paths.deny')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 5: Glob pattern matching a deny-listed path -> deny
test('PreToolUse Glob pattern for .env is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Glob', '/tmp/project/.env'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 6: NotebookEdit on a deny-listed path -> deny
test('PreToolUse NotebookEdit on .zshrc is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('NotebookEdit', `${homedir()}/.zshrc`),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 7: ~/.ssh/id_ed25519 -> deny
test('PreToolUse Read ~/.ssh/id_ed25519 is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Read', `${homedir()}/.ssh/id_ed25519`),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
    assert.equal(rec.rule, 'paths.deny')
    assert.ok(rec.matched, 'matched glob should be present')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 8: ~/.ssh/id_ed25519.pub -> allow (pub key allowlist overrides deny)
test('PreToolUse Read ~/.ssh/id_ed25519.pub is allowed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-pd-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeReadEvent('Read', `${homedir()}/.ssh/id_ed25519.pub`),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
