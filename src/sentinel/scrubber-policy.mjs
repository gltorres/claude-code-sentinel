// scrubber policy — Sprint scrubber rebuild.
import { scrubFamilies } from './scrubber-families.mjs'
import { scrubContext }  from './scrubber-context.mjs'
import { scrubEntropy }  from './scrubber-entropy.mjs'

// Compose a fixed-format banner like:
//   Sentinel: scrubbed 3 secret(s) — 1 openai, 2 high_entropy. Do not echo redacted regions.
export function composeBanner(redactions) {
  if (redactions.length === 0) return ''
  const total = redactions.reduce((s, r) => s + r.count, 0)
  const parts = redactions.map(r => `${r.count} ${r.family}`).join(', ')
  return `Sentinel: scrubbed ${total} secret(s) — ${parts}. Do not echo redacted regions.`
}

// Scrub a PostToolUse tool response for credential-shaped strings,
// assignment-shaped low-entropy secrets, and high-entropy runs.
//
// Returns:
//   {
//     redacted:   string  — scrubbed text ('' when scrubber is disabled),
//     redactions: Array<{ family, count, instances:[{prefix,length,line}] }>,
//     banner:     string  — short, fixed-format model-facing notice,
//     decision:   'allow',
//     rule:       null,
//     matched:    null,
//   }
export function scrubResponse({ text, config } = {}) {
  try {
    const t = String(text ?? '')

    if (config?.scrubber?.enabled === false) {
      return { redacted: '', redactions: [], banner: '', decision: 'allow', rule: null, matched: null }
    }

    const { text: t2, redactions: famRedactions } =
      scrubFamilies(t, config?.scrubber?.extraPatterns ?? [])

    const { text: t2b, redactions: ctxRedactions } = scrubContext(t2)

    const { text: t3, instances: entropyInstances } = scrubEntropy(t2b, {
      threshold: config?.scrubber?.entropyThreshold,
      minLength: config?.scrubber?.entropyMinLength,
    })

    const redactions = [...famRedactions, ...ctxRedactions]
    if (entropyInstances.length > 0) {
      redactions.push({
        family: 'high_entropy',
        count: entropyInstances.length,
        instances: entropyInstances,
      })
    }

    return {
      redacted: t3,
      redactions,
      banner: composeBanner(redactions),
      decision: 'allow',
      rule: null,
      matched: null,
    }
  } catch {
    return {
      redacted: String(text ?? ''),
      redactions: [],
      banner: '',
      decision: 'allow',
      rule: null,
      matched: null,
    }
  }
}
