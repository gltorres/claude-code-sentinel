import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadConfig } from '../src/sentinel/config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Write a sentinel.json into <base>/.claude/sentinel.json
function writeSentinel(base, obj) {
  const dir = join(base, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sentinel.json'), JSON.stringify(obj))
}

test('defaults-only load returns all six keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    const config = loadConfig({ home, cwd })
    const keys = Object.keys(config).sort()
    assert.deepEqual(keys, ['audit', 'bash', 'ecosystems', 'paths', 'registry', 'scrubber'])
    assert.equal(config.audit.path, null)
    assert.equal(config.audit.maxSizeMb, 10)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('project value overrides user value at a nested key', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { audit: { maxSizeMb: 5 } })
    writeSentinel(cwd, { audit: { maxSizeMb: 99 } })
    const config = loadConfig({ home, cwd })
    // project value must win over user value
    assert.equal(config.audit.maxSizeMb, 99)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('user value applies where project omits', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { audit: { maxSizeMb: 7 } })
    // project config omits audit entirely
    writeSentinel(cwd, { paths: {} })
    const config = loadConfig({ home, cwd })
    // user value must survive because project did not override it
    assert.equal(config.audit.maxSizeMb, 7)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('defaults apply where both user and project omit', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    // neither layer sets audit.maxSizeMb
    writeSentinel(home, { paths: {} })
    writeSentinel(cwd, { paths: {} })
    const config = loadConfig({ home, cwd })
    // shipped default must be present
    assert.equal(config.audit.maxSizeMb, 10)
    assert.equal(config.audit.path, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('unknown key in user config round-trips unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { _futureFeature: { enabled: true, threshold: 42 } })
    const config = loadConfig({ home, cwd })
    // unknown top-level key must survive the merge unchanged
    assert.deepEqual(config._futureFeature, { enabled: true, threshold: 42 })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('malformed user JSON does not throw and falls back to defaults', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    // write syntactically invalid JSON to the user config
    const dir = join(home, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sentinel.json'), 'not-json-{{')
    const config = loadConfig({ home, cwd })
    // must not throw; shipped defaults must still be present
    assert.equal(config.audit.maxSizeMb, 10)
    assert.ok('paths' in config)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('missing user and project files are silent no-ops', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    // no sentinel.json files written; .claude dirs do not even exist
    const config = loadConfig({ home, cwd })
    // must return defaults without throwing
    const keys = Object.keys(config).sort()
    assert.deepEqual(keys, ['audit', 'bash', 'ecosystems', 'paths', 'registry', 'scrubber'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
