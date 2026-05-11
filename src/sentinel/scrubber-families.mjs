// scrubber families — Sprint 06.

// Pre-compiled family regexes applied in fixed order.
// Tag format: <REDACTED:<family>> — no length, no preview (brief line 50).
// Do NOT reuse or refactor SK_ANT_RE from bash-policy.mjs:5 — different surface,
// different sigil ([REDACTED] vs <REDACTED:family>). See research §3.2.
const FAMILY_REGEXES = Object.freeze([
  {
    family: 'anthropic',
    re: /sk-ant-[A-Za-z0-9_-]{32,}/g,
    tag: '<REDACTED:anthropic>',
  },
  {
    family: 'openai',
    // Negative lookahead prevents eating sk-ant- tokens (anthropic applied first,
    // but the lookahead is a belt-and-suspenders guard for out-of-order callers).
    re: /sk-(?!ant-)[A-Za-z0-9]{40,}/g,
    tag: '<REDACTED:openai>',
  },
  {
    family: 'github_pat',
    re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
    tag: '<REDACTED:github_pat>',
  },
  {
    family: 'aws_akid',
    re: /AKIA[0-9A-Z]{16}/g,
    tag: '<REDACTED:aws_akid>',
  },
  {
    // aws_session_token= key name is preserved; only the value is redacted.
    // Capture group 1 = the value (runs up to whitespace / quote / & / ;).
    family: 'aws_session',
    re: /aws_session_token=([^\s"'&;]+)/gi,
    tag: '<REDACTED:aws_session>',
  },
  {
    family: 'slack',
    re: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    tag: '<REDACTED:slack>',
  },
  {
    family: 'stripe_live',
    re: /sk_live_[A-Za-z0-9]{24,}/g,
    tag: '<REDACTED:stripe_live>',
  },
  {
    family: 'sendgrid',
    re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    tag: '<REDACTED:sendgrid>',
  },
  {
    family: 'atlassian',
    re: /ATATT3[A-Za-z0-9_-]{180,}/g,
    tag: '<REDACTED:atlassian>',
  },
  {
    family: 'langsmith',
    re: /lsv2_pt_[A-Za-z0-9]{32,}/g,
    tag: '<REDACTED:langsmith>',
  },
  {
    family: 'jwt',
    re: /eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=.+/-]+/g,
    tag: '<REDACTED:jwt>',
  },
])

// Apply one regex entry to the working text, counting replacements.
// aws_session is special: the replacement preserves the key name while
// redacting only the captured value portion.
function applyFamily(text, { family, re, tag }) {
  let count = 0
  // Reset lastIndex in case the regex object is reused across calls.
  re.lastIndex = 0
  let out
  if (family === 'aws_session') {
    out = text.replace(re, (_match, _val) => {
      count++
      return `aws_session_token=${tag}`
    })
  } else {
    out = text.replace(re, () => {
      count++
      return tag
    })
  }
  return { text: out, count }
}

// Apply a user-supplied extra pattern entry.
// Accepts:  string  → regex source, tagged <REDACTED:custom>
//           {name, pattern}  → tagged <REDACTED:<name>>
// Malformed regex sources are caught and skipped silently.
function applyExtra(text, entry) {
  let src, tag
  if (typeof entry === 'string') {
    src = entry
    tag = '<REDACTED:custom>'
  } else if (entry && typeof entry === 'object' && entry.name && entry.pattern) {
    src = entry.pattern
    tag = `<REDACTED:${entry.name}>`
  } else {
    return { text, count: 0 }
  }
  let re
  try {
    re = new RegExp(src, 'g')
  } catch {
    return { text, count: 0 }
  }
  let count = 0
  const out = text.replace(re, () => {
    count++
    return tag
  })
  return { text: out, count }
}

// Scan `text` for all 11 hardcoded credential families and any `extraPatterns`.
// Returns:
//   { text: <scrubbed string>,
//     redactions: [{ family: string, count: number }, ...] }
// Only families with count >= 1 appear in redactions.
// The returned text is suitable for the next pass (entropy scanner in spec 3).
export function scrubFamilies(text, extraPatterns) {
  let working = String(text ?? '')
  const redactions = []

  for (const entry of FAMILY_REGEXES) {
    const { text: next, count } = applyFamily(working, entry)
    working = next
    if (count > 0) redactions.push({ family: entry.family, count })
  }

  if (Array.isArray(extraPatterns)) {
    for (const entry of extraPatterns) {
      const { text: next, count } = applyExtra(working, entry)
      if (count > 0) {
        const name = (typeof entry === 'object' && entry?.name) ? entry.name : 'custom'
        redactions.push({ family: name, count })
        working = next
      }
    }
  }

  return { text: working, redactions }
}
