import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubResponse } from '../src/sentinel/scrubber-policy.mjs'

// Anthropic API key fixture (33 alphanum chars after prefix — triggers anthropic family).
const ANT_KEY = 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

// 32-char base64-alphabet string with high Shannon entropy (triggers high_entropy).
// Entropy of a uniform distribution over [A-Za-z0-9+/] runs well above 4.5 bits/char.
const HIGH_ENT = 'aB3dE6fG9hI2jK5lM8nO1pQ4rS7tU0vW'

// Config with scrubber enabled (default).
const CFG_ON = { scrubber: { enabled: true, extraPatterns: [] } }

// Config with scrubber disabled.
const CFG_OFF = { scrubber: { enabled: false, extraPatterns: [] } }

test('disabled — scrubber.enabled:false returns empty redacted and zero redactions', () => {
  const r = scrubResponse({ text: `Secret: ${ANT_KEY}`, config: CFG_OFF })
  assert.equal(r.redacted, '', 'redacted must be empty string when disabled')
  assert.equal(r.redactions.length, 0, 'redactions must be empty when disabled')
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
  assert.equal(r.matched, null)
})

test('composition — anthropic key AND high-entropy run produces two redaction entries', () => {
  // Use a leading non-keyword identifier so the entropy run reaches the
  // entropy detector instead of being caught by the assignment context detector.
  const input = `key=${ANT_KEY} value ${HIGH_ENT}`
  const r = scrubResponse({ text: input, config: CFG_ON })

  // Anthropic family must have fired.
  const antEntry = r.redactions.find(e => e.family === 'anthropic')
  assert.ok(antEntry, 'anthropic redaction entry must be present')
  assert.equal(antEntry.count, 1)

  // High-entropy fallback must have fired for the remaining entropy run.
  const entEntry = r.redactions.find(e => e.family === 'high_entropy')
  assert.ok(entEntry, 'high_entropy redaction entry must be present')
  assert.ok(entEntry.count >= 1)

  // The redacted text must not contain the original key.
  assert.ok(!r.redacted.includes('sk-ant-'), 'redacted text must not contain raw key prefix')

  // Shape invariants.
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
  assert.equal(r.matched, null)
})

test('multi-family — response with anthropic key and GitHub PAT produces two family entries', () => {
  const GH_PAT = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const input = `ANT=${ANT_KEY} GH=${GH_PAT}`
  const r = scrubResponse({ text: input, config: CFG_ON })

  const families = r.redactions.map(e => e.family)
  assert.ok(families.includes('anthropic'), 'anthropic family must be detected')
  assert.ok(families.includes('github_pat'), 'github_pat family must be detected')

  // Counts: one occurrence each.
  const antEntry = r.redactions.find(e => e.family === 'anthropic')
  assert.equal(antEntry.count, 1)
  const ghEntry = r.redactions.find(e => e.family === 'github_pat')
  assert.equal(ghEntry.count, 1)

  assert.ok(!r.redacted.includes('sk-ant-'), 'raw Anthropic key must not appear in redacted text')
  assert.ok(!r.redacted.includes('ghp_'), 'raw GitHub PAT must not appear in redacted text')
})

test('extraPatterns string — plain regex string tagged as <REDACTED:custom>', () => {
  const cfg = { scrubber: { enabled: true, extraPatterns: ['MY[A-Z]{8}'] } }
  const r = scrubResponse({ text: 'token=MYABCDEFGH rest of message', config: cfg })

  assert.ok(r.redacted.includes('<REDACTED:custom>'), 'custom tag must appear in redacted text')
  assert.ok(!r.redacted.includes('MYABCDEFGH'), 'original token must not appear in redacted text')

  const customEntry = r.redactions.find(e => e.family === 'custom')
  assert.ok(customEntry, 'custom redaction entry must be present in redactions')
  assert.equal(customEntry.count, 1)
})

test('extraPatterns object — {name,pattern} tagged as <REDACTED:corp>', () => {
  const cfg = {
    scrubber: {
      enabled: true,
      extraPatterns: [{ name: 'corp', pattern: 'CORP[0-9]{6}' }],
    },
  }
  const r = scrubResponse({ text: 'internal id=CORP123456 end', config: cfg })

  assert.ok(r.redacted.includes('<REDACTED:corp>'), 'corp tag must appear in redacted text')
  assert.ok(!r.redacted.includes('CORP123456'), 'original corp id must not appear in redacted text')

  const corpEntry = r.redactions.find(e => e.family === 'corp')
  assert.ok(corpEntry, 'corp redaction entry must be present in redactions')
  assert.equal(corpEntry.count, 1)
})

test('pipeline: family runs before context; context does not double-tag family hits', () => {
  const result = scrubResponse({
    text: 'OPENAI_KEY=sk-proj-' + 'A'.repeat(40),
    config: { scrubber: { enabled: true, extraPatterns: [] } },
  })
  const families = result.redactions.map(r => r.family)
  assert.ok(families.includes('openai'))
  assert.ok(!families.includes('assignment'), 'context must skip already-redacted family hits')
})

test('pipeline: context catches what family misses (DB_PASSWORD=hunter2)', () => {
  const result = scrubResponse({
    text: 'DB_PASSWORD=hunter2',
    config: { scrubber: { enabled: true, extraPatterns: [] } },
  })
  assert.ok(result.redactions.some(r => r.family === 'assignment'))
  assert.ok(!result.redacted.includes('hunter2'))
})

test('banner: empty when no redactions', () => {
  const r = scrubResponse({
    text: 'hello world',
    config: { scrubber: { enabled: true, extraPatterns: [] } },
  })
  assert.equal(r.banner, '')
})

test('banner: short fixed format with family + count, < 200 bytes', () => {
  const r = scrubResponse({
    text: 'sk-ant-api03-' + 'X'.repeat(86) + ' DB_PASSWORD=hunter2',
    config: { scrubber: { enabled: true, extraPatterns: [] } },
  })
  assert.match(r.banner, /^Sentinel: scrubbed \d+ secret\(s\) — /)
  assert.ok(r.banner.length < 200, `banner too long: ${r.banner.length}`)
})

test('redaction instances: prefix is first 4 chars, length matches, line=1', () => {
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const r = scrubResponse({
    text: tok,
    config: { scrubber: { enabled: true, extraPatterns: [] } },
  })
  const ghp = r.redactions.find(x => x.family === 'github_pat')
  assert.equal(ghp.instances[0].prefix, 'ghp_')
  assert.equal(ghp.instances[0].length, tok.length)
  assert.equal(ghp.instances[0].line, 1)
})

test('error swallowed — bad extraPatterns regex still returns valid shape with original text', () => {
  // An invalid regex source will cause scrubFamilies to throw during RegExp construction.
  const cfg = { scrubber: { enabled: true, extraPatterns: ['[invalid(regex'] } }
  const input = 'some safe output text'

  let r
  assert.doesNotThrow(() => {
    r = scrubResponse({ text: input, config: cfg })
  }, 'scrubResponse must never throw')

  // Shape must be valid regardless of internal failure.
  assert.equal(typeof r.redacted, 'string', 'redacted must be a string')
  assert.ok(Array.isArray(r.redactions), 'redactions must be an array')
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
  assert.equal(r.matched, null)
})
