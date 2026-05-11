import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadConfig, loadConfigWithSources } from '../src/sentinel/config.mjs'

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

test('defaults include populated paths.deny list', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    const config = loadConfig({ home, cwd })
    assert.ok(Array.isArray(config.paths.deny), 'paths.deny must be an array')
    assert.ok(config.paths.deny.length > 0, 'paths.deny must have at least one entry')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('defaults include populated registry and ecosystems sub-keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd  = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    const config = loadConfig({ home, cwd })

    // registry sub-keys
    assert.equal(typeof config.registry, 'object', 'registry must be an object')
    assert.equal(config.registry.cacheTtlHours,         1,    'cacheTtlHours default')
    assert.equal(config.registry.minAgeDays,            14,   'minAgeDays default')
    assert.equal(config.registry.minWeeklyDownloads,    100,  'minWeeklyDownloads default')
    assert.equal(config.registry.requireHomepage,       true, 'requireHomepage default')
    assert.equal(config.registry.timeoutMs,             250,  'timeoutMs default')
    assert.equal(config.registry.cacheMaxEntries,       1024, 'cacheMaxEntries default')

    // ecosystems sub-keys
    assert.equal(typeof config.ecosystems, 'object', 'ecosystems must be an object')
    assert.equal(config.ecosystems.npm,    true, 'npm enabled by default')
    assert.equal(config.ecosystems.pypi,   true, 'pypi enabled by default')
    assert.equal(config.ecosystems.crates, true, 'crates enabled by default')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd,  { recursive: true, force: true })
  }
})

test('defaults include populated scrubber sub-keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd  = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    const config = loadConfig({ home, cwd })

    assert.equal(typeof config.scrubber, 'object', 'scrubber must be an object')
    assert.equal(config.scrubber.enabled, true, 'scrubber.enabled default is true')
    assert.ok(Array.isArray(config.scrubber.extraPatterns), 'scrubber.extraPatterns must be an array')
    assert.equal(config.scrubber.extraPatterns.length, 0, 'scrubber.extraPatterns default is empty')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd,  { recursive: true, force: true })
  }
})

test('scrubber overrides merge correctly through all three layers', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd  = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    // user sets enabled=false; project does not override scrubber at all
    writeSentinel(home, { scrubber: { enabled: false } })
    const config1 = loadConfig({ home, cwd })
    assert.equal(config1.scrubber.enabled, false, 'user override disables scrubber')
    // extraPatterns must still be the default empty array (user did not set it)
    assert.ok(Array.isArray(config1.scrubber.extraPatterns), 'extraPatterns survives user partial override')
    assert.equal(config1.scrubber.extraPatterns.length, 0, 'extraPatterns is still empty after user partial override')

    // project sets enabled=false; user sets enabled=true — project must win
    writeSentinel(home, { scrubber: { enabled: true } })
    writeSentinel(cwd,  { scrubber: { enabled: false } })
    const config2 = loadConfig({ home, cwd })
    assert.equal(config2.scrubber.enabled, false, 'project override wins over user override')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd,  { recursive: true, force: true })
  }
})

// ── loadConfigWithSources tests ───────────────────────────────────────────────

test('loadConfigWithSources: defaults-only — every source label is "default"', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    const { value, sources } = loadConfigWithSources({ home, cwd })
    // value must deep-equal loadConfig output
    assert.deepEqual(value, loadConfig({ home, cwd }))
    // every leaf in sources must be 'default'
    assert.equal(sources.audit.path, 'default')
    assert.equal(sources.audit.maxSizeMb, 'default')
    assert.equal(sources.scrubber.enabled, 'default')
    assert.equal(sources.scrubber.extraPatterns, 'default')
    assert.equal(sources.paths.deny, 'default')
    assert.equal(sources.paths.allow, 'default')
    assert.equal(sources.registry.cacheTtlHours, 'default')
    assert.equal(sources.registry.minAgeDays, 'default')
    assert.equal(sources.ecosystems.npm, 'default')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadConfigWithSources: user override of one scalar — that leaf is "user", rest "default"', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { audit: { maxSizeMb: 5 } })
    const { value, sources } = loadConfigWithSources({ home, cwd })
    // value must deep-equal loadConfig output
    assert.deepEqual(value, loadConfig({ home, cwd }))
    assert.equal(value.audit.maxSizeMb, 5)
    // the overridden leaf must be labeled 'user'
    assert.equal(sources.audit.maxSizeMb, 'user')
    // the sibling leaf (audit.path) was not overridden — must remain 'default'
    assert.equal(sources.audit.path, 'default')
    // unrelated leaves must remain 'default'
    assert.equal(sources.scrubber.enabled, 'default')
    assert.equal(sources.registry.cacheTtlHours, 'default')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadConfigWithSources: all three layers — project overrides user overrides default', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { audit: { maxSizeMb: 5 }, registry: { minAgeDays: 7 } })
    writeSentinel(cwd, { audit: { maxSizeMb: 99 } })
    const { value, sources } = loadConfigWithSources({ home, cwd })
    // value must deep-equal loadConfig output
    assert.deepEqual(value, loadConfig({ home, cwd }))
    assert.equal(value.audit.maxSizeMb, 99)
    // project wins for audit.maxSizeMb
    assert.equal(sources.audit.maxSizeMb, 'project')
    // user wins for registry.minAgeDays (project did not override it)
    assert.equal(sources.registry.minAgeDays, 'user')
    // default wins for everything else
    assert.equal(sources.audit.path, 'default')
    assert.equal(sources.scrubber.enabled, 'default')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadConfigWithSources: nested object merge — independent leaves keep their own source labels', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    // user sets scrubber.enabled; project sets scrubber.extraPatterns — both within "scrubber"
    writeSentinel(home, { scrubber: { enabled: false } })
    writeSentinel(cwd, { scrubber: { extraPatterns: ['MY_SECRET'] } })
    const { value, sources } = loadConfigWithSources({ home, cwd })
    // value must deep-equal loadConfig output
    assert.deepEqual(value, loadConfig({ home, cwd }))
    assert.equal(value.scrubber.enabled, false)
    assert.deepEqual(value.scrubber.extraPatterns, ['MY_SECRET'])
    // each leaf inside the same sub-object has its own attribution
    assert.equal(sources.scrubber.enabled, 'user',
      'scrubber.enabled was set by user layer')
    assert.equal(sources.scrubber.extraPatterns, 'project',
      'scrubber.extraPatterns was set by project layer')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadConfigWithSources: array override — project array fully shadows user array, label is "project"', () => {
  const home = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const cwd = mkdtempSync(join(tmpdir(), 'sentinel-'))
  try {
    writeSentinel(home, { paths: { deny: ['**/.env', '**/user-secret'] } })
    writeSentinel(cwd, { paths: { deny: ['**/project-secret'] } })
    const { value, sources } = loadConfigWithSources({ home, cwd })
    // value must deep-equal loadConfig output
    assert.deepEqual(value, loadConfig({ home, cwd }))
    // project array fully replaces the user array (last-write-wins, no per-element merge)
    assert.deepEqual(value.paths.deny, ['**/project-secret'])
    // the source label for the array leaf is 'project' — not a per-element array
    assert.equal(sources.paths.deny, 'project',
      'array is an opaque leaf: project label wins, no per-element attribution')
    // paths.allow was not overridden by either layer — must be 'default'
    assert.equal(sources.paths.allow, 'default')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
