// Scrubber entropy — Sprint 06.
// Shannon entropy scanner for the output scrubber.
// Finds contiguous non-whitespace runs of length >= 24 in post-family text
// and replaces those with entropy > 4.5 bits with <REDACTED:high_entropy>.
// Skips runs that are already a <REDACTED:[a-z_]+> tag.
//
// Exported:
//   shannonEntropy(str) → number   (bits; 0 for empty string)
//   scrubEntropy(text)  → { text: string, count: number }

// Regex that identifies an already-redacted tag so the entropy scanner
// does not re-scan tokens that the family scanner already replaced.
const REDACTED_TAG_RE = /^<REDACTED:[a-z_]+>$/

// Regex that matches contiguous non-whitespace runs of at least 24 chars.
const RUN_RE = /\S{24,}/g

// Compute Shannon entropy: -Σ p_i log2(p_i) over the character-frequency
// distribution of str.  Returns 0 for an empty string.
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

// Scan text for high-entropy non-whitespace runs and replace them.
// Returns { text: <scrubbed string>, count: <number of replacements> }.
export function scrubEntropy(text) {
  let count = 0
  const scrubbed = text.replace(RUN_RE, (run) => {
    // Skip runs that are already a redaction tag (e.g. <REDACTED:anthropic>).
    if (REDACTED_TAG_RE.test(run)) return run
    if (shannonEntropy(run) > 4.5) {
      count++
      return '<REDACTED:high_entropy>'
    }
    return run
  })
  return { text: scrubbed, count }
}
