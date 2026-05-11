// Path matcher for Sentinel — consults config.paths.allow / config.paths.deny.
// Sprint 03.
import { matchGlob } from './glob.mjs'
import { resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

// Expand a leading ~ to the user's home directory.
// Leaves all other paths untouched.
function expandTilde(filePath, home) {
  if (filePath === '~') return home
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return home + filePath.slice(1)
  }
  return filePath
}

// Resolve filePath to an absolute path.
// 1. Expand ~ against home.
// 2. If still relative, resolve against cwd.
function resolvePath(filePath, cwd, home) {
  const expanded = expandTilde(filePath, home)
  if (isAbsolute(expanded)) return expanded
  return resolve(cwd, expanded)
}

// Match a resolved absolute path against an array of glob patterns.
// Returns the first matching pattern string, or null if none match.
function firstMatch(patterns, absolutePath) {
  for (const pattern of patterns) {
    if (matchGlob(pattern, absolutePath)) return pattern
  }
  return null
}

// Evaluate whether filePath should be allowed or denied according to config.
//
// Resolution order:
//   1. Expand ~ and resolve relative paths to absolute.
//   2. Check config.paths.allow — return allow on first hit (allow beats deny).
//   3. Check config.paths.deny  — return deny  on first hit.
//   4. Default: allow.
//
// Returns:
//   { decision: 'allow' }                                    — default or allow-list hit
//   { decision: 'allow', rule: 'paths.allow', matched: str } — allow-list hit
//   { decision: 'deny',  rule: 'paths.deny',  matched: str } — deny-list hit
//
// Options:
//   filePath {string}  — raw path as provided by tool_input (may be relative or ~-prefixed)
//   cwd      {string}  — working directory for relative-path resolution (defaults to process.cwd())
//   home     {string}  — home directory for tilde expansion (defaults to os.homedir())
//   config   {object}  — merged Sentinel config object; must have a paths key
export function matchPath({ filePath, cwd, home, config } = {}) {
  const resolvedCwd = cwd || process.cwd()
  const resolvedHome = home || homedir()
  const paths = (config && config.paths) || {}
  const allowList = Array.isArray(paths.allow) ? paths.allow : []
  const denyList = Array.isArray(paths.deny) ? paths.deny : []

  const absolute = resolvePath(filePath, resolvedCwd, resolvedHome)

  const allowMatch = firstMatch(allowList, absolute)
  if (allowMatch !== null) {
    return { decision: 'allow', rule: 'paths.allow', matched: allowMatch }
  }

  const denyMatch = firstMatch(denyList, absolute)
  if (denyMatch !== null) {
    return { decision: 'deny', rule: 'paths.deny', matched: denyMatch }
  }

  return { decision: 'allow' }
}
