// Vendored glob matcher — no runtime dependencies. Sprint 03.
// Translates a glob pattern to a RegExp and tests it against a POSIX-style path.
// Supported syntax: ** (any segments), * (intra-segment wildcard), ? (single non-/ char),
// [abc] / [a-z] character classes, [!a] negation. Leading **/ or / anchoring.

// Characters that are regex metacharacters but carry no glob meaning.
// These are escaped before the glob tokens are processed.
const REGEX_SPECIALS = /[.+(){}|^$[\]\\]/g

// Escape a single literal character for inclusion in a RegExp source string.
function escapeRegex(ch) {
  return '\\' + ch
}

// Compile a glob pattern string to an anchored RegExp.
// The caller is responsible for resolving paths (tilde expansion, cwd joining)
// before passing them to matchGlob — this module is pure pattern logic only.
export function compileGlob(pattern) {
  let src = ''
  let i = 0
  const len = pattern.length

  // Determine anchoring prefix:
  // - '**/...' prefix → pattern may appear anywhere in the path (after any segments)
  // - '/' prefix → absolute, must match from the root
  // - anything else → treated as a relative pattern that may appear after any '/'
  let hasLeadingDoubleStar = false
  if (pattern.startsWith('**/')) {
    hasLeadingDoubleStar = true
    i = 3 // consume the '**/' prefix; we will handle anchoring below
  }

  while (i < len) {
    const ch = pattern[i]

    // Double-star wildcard: '**' matches any sequence including '/'
    if (ch === '*' && pattern[i + 1] === '*') {
      src += '.*'
      i += 2
      // Consume a following '/' so '**/' does not also produce a literal slash
      if (pattern[i] === '/') i++
      continue
    }

    // Single-star wildcard: matches any non-'/' sequence within one segment
    if (ch === '*') {
      src += '[^/]*'
      i++
      continue
    }

    // Question mark: matches exactly one non-'/' character
    if (ch === '?') {
      src += '[^/]'
      i++
      continue
    }

    // Character class: pass through mostly verbatim; translate [! to [^
    if (ch === '[') {
      let cls = '['
      i++ // consume '['
      if (pattern[i] === '!') {
        cls += '^'
        i++ // consume '!'
      }
      // Collect until ']' or end of pattern
      while (i < len && pattern[i] !== ']') {
        cls += pattern[i]
        i++
      }
      cls += ']'
      if (pattern[i] === ']') i++ // consume ']'
      src += cls
      continue
    }

    // All other characters: escape regex metacharacters, pass literals through
    if (REGEX_SPECIALS.test(ch)) {
      REGEX_SPECIALS.lastIndex = 0 // reset stateful regex
      src += escapeRegex(ch)
    } else {
      src += ch
    }
    i++
  }

  // Build the final anchored pattern
  let full
  if (hasLeadingDoubleStar) {
    // '**/.env' must match '/home/user/.env', 'proj/.env', and '.env'
    full = '^(.*/)?' + src + '$'
  } else if (pattern.startsWith('/')) {
    // Absolute pattern — anchor directly to start
    full = '^' + src + '$'
  } else if (pattern.includes('/')) {
    // Relative pattern with embedded separator (e.g. src/index.mjs) — allow leading path
    full = '^(.*/)?' + src + '$'
  } else {
    // Single-segment pattern (e.g. *.md) — must NOT cross a path separator
    full = '^' + src + '$'
  }

  return new RegExp(full)
}

// Test whether `path` matches `pattern`.
// Returns true if the compiled RegExp matches the full path string.
export function matchGlob(pattern, path) {
  return compileGlob(pattern).test(path)
}
