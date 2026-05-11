// bash tokenizer — Sprint 04.
// Tokenizes a single bash command string into a flat Token array.
// Returns { tokens, exotic } — never throws.
//
// Token shape: { type: 'word' | 'op' | 'redirect', text: string, raw: string }
//   text — the logical value (quotes stripped, escapes resolved for 'word')
//   raw  — the exact source characters that produced this token
//
// exotic: true signals that the command contains a shell shape the downstream
// walker cannot safely analyse statically (heredoc, process substitution,
// command substitution, unbalanced quotes). The caller should emit 'ask'.

// ── Constants ──────────────────────────────────────────────────────────────────

// Operator token text values (type: 'op').
// Used by bash-walker to split a command string into segments.
const OP_TOKENS = new Set([';', '&&', '||', '|', '&'])

// Redirect operator text values (type: 'redirect').
// The token FOLLOWING a redirect op is the target path (a 'word' token).
const REDIRECT_TOKENS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '>&'])

// Characters that cannot appear inside an unquoted word token.
// Encountering one of these in DEFAULT state ends the current word.
const WORD_BREAK = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '<', '>', '"', "'", '#', '`'])

// $VAR and ${VAR} recognition — matches the variable name portion only.
// Used to consume a $-reference as an opaque word fragment.
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/

// ── Scanner states ─────────────────────────────────────────────────────────────

const DEFAULT   = 0
const IN_SINGLE = 1
const IN_DOUBLE = 2
const IN_COMMENT = 3

// ── Tokenizer ──────────────────────────────────────────────────────────────────

