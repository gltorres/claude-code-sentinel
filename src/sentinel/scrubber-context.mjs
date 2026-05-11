// Context-gated detector: assignments where a secret-keyword appears left
// of `=` or `:` and a non-trivial value follows. Catches low-entropy
// credentials like `DB_PASSWORD=hunter2` that the entropy detector misses.

const KEYWORD = '(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?token|encryption[_-]?key)'

// Keywords may sit inside identifiers (DB_PASSWORD, my-api-key) so we accept
// any non-alphabetic boundary on the left and any non-alphabetic suffix
// before the `=` / `:` separator.
const ASSIGN_RE = new RegExp(
  `(?:^|[^a-zA-Z])${KEYWORD}(?:[^a-zA-Z]|$)?\\s*[=:]\\s*(?:'([^']{4,})'|"([^"]{4,})"|([^\\s,;}'"]{4,}))`,
  'gi',
)

const TAG = '<REDACTED:assignment>'

function countLinesUpTo(text, offset) {
  let n = 0
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export function scrubContext(text) {
  const t = String(text ?? '')
  const instances = []
  const out = t.replace(ASSIGN_RE, (match, single, double, bare, offset) => {
    const value = single ?? double ?? bare
    if (value == null) return match
    if (/^<REDACTED:[a-z_]+>$/.test(value)) return match
    if (/^(?:none|null|undefined|true|false|changeme|todo|xxx+|\.+)$/i.test(value)) return match
    instances.push({
      prefix: value.slice(0, 4),
      length: value.length,
      line: countLinesUpTo(t, offset) + 1,
    })
    // Replace just the value portion of the match while preserving any quotes.
    const valueStart = match.lastIndexOf(value)
    return match.slice(0, valueStart) + TAG + match.slice(valueStart + value.length)
  })
  const redactions = instances.length > 0
    ? [{ family: 'assignment', count: instances.length, instances }]
    : []
  return { text: out, redactions }
}
