// scrubber policy — Sprint 06.
import { scrubFamilies } from './scrubber-families.mjs'
import { scrubEntropy } from './scrubber-entropy.mjs'

// Scrub a PostToolUse tool response for credential-shaped strings and
// high-entropy runs, returning a cleaned version for additionalContext.
//
// Returns:
//   {
//     redacted:   string  — scrubbed text ('' when scrubber is disabled),
//     redactions: Array<{ family: string, count: number }>,
//     decision:   'allow',
//     rule:       null,
//     matched:    null,
//   }
//
// Options:
//   text   {string|any}  — raw tool response (coerced with String())
//   config {object}      — merged Sentinel config object
export function scrubResponse({ text, config } = {}) {
  try {
    const t = String(text ?? '')

    if (config?.scrubber?.enabled === false) {
      return { redacted: '', redactions: [], decision: 'allow', rule: null, matched: null }
    }

    const { text: t2, redactions: famRedactions } =
      scrubFamilies(t, config?.scrubber?.extraPatterns ?? [])

    const { text: t3, count: entropyCount } = scrubEntropy(t2)

    const redactions = [...famRedactions]
    if (entropyCount > 0) {
      redactions.push({ family: 'high_entropy', count: entropyCount })
    }

    return { redacted: t3, redactions, decision: 'allow', rule: null, matched: null }
  } catch {
    return {
      redacted: String(text ?? ''),
      redactions: [],
      decision: 'allow',
      rule: null,
      matched: null,
    }
  }
}
