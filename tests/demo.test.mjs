// Demo driver tests — Sprint 10, Spec 02.
// Invokes tools/demo.mjs as a subprocess and asserts exit code, stdout markers,
// and that demo/audit.jsonl contains exactly 3 lines after the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRIVER    = join(__dirname, '..', 'tools', 'demo.mjs')
const repoRoot  = join(__dirname, '..')
const auditPath = join(repoRoot, 'demo', 'audit.jsonl')

function runDriver(extraArgs = []) {
  return spawnSync(process.execPath, [DRIVER, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env },
  })
}

test('demo driver: exits 0 on a clean run', () => {
  const r = runDriver()
  assert.equal(r.status, 0, `driver exited non-zero.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
})

test('demo driver: stdout contains Step 1 PASS marker', () => {
  const r = runDriver()
  assert.ok(
    r.stdout.includes('Step 1') && r.stdout.includes('PASS'),
    `expected Step 1 PASS in stdout:\n${r.stdout}`
  )
})

test('demo driver: stdout contains Step 2 PASS marker', () => {
  const r = runDriver()
  assert.ok(
    r.stdout.includes('Step 2') && r.stdout.includes('PASS'),
    `expected Step 2 PASS in stdout:\n${r.stdout}`
  )
})

test('demo driver: stdout contains Step 3 PASS marker', () => {
  const r = runDriver()
  assert.ok(
    r.stdout.includes('Step 3') && r.stdout.includes('PASS'),
    `expected Step 3 PASS in stdout:\n${r.stdout}`
  )
})

test('demo driver: stdout contains step 3 honest-limitation footer', () => {
  const r = runDriver()
  assert.ok(
    r.stdout.includes('next-turn backstop'),
    `expected honest-limitation footer in stdout:\n${r.stdout}`
  )
})

test('demo driver: stdout contains Step 4 PASS marker', () => {
  const r = runDriver()
  assert.ok(
    r.stdout.includes('Step 4') && r.stdout.includes('PASS'),
    `expected Step 4 PASS in stdout:\n${r.stdout}`
  )
})

test('demo driver: demo/audit.jsonl has exactly 3 lines after run', () => {
  runDriver() // ensure a fresh run
  assert.ok(existsSync(auditPath), `audit log not found at ${auditPath}`)
  const content = readFileSync(auditPath, 'utf8')
  const lines = content.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 3, `expected 3 audit lines, got ${lines.length}:\n${content}`)
})

test('demo driver: each audit line is valid JSON with rule field', () => {
  runDriver()
  const content = readFileSync(auditPath, 'utf8')
  const lines = content.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    let entry
    assert.doesNotThrow(() => { entry = JSON.parse(line) }, `audit line is not valid JSON: ${line}`)
    assert.ok(entry.rule, `audit line missing rule field: ${line}`)
  }
})

test('demo driver: --write-transcript flag accepted without error', () => {
  const transcriptPath = join(repoRoot, 'demo', 'test-transcript.md')
  const r = runDriver([`--write-transcript=${transcriptPath}`])
  assert.equal(r.status, 0, `driver exited non-zero with --write-transcript:\n${r.stderr}`)
})