// Tokenize a single bash command string.
//
// Parameters:
//   commandString {string} — the raw bash command (may be a compound command
//                            with operators; may contain quotes and $VARs).
//
// Returns:
//   {
//     tokens:  Array<{ type: 'word'|'op'|'redirect', text: string, raw: string }>,
//     exotic:  boolean  — true if the string contains a shape the walker
//                         cannot safely analyse (heredoc, $(...), `...`,
//                         <(...), >(...), or unbalanced quotes)
//   }
export function tokenize(commandString) {
  const s = typeof commandString === 'string' ? commandString : ''
  const tokens = []
  let exotic = false
  let state = DEFAULT
  let i = 0
  const len = s.length

  // word accumulation buffers
  let wordText = ''   // logical text (escapes resolved, quotes stripped)
  let wordRaw  = ''   // raw source characters

  function flushWord() {
    if (wordRaw.length > 0) {
      tokens.push({ type: 'word', text: wordText, raw: wordRaw })
      wordText = ''
      wordRaw  = ''
    }
  }

  function pushOp(text, raw) {
    flushWord()
    tokens.push({ type: 'op', text, raw })
  }

  function pushRedirect(text, raw) {
    flushWord()
    tokens.push({ type: 'redirect', text, raw })
  }

  while (i < len) {
    const ch = s[i]

    // ── IN_COMMENT: discard until end of line ────────────────────────────────
    if (state === IN_COMMENT) {
      if (ch === '\n') {
        state = DEFAULT
      }
      i++
      continue
    }

    // ── IN_SINGLE: no escapes, no interpolation; close on matching ' ─────────
    if (state === IN_SINGLE) {
      if (ch === "'") {
        wordRaw += ch
        state = DEFAULT
        i++
        continue
      }
      wordText += ch
      wordRaw  += ch
      i++
      continue
    }

    // ── IN_DOUBLE: backslash escapes only; close on matching " ───────────────
    if (state === IN_DOUBLE) {
      if (ch === '"') {
        wordRaw += ch
        state = DEFAULT
        i++
        continue
      }
      if (ch === '\\' && i + 1 < len) {
        // consume the escape and the next char as a literal
        wordRaw  += ch + s[i + 1]
        wordText += s[i + 1]
        i += 2
        continue
      }
      // $VAR / ${VAR} inside double-quotes — opaque pass-through
      if (ch === '$') {
        const frag = consumeDollar(s, i)
        wordText += frag.text
        wordRaw  += frag.raw
        // set exotic if it was a $( substitution
        if (frag.exotic) exotic = true
        i += frag.consumed
        continue
      }
      // backtick inside double-quotes
      if (ch === '`') {
        exotic = true
        wordText += ch
        wordRaw  += ch
        i++
        continue
      }
      wordText += ch
      wordRaw  += ch
      i++
      continue
    }

    // ── DEFAULT state ────────────────────────────────────────────────────────

    // Whitespace: flush current word and stay in DEFAULT
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flushWord()
      i++
      continue
    }

    // Comment: flush word and enter IN_COMMENT
    if (ch === '#') {
      flushWord()
      state = IN_COMMENT
      i++
      continue
    }

    // Single-quoted string: open IN_SINGLE, append raw opening quote
    if (ch === "'") {
      wordRaw += ch
      state = IN_SINGLE
      i++
      continue
    }

    // Double-quoted string: open IN_DOUBLE, append raw opening quote
    if (ch === '"') {
      wordRaw += ch
      state = IN_DOUBLE
      i++
      continue
    }

    // Backtick command substitution — exotic
    if (ch === '`') {
      exotic = true
      wordText += ch
      wordRaw  += ch
      i++
      continue
    }

    // $VAR / ${VAR} / $( — consume and check exotic
    if (ch === '$') {
      const frag = consumeDollar(s, i)
      if (frag.exotic) exotic = true
      wordText += frag.text
      wordRaw  += frag.raw
      i += frag.consumed
      continue
    }

    // ── Operators and redirects ──────────────────────────────────────────────

    // Heredoc: << — exotic (must check before single-< redirect)
    if (ch === '<' && s[i + 1] === '<') {
      exotic = true
      flushWord()
      // consume << and any following non-whitespace (the delimiter token)
      let raw = '<<'
      i += 2
      while (i < len && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n') {
        raw += s[i]
        i++
      }
      tokens.push({ type: 'op', text: '<<', raw })
      continue
    }

    // Process substitution: <( and >( — exotic
    if ((ch === '<' || ch === '>') && s[i + 1] === '(') {
      exotic = true
      flushWord()
      tokens.push({ type: 'op', text: ch + '(', raw: ch + '(' })
      i += 2
      continue
    }

    // Redirects: &> (combined stdout+stderr to file)
    if (ch === '&' && s[i + 1] === '>') {
      pushRedirect('&>', '&>')
      i += 2
      continue
    }

    // Redirects: >& (bash redirect stdout to fd, but treat as redirect op)
    if (ch === '>' && s[i + 1] === '&') {
      pushRedirect('>&', '>&')
      i += 2
      continue
    }

    // Redirect: >> (append)
    if (ch === '>' && s[i + 1] === '>') {
      pushRedirect('>>', '>>')
      i += 2
      continue
    }

    // Redirect: 2>> (stderr append)
    if (ch === '2' && s[i + 1] === '>' && s[i + 2] === '>') {
      pushRedirect('2>>', '2>>')
      i += 3
      continue
    }

    // Redirect: 2> (stderr to file)
    if (ch === '2' && s[i + 1] === '>') {
      pushRedirect('2>', '2>')
      i += 2
      continue
    }

    // Redirect: > (stdout to file)
    if (ch === '>') {
      pushRedirect('>', '>')
      i++
      continue
    }

    // Redirect: < (stdin from file)
    if (ch === '<') {
      pushRedirect('<', '<')
      i++
      continue
    }

    // Operator: && (and)
    if (ch === '&' && s[i + 1] === '&') {
      pushOp('&&', '&&')
      i += 2
      continue
    }

    // Operator: || (or)
    if (ch === '|' && s[i + 1] === '|') {
      pushOp('||', '||')
      i += 2
      continue
    }

    // Operator: | (pipe)
    if (ch === '|') {
      pushOp('|', '|')
      i++
      continue
    }

    // Operator: ; (sequential)
    if (ch === ';') {
      pushOp(';', ';')
      i++
      continue
    }

    // Operator: & (background — only if not part of && or &>)
    if (ch === '&') {
      pushOp('&', '&')
      i++
      continue
    }

    // Default: accumulate as word character
    wordText += ch
    wordRaw  += ch
    i++
  }

  // EOF checks
  if (state === IN_SINGLE || state === IN_DOUBLE) {
    // Unbalanced quote
    exotic = true
  }
  flushWord()

  return { tokens, exotic }
}

// ── Private helper ─────────────────────────────────────────────────────────────

// Consume a $-prefixed expression starting at position i in string s.
// Returns { text, raw, consumed, exotic }.
//   text     — logical text to append to the current word
//   raw      — raw source characters consumed
//   consumed — number of source characters consumed (advance i by this)
//   exotic   — true when $( was detected (command substitution)
function consumeDollar(s, i) {
  const start = i
  // $( — command substitution, exotic
  if (s[i + 1] === '(') {
    return { text: '$(', raw: '$(', consumed: 2, exotic: true }
  }
  // ${VAR} — opaque brace-enclosed variable reference
  if (s[i + 1] === '{') {
    let j = i + 2
    while (j < s.length && s[j] !== '}') j++
    const raw = s.slice(i, j + 1) // includes closing }
    return { text: raw, raw, consumed: j + 1 - i, exotic: false }
  }
  // $VAR — consume the variable name
  const rest = s.slice(i + 1)
  const m = VAR_NAME_RE.exec(rest)
  if (m) {
    const raw = '$' + m[0]
    return { text: raw, raw, consumed: raw.length, exotic: false }
  }
  // bare $ with no recognisable continuation — pass through literally
  return { text: '$', raw: '$', consumed: 1, exotic: false }
}
