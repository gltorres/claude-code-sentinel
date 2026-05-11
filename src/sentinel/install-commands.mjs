// install command parser — Sprint 05.
// Parses a walked bash result into registry-lookup records.
// Returns Array<{ ecosystem, name, segment }> — never throws.
// Pure function — no I/O.

// ── Install-spec table ────────────────────────────────────────────────────────

// Each entry maps a CLI binary name to the ecosystem it installs into and the
// set of verbs (first arg) that trigger an install action.
//
// Shape: { ecosystem: 'npm'|'pypi'|'crates', verbs: Set<string> }
const INSTALL_SPECS = new Map([
  ['npm',   { ecosystem: 'npm',    verbs: new Set(['install', 'i']) }],
  ['pnpm',  { ecosystem: 'npm',    verbs: new Set(['add']) }],
  ['yarn',  { ecosystem: 'npm',    verbs: new Set(['add']) }],
  ['pip',   { ecosystem: 'pypi',   verbs: new Set(['install']) }],
  ['pip3',  { ecosystem: 'pypi',   verbs: new Set(['install']) }],
  ['uv',    { ecosystem: 'pypi',   verbs: new Set(['add']) }],
  ['cargo', { ecosystem: 'crates', verbs: new Set(['add']) }],
])

// ── Normalisation helpers ─────────────────────────────────────────────────────

// Returns true when the arg is a flag (starts with '-').
// Used to skip --save-dev, --user, -q, etc. before treating args as names.
function isFlag(arg) {
  return typeof arg === 'string' && arg.startsWith('-')
}

// Strip version specifiers and extras from a package name arg.
//
// Rules (applied left-to-right):
//   1. Find the first occurrence of any of: [ = < > ~ ! @
//      that is NOT at position 0 (position-0 '@' is the npm scope prefix).
//   2. Truncate the name at that position.
//   3. Return the result, or '' if nothing is left after truncation.
//
// Examples:
//   'react@18'          → 'react'
//   'lodash==4.0.0'     → 'lodash'    (pip double-equals)
//   'requests>=2.0'     → 'requests'
//   'pkg[extra]'        → 'pkg'
//   'pkg~=1.0'          → 'pkg'
//   '@org/pkg'          → '@org/pkg'  (leading @ kept)
//   '@org/pkg@2.0'      → '@org/pkg'  (inner @ after position 0 is split)
function stripVersion(name) {
  if (typeof name !== 'string') return ''
  // Walk from position 1 (never split at 0) and find the first delimiter.
  for (let i = 1; i < name.length; i++) {
    const ch = name[i]
    if (ch === '[' || ch === '=' || ch === '<' || ch === '>' ||
        ch === '~' || ch === '!' || ch === '@') {
      return name.slice(0, i)
    }
  }
  return name
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a walked bash result into registry-lookup records.
 *
 * @param {{ segments: Array<{ command: string, args: string[], redirects: any[], raw: string }>, exotic: boolean }} walked
 *   The return value of bash-walker.mjs walk(). When exotic is true, returns [].
 * @param {{ ecosystems: { npm?: boolean, pypi?: boolean, crates?: boolean } }} options
 *   ecosystems: per-ecosystem toggle map. A false value disables that ecosystem.
 *
 * @returns {Array<{ ecosystem: 'npm'|'pypi'|'crates', name: string, segment: object }>}
 */
export function parseInstallSegments(walked, { ecosystems } = {}) {
  // exotic: true means the tokenizer found heredoc / $(...) / unbalanced quotes.
  // All segments are empty and we cannot safely analyse the command.
  if (!walked || walked.exotic) return []

  const ecoMap = (ecosystems && typeof ecosystems === 'object') ? ecosystems : {}
  const results = []

  for (const segment of (walked.segments ?? [])) {
    const spec = INSTALL_SPECS.get(segment.command)
    if (!spec) continue  // not an install command

    // Check that the ecosystem is enabled (default: true when key absent).
    if (ecoMap[spec.ecosystem] === false) continue

    const args = segment.args ?? []

    // The first arg must be the install verb (e.g. 'install', 'add', 'i').
    // If missing, this is a bare invocation with no verb — skip.
    if (args.length === 0) continue
    const verb = args[0]
    if (!spec.verbs.has(verb)) continue

    // Collect positional package names from remaining args.
    // Skip flags. Also skip the VALUE of -r / --requirement / -c / --constraint
    // flags for pip (these take a file path, not a package name).
    const FILE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint'])
    let skipNext = false
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (skipNext) { skipNext = false; continue }
      if (isFlag(arg)) {
        if (FILE_FLAGS.has(arg)) skipNext = true
        continue
      }
      // Positional arg — strip version specifier and extras.
      const name = stripVersion(arg)
      if (!name) continue  // stripped to empty — defensive guard
      results.push({ ecosystem: spec.ecosystem, name, segment })
    }
  }

  return results
}
