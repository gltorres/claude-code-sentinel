// Session audit reader and banner composer — Sprint 07, Spec 01.
// Reads the last 7 days of audit log activity from the end of the file
// (reverse-chunk scan) and composes the SessionStart banner string.
// All I/O is fail-open: any error returns the empty summary.
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { resolveAuditPath } from './audit.mjs'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK_SIZE = 8 * 1024 // 8 KiB
const COUNTED_EVENTS = new Set(['block', 'scrub', 'ask'])

// Summarise audit log activity within the last 7 days.
//
// Parameters:
//   config {object} — merged Sentinel config (as returned by loadConfig)
//   now    {number} — current epoch ms (injectable for tests; defaults to Date.now())
//
// Returns:
//   { counts: { block: number, scrub: number, ask: number }, hasAny: boolean }
//
// Always returns the empty summary on any I/O error or missing file (fail-open).
export function summariseAuditWindow({ config, now = Date.now() } = {}) {
  const empty = { counts: { block: 0, scrub: 0, ask: 0 }, hasAny: false }
  const counts = { block: 0, scrub: 0, ask: 0 }
  const cutoff = now - SEVEN_DAYS_MS

  let path
  try { path = resolveAuditPath(config) } catch { return empty }

  let size
  try { size = statSync(path).size } catch { return empty }
  if (size === 0) return empty

  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(CHUNK_SIZE)
    let remaining = size
    // carry holds an incomplete line fragment from the right edge of the previous chunk
    let carry = ''
    let stop = false

    while (remaining > 0 && !stop) {
      const readSize = Math.min(CHUNK_SIZE, remaining)
      const offset = remaining - readSize
      const bytesRead = readSync(fd, buf, 0, readSize, offset)
      remaining -= bytesRead

      // Prepend the chunk text to the carry so the carry stays at the right
      const chunkText = buf.toString('utf8', 0, bytesRead)
      const combined = chunkText + carry

      // Split into lines; the leftmost segment may be incomplete — save as new carry
      const lines = combined.split('\n')
      carry = lines.shift() // leftmost may be partial; processed in the next (older) chunk

      // Process lines right-to-left (newest first within this chunk)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        let record
        try { record = JSON.parse(line) } catch { continue } // skip malformed
        if (!record || typeof record.ts !== 'string') continue
        const ts = Date.parse(record.ts)
        if (Number.isNaN(ts)) continue
        if (ts < cutoff) {
          stop = true
          break
        }
        if (COUNTED_EVENTS.has(record.event)) {
          counts[record.event] = (counts[record.event] ?? 0) + 1
        }
      }
    }

    // Process any remaining carry line (the very first line of the file)
    if (!stop && carry.trim()) {
      let record
      try { record = JSON.parse(carry.trim()) } catch { record = null }
      if (record && typeof record.ts === 'string') {
        const ts = Date.parse(record.ts)
        if (!Number.isNaN(ts) && ts >= cutoff && COUNTED_EVENTS.has(record.event)) {
          counts[record.event] = (counts[record.event] ?? 0) + 1
        }
      }
    }
  } catch {
    return empty
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }

  const hasAny = counts.block + counts.scrub + counts.ask > 0
  return { counts, hasAny }
}

// Pluralise a noun for English count strings.
// plural(1, 'block') → '1 block'
// plural(3, 'block') → '3 blocks'
function plural(n, noun) {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`
}

const CAVEAT = 'PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence.'

// Compose the one-line SessionStart banner from an audit summary.
//
// Parameters:
//   summary — return value of summariseAuditWindow
//
// Returns a string < 500 characters that always includes the next-turn-only caveat.
export function composeBanner({ counts, hasAny } = {}) {
  if (!hasAny) {
    return `Sentinel active — no events yet. ${CAVEAT}`
  }
  const { block = 0, scrub = 0, ask = 0 } = counts ?? {}
  return `Sentinel active — last 7d: ${plural(block, 'block')}, ${plural(scrub, 'scrub')}, ${plural(ask, 'ask')}. ${CAVEAT}`
}
