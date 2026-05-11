// Review CLI tests — Sprint 09, Spec 04.
// Drives src/sentinel/review-cli.mjs as a subprocess via spawnSync.
// Fixture audit log at tests/fixtures/review-cli/audit.jsonl provides stable data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'src', 'sentinel', 'review-cli.mjs')
const FIXTURE_DIR = join(__dirname, 'fixtures', 'review-cli')
const AUDIT_JSONL = join(FIXTURE_DIR, 'audit.jsonl')

// Build a temporary home directory with a sentinel.json that sets audit.path
// to the fixture JSONL. Optionally merges extra config keys.
function makeTempHome(extraConfig = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'sentinel-review-cli-'))
  const clauDir = join(tmp, '.claude')
  mkdirSync(clauDir, { recursive: true })
  const cfg = {
    audit: { path: AUDIT_JSONL, maxSizeMb: 5 },
    registry: { minAgeDays: 7 },
    ...extraConfig,
  }
  writeFileSync(join(clauDir, 'sentinel.json'), JSON.stringify(cfg))
  return tmp
}

// Helper: run the CLI with injected env, return spawnSync result.
function runCli(args, envOverrides = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
  })
}

// ── summary ───────────────────────────────────────────────────────────────────

test('summary: exits 0 and prints 5 lines', () => {
  const home = makeTempHome()
  const result = runCli(['summary'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 5, `expected 5 lines, got: ${JSON.stringify(lines)}`)
})

test('summary: output lines are label-colon-value format', () => {
  const home = makeTempHome()
  const result = runCli(['summary'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n')
  for (const line of lines) {
    assert.match(line, /^\w+\s*:\s*\d+$/, `line does not match expected format: ${line}`)
  }
})

test('summary: total line is present and last', () => {
  const home = makeTempHome()
  const result = runCli(['summary'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n')
  assert.match(lines[lines.length - 1], /^total\s*:\s*\d+$/, 'last line must be total')
})

test('summary: counts are non-negative integers', () => {
  const home = makeTempHome()
  const result = runCli(['summary'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n')
  for (const line of lines) {
    const [, numStr] = line.split(':')
    const num = parseInt(numStr.trim(), 10)
    assert.ok(Number.isFinite(num) && num >= 0, `expected non-negative integer in: ${line}`)
  }
})

// ── recent ────────────────────────────────────────────────────────────────────

test('recent: exits 0 with default N=20 against 8-entry fixture', () => {
  const home = makeTempHome()
  const result = runCli(['recent'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  // Fixture has 8 entries; default N=20 returns all 8
  assert.equal(lines.length, 8, `expected 8 lines for 8-entry fixture with N=20`)
})

test('recent: respects explicit N argument', () => {
  const home = makeTempHome()
  const result = runCli(['recent', '3'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 3, `expected 3 lines for N=3`)
})

test('recent: each line has 5 pipe-separated fields', () => {
  const home = makeTempHome()
  const result = runCli(['recent', '5'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const fields = line.split(' | ')
    assert.equal(fields.length, 5, `expected 5 fields in line: ${line}`)
  }
})

test('recent: first field of each line is an ISO timestamp', () => {
  const home = makeTempHome()
  const result = runCli(['recent', '5'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const [ts] = line.split(' | ')
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(ts),
      `first field is not an ISO timestamp: ${ts}`
    )
  }
})

test('recent: returns entries newest first', () => {
  const home = makeTempHome()
  const result = runCli(['recent', '3'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const timestamps = lines.map((line) => line.split(' | ')[0])
  // The fixture entries are appended oldest-first; tail returns newest-first
  assert.equal(
    timestamps[0],
    '2026-05-09T17:45:00.000Z',
    `first line should be newest entry`
  )
  assert.equal(
    timestamps[1],
    '2026-05-08T09:30:00.000Z',
    `second line should be second-newest entry`
  )
})

// ── config ────────────────────────────────────────────────────────────────────

test('config: exits 0 and produces non-empty output', () => {
  const home = makeTempHome()
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.ok(result.stdout.trim().length > 0, 'config output must not be empty')
})

test('config: each line matches key.path = value [source] format', () => {
  const home = makeTempHome()
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    assert.match(
      line,
      /^[\w.]+\s*=\s*.+\s+\[(default|user|project)\]$/,
      `line does not match expected format: ${line}`
    )
  }
})

test('config: lines are sorted alphabetically by key path', () => {
  const home = makeTempHome()
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const keys = lines.map((line) => line.split(' = ')[0].trim())
  const sorted = [...keys].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(keys, sorted, 'config output must be sorted alphabetically by key path')
})

test('config: user-overridden leaf shows [user] source tag', () => {
  const home = makeTempHome()
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: FIXTURE_DIR,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  // makeTempHome sets audit.maxSizeMb=5 (user override of default 10)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const auditMaxLine = lines.find((l) => l.startsWith('audit.maxSizeMb'))
  assert.ok(auditMaxLine, 'audit.maxSizeMb line must be present')
  assert.match(auditMaxLine, /\[user\]$/, 'audit.maxSizeMb must be attributed to [user]')
  assert.match(auditMaxLine, /= 5 /, 'audit.maxSizeMb value must be 5 (user override)')
})

test('config: project-overridden leaf shows [project] source tag', () => {
  const home = makeTempHome()
  // SENTINEL_CWD points at FIXTURE_DIR which has cwd/.claude/sentinel.json with paths.deny override
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: join(FIXTURE_DIR, 'cwd'),
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const pathsDenyLine = lines.find((l) => l.startsWith('paths.deny'))
  assert.ok(pathsDenyLine, 'paths.deny line must be present')
  assert.match(pathsDenyLine, /\[project\]$/, 'paths.deny must be attributed to [project]')
})

test('config: default-only leaf shows [default] source tag', () => {
  // Use a temp home with no sentinel.json and a temp cwd with no sentinel.json
  const home = mkdtempSync(join(tmpdir(), 'sentinel-review-cli-nohome-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-review-cli-nocwd-'))
  const result = runCli(['config'], {
    SENTINEL_HOME: home,
    SENTINEL_CWD: cwd,
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  // registry.minAgeDays is 14 in defaults, not overridden
  const minAgeLine = lines.find((l) => l.startsWith('registry.minAgeDays'))
  assert.ok(minAgeLine, 'registry.minAgeDays line must be present')
  assert.match(minAgeLine, /\[default\]$/, 'registry.minAgeDays must be attributed to [default]')
})

// ── error paths ───────────────────────────────────────────────────────────────

test('unknown subcommand: exits 1 and writes to stderr', () => {
  const result = runCli(['bogus-subcommand'])
  assert.equal(result.status, 1, 'unknown subcommand must exit 1')
  assert.ok(result.stderr.includes('bogus-subcommand'), 'stderr must mention the unknown subcommand')
})

test('no subcommand: exits 1 and writes usage hint to stderr', () => {
  const result = runCli([])
  assert.equal(result.status, 1, 'no subcommand must exit 1')
  assert.ok(result.stderr.length > 0, 'stderr must not be empty for missing subcommand')
})
