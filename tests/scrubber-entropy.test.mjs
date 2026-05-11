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

// ── scrubEntropy: run shorter than minLength is never inspected ──────────────

test('scrubEntropy: run of exactly 23 chars is never inspected regardless of entropy', () => {
  const run23 = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh'  // 24 chars — trim one
  const run22 = run23.slice(0, 23)
  const { text, count } = scrubEntropy(run22)
  assert.equal(text, run22)
  assert.equal(count, 0)
})

// ── scrubEntropy: new contract (Phase 4) ──────────────────────────────────────

test('scrubEntropy: 31-char run is NEVER inspected (under default minLength 32)', () => {
  const tok = 'A3bC9dEfGhIjKlMnOpQrStUvWxYz012'  // 31 chars
  const { text, count } = scrubEntropy(tok)
  assert.equal(text, tok)
  assert.equal(count, 0)
})

test('scrubEntropy: long file path is NOT redacted (excluded by alphabet)', () => {
  const p = '/Users/foo/workspace/apps/claude-code-sentinel/src/sentinel/hook.mjs'
  const { text, count } = scrubEntropy(p)
  assert.equal(text, p)
  assert.equal(count, 0)
})

test('scrubEntropy: SHA-1 (40 hex) NOT redacted at default threshold 4.0', () => {
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4'
  const { text, count } = scrubEntropy(sha)
  assert.equal(count, 0)
  assert.equal(text, sha)
})

test('scrubEntropy: SRI integrity hash skipped via exemption', () => {
  const input = '"integrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'
  const { count } = scrubEntropy(input)
  assert.equal(count, 0)
})

test('scrubEntropy: custom threshold lowers sensitivity', () => {
  const tok = 'a'.repeat(16) + 'b'.repeat(16) // 32 chars, low entropy ~1
  const { count: c1 } = scrubEntropy(tok, { threshold: 4.0 })
  const { count: c2 } = scrubEntropy(tok, { threshold: 0.5 })
  assert.equal(c1, 0)
  assert.equal(c2, 1)
})

test('scrubEntropy: custom minLength lets shorter runs fire', () => {
  const tok = 'A3bC9dEfGhIj0123' // 16 chars
  const { count } = scrubEntropy(tok, { minLength: 16, threshold: 3.0 })
  assert.equal(count, 1)
})

test('scrubEntropy: instances carry prefix/length/line metadata', () => {
  const tok = 'A3bC9dEfGhIjKlMnOpQrStUvWxYz0123'
  const { instances } = scrubEntropy(tok)
  assert.equal(instances.length, 1)
  assert.equal(instances[0].prefix, 'A3bC')
  assert.equal(instances[0].length, 32)
  assert.equal(instances[0].line, 1)
})
