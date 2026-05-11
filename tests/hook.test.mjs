import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, '..', 'src', 'sentinel', 'hook.mjs')

function runHook(args, input = '{}') {
  // Isolate every hook invocation to a temp CLAUDE_PLUGIN_DATA dir so
  // tests never write to the fallback ~/.claude/sentinel/audit.jsonl path.
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-runhook-'))
  try {
    return spawnSync(process.execPath, [HOOK, ...args], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
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

test('--self-test: per-fixture in-process latency < 20 ms', () => {
  const r = runHook(['--self-test'], '')
  assert.equal(r.status, 0, `--self-test exited ${r.status}; stderr: ${r.stderr}`)
  // Parse "Sentinel: self-test ok (N fixtures, X.Y ms total)" from stderr
  const match = r.stderr.match(/self-test ok \((\d+) fixtures, ([\d.]+) ms total\)/)
  assert.ok(match, `unexpected stderr format: ${r.stderr}`)
  const fixtureCount = Number(match[1])
  const totalMs = Number(match[2])
  assert.ok(fixtureCount > 0, 'expected at least one fixture')
  assert.ok(fixtureCount >= 43, `expected >= 43 fixtures (paths + bash + registry + scrubber + session), got ${fixtureCount}`)
  const perFixtureMs = totalMs / fixtureCount
  assert.ok(
    perFixtureMs < 20,
    `per-fixture latency ${perFixtureMs.toFixed(2)} ms >= 20 ms (total ${totalMs} ms / ${fixtureCount} fixtures)`
  )
})

test('--self-test: scrubber bucket present and exits 0', () => {
  const r = runHook(['--self-test'], '')
  assert.equal(r.status, 0, `--self-test exited ${r.status}; stderr: ${r.stderr}`)
  const match = r.stderr.match(/self-test ok \((\d+) fixtures, ([\d.]+) ms total\)/)
  assert.ok(match, `unexpected stderr format: ${r.stderr}`)
  const fixtureCount = Number(match[1])
  assert.ok(
    fixtureCount >= 43,
    `expected >= 43 fixtures (paths + bash + registry + scrubber + session), got ${fixtureCount}`
  )
})

// ─── Bash-exfil integration tests (Sprint 04, Spec 4) ─────────────────────────

// Helper: build a PreToolUse Bash event JSON string.
function makeBashEvent(command, cwd = '/tmp/project') {
  return JSON.stringify({
    session_id: 'bash-test-sess',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  })
}

// Test 9: Bash deny — cat reads a secret path
test('PreToolUse Bash cat .env is denied', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-bash-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeBashEvent('cat .env'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(
      out.hookSpecificOutput.permissionDecisionReason.startsWith('Sentinel: '),
      'reason must start with BANNER_PREFIX',
    )
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'block')
    assert.equal(rec.decision, 'deny')
    assert.ok(rec.rule, 'rule should be non-empty')
    assert.ok(
      rec.input_summary.matched_segment,
      'input_summary.matched_segment must be non-null on a Bash deny',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 10: Bash allow — wc is a value-stripping command
test('PreToolUse Bash wc -l .env is allowed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-bash-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeBashEvent('wc -l .env'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test 11: Bash ask — heredoc is an exotic shape
test('PreToolUse Bash heredoc produces ask decision', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-bash-'))
  try {
    const r = runHookEnv(
      ['PreToolUse'],
      makeBashEvent('cat <<EOF\nfoo\nEOF'),
      { CLAUDE_PLUGIN_DATA: dataDir },
    )
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
    assert.ok(
      out.hookSpecificOutput.permissionDecisionReason.startsWith('Sentinel: '),
      'reason must start with BANNER_PREFIX',
    )
    const rec = readAuditRecord(dataDir)
    assert.equal(rec.event, 'ask')
    assert.equal(rec.decision, 'ask')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ─── PostToolUse scrubber integration tests (Sprint 06, Spec 5) ────────────────

// Test S1: Bash response containing an Anthropic API key is redacted.
// Asserts: stdout envelope contains <REDACTED:anthropic>, audit JSONL has one
//          event:'scrub' line with rule:'scrubber.anthropic', and the raw secret
//          never appears in any audit line.
test('PostToolUse Bash response with Anthropic API key is scrubbed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-scrub-'))
  try {
    const fakeKey = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const input = JSON.stringify({
      session_id: 'scrub-test-s1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_response: `Command output: ${fakeKey}`,
    })
    const r = runHookEnv(['PostToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    // Envelope: stdout must parse as valid JSON with the correct event name
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')

    // The redacted text must contain the family tag, not the raw secret
    const ctx = out.hookSpecificOutput.additionalContext
    assert.ok(
      ctx.includes('<REDACTED:anthropic>'),
      `additionalContext must contain <REDACTED:anthropic>, got: ${ctx}`,
    )
    assert.ok(
      !ctx.includes('sk-ant-'),
      `additionalContext must NOT contain the raw secret, got: ${ctx}`,
    )

    // Audit JSONL: exactly one scrub line for the anthropic family
    const auditPath = join(dataDir, 'audit.jsonl')
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
    const scrubLines = lines.map(l => JSON.parse(l)).filter(rec => rec.event === 'scrub')
    assert.equal(scrubLines.length, 1, `expected 1 scrub audit line, got ${scrubLines.length}`)
    const scrubRec = scrubLines[0]
    assert.equal(scrubRec.rule, 'scrubber.anthropic')
    assert.equal(scrubRec.decision, 'allow')
    assert.equal(scrubRec.hook, 'PostToolUse')
    assert.equal(scrubRec.input_summary.family, 'anthropic')
    assert.ok(scrubRec.input_summary.count >= 1, 'count must be >= 1')

    // Safety: the raw secret must never appear in any audit line
    const rawAudit = readFileSync(auditPath, 'utf8')
    assert.ok(
      !rawAudit.includes('sk-ant-'),
      'audit JSONL must not contain the raw secret text',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test S2: Read response with no secret passes through verbatim with zero scrub audit lines.
// Asserts: stdout envelope contains the original text verbatim in additionalContext,
//          no audit lines carry event:'scrub'.
test('PostToolUse Read response with no secret passes through verbatim', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-scrub-'))
  try {
    const cleanText = 'the build passed in 4.2 seconds with 47 tests'
    const input = JSON.stringify({
      session_id: 'scrub-test-s2',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_response: cleanText,
    })
    const r = runHookEnv(['PostToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      cleanText,
      'additionalContext must equal the original clean text verbatim',
    )

    // Audit JSONL: zero scrub lines (the file may not exist or may have zero lines)
    const auditPath = join(dataDir, 'audit.jsonl')
    let scrubLineCount = 0
    try {
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
      scrubLineCount = lines.map(l => JSON.parse(l)).filter(rec => rec.event === 'scrub').length
    } catch {
      scrubLineCount = 0 // file does not exist — no audit lines written at all
    }
    assert.equal(scrubLineCount, 0, `expected 0 scrub audit lines, got ${scrubLineCount}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test S3: scrubber.enabled = false via project config overlay produces empty
//          additionalContext and zero audit lines.
// This test writes a project-level sentinel.json into a temp cwd that disables the scrubber,
// then passes that cwd in the event so loadConfig picks it up.
test('PostToolUse scrubber disabled via config produces empty additionalContext', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-scrub-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'sentinel-proj-'))
  try {
    // Write a project-level sentinel.json that disables the scrubber
    const claudeDir = join(projectDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'sentinel.json'),
      JSON.stringify({ scrubber: { enabled: false } }),
    )

    // Build a PostToolUse event with a secret in tool_response but pointing at the
    // project dir so loadConfig sees scrubber.enabled = false
    const fakeKey = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    const input = JSON.stringify({
      session_id: 'scrub-test-s3',
      cwd: projectDir,
      tool_name: 'Bash',
      tool_response: `output: ${fakeKey}`,
    })
    const r = runHookEnv(['PostToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      '',
      'additionalContext must be empty when scrubber is disabled',
    )

    // Audit JSONL: zero scrub lines
    const auditPath = join(dataDir, 'audit.jsonl')
    let scrubLineCount = 0
    try {
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
      scrubLineCount = lines.map(l => JSON.parse(l)).filter(rec => rec.event === 'scrub').length
    } catch {
      scrubLineCount = 0
    }
    assert.equal(scrubLineCount, 0, `expected 0 scrub audit lines when scrubber is disabled, got ${scrubLineCount}`)

    // Safety: even though scrubbing was disabled, the raw secret must not appear in audit
    let rawAudit = ''
    try { rawAudit = readFileSync(auditPath, 'utf8') } catch {}
    assert.ok(
      !rawAudit.includes('sk-ant-'),
      'audit JSONL must not contain raw secret text even in the disabled path',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})

// ─── SessionEnd integration test (Sprint 07, Spec 2) ─────────────────────────

test('SessionEnd writes audit line with rule session.end and matching session_id', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sentinel-session-end-'))
  const cwd = '/tmp'
  try {
    const result = spawnSync(process.execPath, [HOOK, 'SessionEnd'], {
      input: JSON.stringify({ session_id: 'sess-xyz', cwd }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpDir },
      encoding: 'utf8',
    })

    // Hook must exit cleanly and emit a valid envelope
    assert.equal(result.status, 0, `hook exited ${result.status}; stderr: ${result.stderr}`)
    const out = JSON.parse(result.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionEnd')

    // Audit JSONL must have exactly one line
    const auditPath = join(tmpDir, 'audit.jsonl')
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1, `expected 1 audit line, got ${lines.length}`)

    // Parse and assert all required fields
    const rec = JSON.parse(lines[0])
    assert.equal(rec.hook, 'SessionEnd', 'hook field must be SessionEnd')
    assert.equal(rec.event, 'warn', 'event field must be warn')
    assert.equal(rec.rule, 'session.end', 'rule field must be session.end')
    assert.equal(rec.decision, 'allow', 'decision field must be allow')
    assert.equal(rec.matched, null, 'matched field must be null')
    assert.equal(rec.session_id, 'sess-xyz', 'session_id must match the payload')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ─── SessionStart integration tests (Sprint 07, Spec 3) ───────────────────────

test('SessionStart with empty audit log returns no-events-yet banner', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-ss-'))
  try {
    const input = JSON.stringify({ session_id: 'ss-test-1', cwd: '/tmp' })
    const r = runHookEnv(['SessionStart'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')

    const ctx = out.hookSpecificOutput.additionalContext
    assert.ok(
      /Sentinel active — no events yet/.test(ctx),
      `expected "no events yet" banner, got: ${ctx}`,
    )
    assert.ok(
      ctx.includes('next-turn-only'),
      `banner must include next-turn-only caveat, got: ${ctx}`,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('SessionStart with 2 blocks + 1 scrub in last 7d shows correct counts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-ss-'))
  try {
    // Seed audit.jsonl with 2 block lines and 1 scrub line all within the last 7 days
    const now = Date.now()
    const ts1 = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString() // 1 day ago
    const ts2 = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days ago
    const ts3 = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() // 5 days ago

    const makeRecord = (ts, eventType) => JSON.stringify({
      id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
      ts,
      session_id: 'seed-sess',
      cwd: '/tmp',
      event: eventType,
      hook: 'PreToolUse',
      tool: 'Bash',
      rule: 'test.rule',
      matched: null,
      input_summary: {},
      decision: 'deny',
      metadata: {},
    })

    const auditLines = [
      makeRecord(ts1, 'block'),
      makeRecord(ts2, 'block'),
      makeRecord(ts3, 'scrub'),
    ].join('\n') + '\n'

    writeFileSync(join(dataDir, 'audit.jsonl'), auditLines, 'utf8')

    const input = JSON.stringify({ session_id: 'ss-test-2', cwd: '/tmp' })
    const r = runHookEnv(['SessionStart'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')

    const ctx = out.hookSpecificOutput.additionalContext
    assert.ok(
      ctx.includes('2 block'),
      `banner must include "2 block", got: ${ctx}`,
    )
    assert.ok(
      ctx.includes('1 scrub'),
      `banner must include "1 scrub", got: ${ctx}`,
    )
    assert.ok(
      ctx.includes('next-turn-only'),
      `banner must include next-turn-only caveat, got: ${ctx}`,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('SessionStart with one entry older than 7d does not count that entry', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-ss-'))
  try {
    // Seed audit.jsonl with one block line that is 8 days old (outside the 7d window)
    const now = Date.now()
    const ts = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago

    const oldRecord = JSON.stringify({
      id: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
      ts,
      session_id: 'seed-sess-old',
      cwd: '/tmp',
      event: 'block',
      hook: 'PreToolUse',
      tool: 'Bash',
      rule: 'test.rule',
      matched: null,
      input_summary: {},
      decision: 'deny',
      metadata: {},
    }) + '\n'

    writeFileSync(join(dataDir, 'audit.jsonl'), oldRecord, 'utf8')

    const input = JSON.stringify({ session_id: 'ss-test-3', cwd: '/tmp' })
    const r = runHookEnv(['SessionStart'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)

    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')

    const ctx = out.hookSpecificOutput.additionalContext
    // The 8-day-old entry must NOT be counted — banner should show "no events yet"
    assert.ok(
      /Sentinel active — no events yet/.test(ctx),
      `expected "no events yet" banner when all entries are >7d old, got: ${ctx}`,
    )
    assert.ok(
      ctx.includes('next-turn-only'),
      `banner must include next-turn-only caveat, got: ${ctx}`,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ─── Dry-run tests (Sprint 09, Spec 03) ──────────────────────────────────────

function statOrNull(filePath) {
  try { return statSync(filePath) } catch { return null }
}

// Test DR1: Bash deny case — cat .env → decision=deny, audit log unchanged.
test('--dry-run PreToolUse Bash cat .env prints decision=deny and does not write audit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-dryrun-'))
  const auditPath = join(dataDir, 'audit.jsonl')
  try {
    const before = statOrNull(auditPath)
    const input = JSON.stringify({
      session_id: 'dr-test-1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: { command: 'cat .env' },
    })
    const r = spawnSync(process.execPath, [HOOK, 'PreToolUse', '--dry-run'], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    })
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`)
    assert.ok(
      r.stdout.startsWith('decision=deny'),
      `expected stdout to start with "decision=deny", got: ${r.stdout.trim()}`,
    )
    assert.ok(
      r.stdout.includes('rule='),
      `stdout must include rule= field, got: ${r.stdout.trim()}`,
    )
    const after = statOrNull(auditPath)
    assert.equal(
      after?.size ?? 0,
      before?.size ?? 0,
      'audit file size must not change after --dry-run',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test DR2: Bash allow case — wc -l README.md → decision=allow, audit log unchanged.
test('--dry-run PreToolUse Bash wc -l README.md prints decision=allow and does not write audit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-dryrun-'))
  const auditPath = join(dataDir, 'audit.jsonl')
  try {
    const before = statOrNull(auditPath)
    const input = JSON.stringify({
      session_id: 'dr-test-2',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: { command: 'wc -l README.md' },
    })
    const r = spawnSync(process.execPath, [HOOK, 'PreToolUse', '--dry-run'], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    })
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`)
    assert.ok(
      r.stdout.startsWith('decision=allow'),
      `expected stdout to start with "decision=allow", got: ${r.stdout.trim()}`,
    )
    const after = statOrNull(auditPath)
    assert.equal(
      after?.size ?? 0,
      before?.size ?? 0,
      'audit file size must not change after --dry-run',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test DR3: Read deny case — Read of ~/.aws/credentials → decision=deny, audit unchanged.
test('--dry-run PreToolUse Read ~/.aws/credentials prints decision=deny and does not write audit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-dryrun-'))
  const auditPath = join(dataDir, 'audit.jsonl')
  try {
    const before = statOrNull(auditPath)
    const input = JSON.stringify({
      session_id: 'dr-test-3',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_input: { file_path: `${homedir()}/.aws/credentials` },
    })
    const r = spawnSync(process.execPath, [HOOK, 'PreToolUse', '--dry-run'], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    })
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`)
    assert.ok(
      r.stdout.startsWith('decision=deny'),
      `expected stdout to start with "decision=deny", got: ${r.stdout.trim()}`,
    )
    const after = statOrNull(auditPath)
    assert.equal(
      after?.size ?? 0,
      before?.size ?? 0,
      'audit file size must not change after --dry-run',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test DR4: Read allow case — Read of a regular project file → decision=allow, audit unchanged.
test('--dry-run PreToolUse Read /tmp/project/README.md prints decision=allow and does not write audit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-dryrun-'))
  const auditPath = join(dataDir, 'audit.jsonl')
  try {
    const before = statOrNull(auditPath)
    const input = JSON.stringify({
      session_id: 'dr-test-4',
      cwd: '/tmp/project',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/project/README.md' },
    })
    const r = spawnSync(process.execPath, [HOOK, 'PreToolUse', '--dry-run'], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    })
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`)
    assert.ok(
      r.stdout.startsWith('decision=allow'),
      `expected stdout to start with "decision=allow", got: ${r.stdout.trim()}`,
    )
    const after = statOrNull(auditPath)
    assert.equal(
      after?.size ?? 0,
      before?.size ?? 0,
      'audit file size must not change after --dry-run',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// Test DR5: Non-PreToolUse event with --dry-run → exit 1 with documented stderr.
test('--dry-run with PostToolUse event exits 1 with documented stderr message', () => {
  const r = spawnSync(process.execPath, [HOOK, 'PostToolUse', '--dry-run'], {
    input: '{}',
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env },
  })
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`)
  assert.ok(
    r.stderr.includes('dry-run only supports PreToolUse today'),
    `expected documented error in stderr, got: ${r.stderr.trim()}`,
  )
})

// ─── Bug 2 regression: PostToolUse must serialise object tool_response ────────
// Before the fix, String({stdout:'...'}) yielded "[object Object]", silently
// disabling the scrubber for the most common Bash/Read responses.
test('PostToolUse coerces object tool_response to scrub-able JSON (not "[object Object]")', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sentinel-postobj-'))
  try {
    const fakeKey = 'sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    const input = JSON.stringify({
      session_id: 'postobj-1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { stdout: fakeKey, stderr: '', interrupted: false },
    })
    const r = runHookEnv(['PostToolUse'], input, { CLAUDE_PLUGIN_DATA: dataDir })
    assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)
    const out = JSON.parse(r.stdout.trim())
    const ctx = out.hookSpecificOutput.additionalContext
    assert.equal(typeof ctx, 'string', 'additionalContext must be a string')
    assert.notStrictEqual(
      ctx,
      '[object Object]',
      'PostToolUse must not emit literal "[object Object]"',
    )
    assert.ok(
      !ctx.includes(fakeKey),
      `raw secret must be redacted from scrubbed output, got: ${ctx}`,
    )
    assert.ok(
      ctx.includes('<REDACTED:anthropic>'),
      `scrubber must redact the embedded sk-ant- token, got: ${ctx}`,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ─── Bug 1 regression: tests must never pollute the fallback audit path ──────
// The fallback path is ~/.claude/sentinel/audit.jsonl. Any test that spawns the
// hook subprocess without setting CLAUDE_PLUGIN_DATA or config.audit.path will
// leak audit lines there. This guard runs a representative hook invocation
// (one that previously polluted) through `runHook` and asserts the fallback
// file's byte count is unchanged.
test('test suite never writes to the fallback ~/.claude/sentinel/audit.jsonl', () => {
  const fallback = join(homedir(), '.claude', 'sentinel', 'audit.jsonl')
  let before
  try { before = statSync(fallback).size } catch { before = null }
  // Representative invocation via the bare `runHook` helper, which previously
  // omitted CLAUDE_PLUGIN_DATA and reached the audit-writing else-branch.
  const r = runHook(['SessionEnd'], JSON.stringify({ session_id: 'pollution-guard', cwd: '/tmp' }))
  assert.equal(r.status, 0)
  let after
  try { after = statSync(fallback).size } catch { after = null }
  if (before == null && after == null) return // fallback never existed; nothing leaked
  assert.equal(
    after ?? 0,
    before ?? 0,
    `test wrote ${(after ?? 0) - (before ?? 0)} bytes to fallback audit path ${fallback}`,
  )
})
