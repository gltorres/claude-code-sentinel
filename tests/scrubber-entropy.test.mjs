// scrubber-entropy tests — Sprint 06.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shannonEntropy, scrubEntropy } from '../src/sentinel/scrubber-entropy.mjs'

// ── shannonEntropy: known values ──────────────────────────────────────────────

test('shannonEntropy: single repeated character has entropy 0', () => {
  assert.equal(shannonEntropy('aaaaa'), 0)
})

test('shannonEntropy: uniform 6-char string has entropy log2(6)', () => {
  const h = shannonEntropy('abcdef')
  const expected = Math.log2(6) // ≈ 2.585
  assert.ok(
    Math.abs(h - expected) < 1e-9,
    `expected ${expected}, got ${h}`
  )
})

test('shannonEntropy: 32-char base64-ish string has entropy > 4.5', () => {
  // Mix of upper, lower, digits, +, / — high diversity
  const s = 'A3bC9dEfGhIjKlMnOpQrStUvWxYz012345'
  assert.ok(shannonEntropy(s) > 4.5, `entropy of "${s}" must exceed 4.5`)
})

// ── scrubEntropy: low-entropy run preserved ───────────────────────────────────

test('scrubEntropy: 24-char all-same-char run is preserved (entropy ≈ 0)', () => {
  const input = 'a'.repeat(24)
  const { text, count } = scrubEntropy(input)
  assert.equal(text, input)
  assert.equal(count, 0)
})

// ── scrubEntropy: high-entropy run redacted ───────────────────────────────────

test('scrubEntropy: 32-char base64-ish string is replaced with <REDACTED:high_entropy>', () => {
  // 32 chars with high character diversity — will exceed the 4.5 threshold
  const token = 'A3bC9dEfGhIjKlMnOpQrStUvWxYz0123'
  const { text, count } = scrubEntropy(token)
  assert.equal(text, '<REDACTED:high_entropy>')
  assert.equal(count, 1)
})

// ── scrubEntropy: existing <REDACTED:...> tag is not re-replaced ──────────────

test('scrubEntropy: existing <REDACTED:anthropic> tag is not double-replaced', () => {
  const input = 'foo <REDACTED:anthropic> bar'
  const { text, count } = scrubEntropy(input)
  assert.equal(text, input)
  assert.equal(count, 0)
})

// ── scrubEntropy: mixed prose + high-entropy run ──────────────────────────────

test('scrubEntropy: prose is preserved; only the high-entropy run is redacted', () => {
  const token = 'A3bC9dEfGhIjKlMnOpQrStUvWxYz0123'
  const input = `the build passed in 4.2 seconds, token=${token}, done`
  const { text, count } = scrubEntropy(input)
  assert.ok(text.includes('the build passed in 4.2 seconds'), 'prose preserved')
  assert.ok(text.includes('<REDACTED:high_entropy>'), 'run redacted')
  assert.ok(!text.includes(token), 'original token not present')
  assert.equal(count, 1)
})

// ── scrubEntropy: run shorter than 24 chars is never inspected ────────────────

test('scrubEntropy: run of exactly 23 chars is never inspected regardless of entropy', () => {
  // Construct a 23-char string with high character diversity
  const run23 = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh'  // 24 chars — trim one
  const run22 = run23.slice(0, 23)
  const { text, count } = scrubEntropy(run22)
  assert.equal(text, run22)
  assert.equal(count, 0)
})
