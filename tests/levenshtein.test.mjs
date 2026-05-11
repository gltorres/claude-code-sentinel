// Levenshtein helper tests — Sprint 08, Spec 01.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { levenshtein, nearestPopular } from '../src/sentinel/levenshtein.mjs'

// ── levenshtein: identity ─────────────────────────────────────────────────────

test('levenshtein: identical strings return 0', () => {
  assert.equal(levenshtein('lodash', 'lodash'), 0)
  assert.equal(levenshtein('', ''), 0)
  assert.equal(levenshtein('a', 'a'), 0)
})

// ── levenshtein: empty-string edge cases ──────────────────────────────────────

test('levenshtein: empty a returns b.length', () => {
  assert.equal(levenshtein('', 'abc'), 3)
})

test('levenshtein: empty b returns a.length', () => {
  assert.equal(levenshtein('abc', ''), 3)
})

// ── levenshtein: single substitution ─────────────────────────────────────────

test('levenshtein: one character substituted returns 1', () => {
  // "flask" → "flask" with one char changed at position 2
  assert.equal(levenshtein('flXsk', 'flask'), 1)
})

test('levenshtein: lodash/lodahs — last two chars swapped is distance 2', () => {
  // l-o-d-a-h-s vs l-o-d-a-s-h: 's' and 'h' are swapped — two substitutions
  assert.equal(levenshtein('lodash', 'lodahs'), 2)
})

test('levenshtein: transposition of adjacent chars returns 2 (not DL distance)', () => {
  // reqeusts vs requests: positions 3–4 are 'e','u' vs 'u','e' — a transposition.
  // Standard Levenshtein (not Damerau-Levenshtein) costs 2 for any swap.
  assert.equal(levenshtein('reqeusts', 'requests'), 2)
})

// ── levenshtein: transposition (two adjacent chars swapped) ──────────────────

test('levenshtein: two adjacent chars swapped is distance 2 (not DL distance)', () => {
  // Standard Levenshtein (not Damerau-Levenshtein): a transposition costs 2
  // "ab" → "ba": delete 'a' and insert after 'b' = cost 2
  assert.equal(levenshtein('ab', 'ba'), 2)
})

// ── levenshtein: longer strings ───────────────────────────────────────────────

test('levenshtein: completely different strings of equal length return full length', () => {
  assert.equal(levenshtein('aaa', 'bbb'), 3)
})

test('levenshtein: insertion — one char added in the middle', () => {
  // "colour" vs "color": one insertion
  assert.equal(levenshtein('colour', 'color'), 1)
})

// ── nearestPopular: acceptance-criteria examples ──────────────────────────────

test('nearestPopular: reqeusts → requests is nearest with distance 2 (standard Levenshtein)', () => {
  const result = nearestPopular('reqeusts', ['requests', 'flask'])
  assert.equal(result.name, 'requests')
  assert.equal(result.distance, 2)
})

test('nearestPopular: exact match in list returns distance 0', () => {
  const result = nearestPopular('lodash', ['lodash', 'underscore', 'ramda'])
  assert.equal(result.name, 'lodash')
  assert.equal(result.distance, 0)
})

test('nearestPopular: picks the closest among multiple candidates', () => {
  // "flusk" is 1 edit from "flask" and 4+ edits from "requests"
  const result = nearestPopular('flusk', ['requests', 'flask', 'django'])
  assert.equal(result.name, 'flask')
  assert.equal(result.distance, 1)
})

test('nearestPopular: empty list returns { name: null, distance: Infinity }', () => {
  const result = nearestPopular('anything', [])
  assert.equal(result.name, null)
  assert.equal(result.distance, Infinity)
})

test('nearestPopular: tie broken by first occurrence in list', () => {
  // Both "aaa" and "bbb" are distance 3 from "ccc"
  const result = nearestPopular('ccc', ['aaa', 'bbb'])
  assert.equal(result.name, 'aaa', 'first minimum in array order wins')
})
