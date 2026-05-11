import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ulid, _resetMonotonicState } from '../src/sentinel/ulid.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
void __dirname // kept for consistency with the project's path-resolution idiom

// Crockford base32 alphabet — same constant as in the module, duplicated here
// so the test is self-contained and does not rely on a non-exported module symbol.
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

// Inline decode helper: converts the 10-char timestamp prefix back to milliseconds.
// Mirrors encodeTime in reverse. Used only for the round-trip timestamp test.
function decodeTime(ulid) {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ms = 0
  for (let i = 0; i < 10; i++) {
    ms = ms * 32 + ENCODING.indexOf(ulid[i])
  }
  return ms
}

test('ulid() returns a 26-char Crockford-base32 string', () => {
  _resetMonotonicState()
  const id = ulid()
  assert.equal(typeof id, 'string')
  assert.equal(id.length, 26)
  assert.match(id, CROCKFORD_RE)
})

test('1000 successive ulid() calls are strictly lexicographically increasing', () => {
  _resetMonotonicState()
  const ids = []
  for (let i = 0; i < 1000; i++) {
    ids.push(ulid())
  }
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i] > ids[i - 1],
      `ulid[${i}] "${ids[i]}" must be > ulid[${i - 1}] "${ids[i - 1]}"`
    )
  }
})

test('two ulid() calls in the same ms share timestamp prefix and differ in random tail', () => {
  // Force same-millisecond scenario by resetting state and calling twice in rapid
  // succession inside the same synchronous turn — both calls see Date.now() at
  // effectively the same instant, but even if they land on different ms the
  // monotonic guarantee still means the second is strictly greater.
  // To make the same-ms branch deterministic we mock Date.now for the duration.
  _resetMonotonicState()
  const fixedMs = 1715000000000
  const origNow = Date.now
  Date.now = () => fixedMs

  let first, second
  try {
    first = ulid()
    second = ulid()
  } finally {
    Date.now = origNow
    _resetMonotonicState()
  }

  // Both should match the Crockford alphabet.
  assert.match(first, CROCKFORD_RE)
  assert.match(second, CROCKFORD_RE)

  // Timestamp prefix (first 10 chars) must be identical — same forced ms.
  assert.equal(first.slice(0, 10), second.slice(0, 10))

  // Second must be strictly greater overall (monotonic random tail increment).
  assert.ok(second > first, `second "${second}" must be > first "${first}"`)
})

test('first 10 chars decode back to a timestamp within 5 ms of Date.now()', () => {
  _resetMonotonicState()
  const before = Date.now()
  const id = ulid()
  const after = Date.now()

  const decoded = decodeTime(id)
  assert.ok(
    decoded >= before - 5 && decoded <= after + 5,
    `decoded timestamp ${decoded} must be within [${before - 5}, ${after + 5}]`
  )
})
