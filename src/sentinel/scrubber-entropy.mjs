// Scrubber entropy — Sprint scrubber rebuild.
// Detects high-entropy opaque tokens that survived family/context passes.
// Tokeniser is the base64url alphabet so paths (which contain `/`, `.`,
// punctuation) cannot accidentally form one long run.

const REDACTED_TAG_RE = /^<REDACTED:[a-z_]+>$/

function buildCandidateRe(minLength) {
  return new RegExp(`[A-Za-z0-9_-]{${minLength},}`, 'g')
}

// Subresource Integrity prefix: skip when run is preceded by `sha256-` etc.
const SRI_PREFIX_RE = /sha(?:256|384|512)-$/

export function shannonEntropy(str) {
  if (str.length === 0) return 0
  const freq = new Map()
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  const len = str.length
  for (const count of freq.values()) {
    const p = count / len
    h -= p * Math.log2(p)
  }
  return h
}

function countLinesUpTo(text, offset) {
  let n = 0
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export function scrubEntropy(text, opts = {}) {
  const threshold = opts.threshold ?? 4.0
  const minLength = opts.minLength ?? 32
  const re = buildCandidateRe(minLength)
  const instances = []
  const t = String(text ?? '')
  const scrubbed = t.replace(re, (run, offset) => {
    if (REDACTED_TAG_RE.test(run)) return run
    // SRI exemption: run is immediately preceded by `sha\d+-`.
    const preceding = t.slice(Math.max(0, offset - 10), offset)
    if (SRI_PREFIX_RE.test(preceding)) return run
    if (shannonEntropy(run) > threshold) {
      instances.push({
        prefix: run.slice(0, 4),
        length: run.length,
        line: countLinesUpTo(t, offset) + 1,
      })
      return '<REDACTED:high_entropy>'
    }
    return run
  })
  return { text: scrubbed, count: instances.length, instances }
}
