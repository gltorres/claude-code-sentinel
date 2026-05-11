// Vendored ULID generator — no runtime dependencies. Sprint 02.
import { randomBytes } from 'node:crypto'

// Crockford base32 alphabet: excludes I, L, O, U to avoid visual ambiguity.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// Encode a millisecond timestamp into `len` Crockford characters.
// Works right-to-left so the most-significant character lands at index 0.
function encodeTime(ms, len) {
  let str = ''
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[ms % 32] + str
    ms = Math.floor(ms / 32)
  }
  return str
}

// Encode a 10-byte Buffer as 16 Crockford characters (big-endian 80-bit integer).
function encodeRandom(bytes) {
  // Convert the 10-byte buffer to a BigInt for clean modular arithmetic.
  let n = 0n
  for (let i = 0; i < bytes.length; i++) {
    n = (n << 8n) | BigInt(bytes[i])
  }
  let str = ''
  for (let i = 15; i >= 0; i--) {
    str = ENCODING[Number(n % 32n)] + str
    n >>= 5n
  }
  return str
}

// Increment the 10-byte buffer in-place as a big-endian 80-bit integer.
// Carries propagate left. Overflow wraps (astronomically unlikely in practice).
function incrementRandom(bytes) {
  let carry = 1
  for (let i = bytes.length - 1; i >= 0 && carry; i--) {
    const val = bytes[i] + carry
    bytes[i] = val & 0xff
    carry = val >> 8
  }
  return bytes
}

// Monotonic state: reset to sentinels so the first call always seeds fresh randomness.
let lastMs = -1
let lastRandom = null

export function ulid() {
  const ms = Date.now()
  if (ms === lastMs) {
    // Same millisecond — increment the random tail to preserve strict ordering.
    incrementRandom(lastRandom)
  } else {
    // New millisecond — seed a fresh random tail.
    lastMs = ms
    lastRandom = randomBytes(10)
  }
  return encodeTime(ms, 10) + encodeRandom(lastRandom)
}

// Reset monotonic state for test isolation. Not intended for production use.
export function _resetMonotonicState() {
  lastMs = -1
  lastRandom = null
}
