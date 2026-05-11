// Config loader for Sentinel — merges shipped defaults with user and project overrides.
// Three layers, lowest to highest precedence:
//   1. config/defaults.json  (shipped with the plugin)
//   2. ~/.claude/sentinel.json  (user-level overrides)
//   3. <cwd>/.claude/sentinel.json  (project-level overrides)
// Missing files and malformed JSON are silent no-ops (fail-open).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve shipped defaults relative to this module so the path is stable
// regardless of the caller's cwd.
const DEFAULTS_PATH = join(__dirname, '..', '..', 'config', 'defaults.json')

// Deep-merge source onto target.
// Plain objects are merged recursively; arrays, scalars, and null
// replace the target value entirely.  Unknown keys are preserved at
// every level for forward-compat.
function deepMerge(target, source) {
  const out = Object.assign({}, target)
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = out[key]
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      out[key] = deepMerge(tv, sv)
    } else {
      out[key] = sv
    }
  }
  return out
}

// Load a single JSON layer from disk.
// Returns {} on any error (missing file, bad permissions, malformed JSON)
// so the caller can always merge without guarding.
function loadLayer(filepath) {
  let raw = ''
  try { raw = readFileSync(filepath, 'utf8') } catch { return {} }
  let parsed = {}
  try { parsed = JSON.parse(raw) } catch { return {} }
  return parsed
}

// Load and merge all three config layers.
// home and cwd can be injected for testing; production callers omit both.
export function loadConfig({ home, cwd } = {}) {
  const homeDir = home || homedir()
  const cwdDir = cwd || process.cwd()

  const defaults = loadLayer(DEFAULTS_PATH)
  const user = loadLayer(join(homeDir, '.claude', 'sentinel.json'))
  const project = loadLayer(join(cwdDir, '.claude', 'sentinel.json'))

  return deepMerge(deepMerge(defaults, user), project)
}

// Replace every leaf value in obj with label.
// Plain objects are recursed into; arrays and scalars are opaque leaves.
// Returns a new object — does not mutate obj.
function tagLeaves(obj, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    // Scalar or array — this IS the leaf; replace with label.
    return label
  }
  const out = {}
  for (const key of Object.keys(obj)) {
    out[key] = tagLeaves(obj[key], label)
  }
  return out
}

// Load and merge all three config layers, returning both the merged value and
// a parallel "sources" object where every leaf is 'default' | 'user' | 'project'.
// value is guaranteed to deepEqual loadConfig({ home, cwd }) for the same inputs.
// home and cwd can be injected for testing; production callers omit both.
export function loadConfigWithSources({ home, cwd } = {}) {
  const homeDir = home || homedir()
  const cwdDir = cwd || process.cwd()

  const defaults = loadLayer(DEFAULTS_PATH)
  const user = loadLayer(join(homeDir, '.claude', 'sentinel.json'))
  const project = loadLayer(join(cwdDir, '.claude', 'sentinel.json'))

  const value = deepMerge(deepMerge(defaults, user), project)

  const tagDefaults = tagLeaves(defaults, 'default')
  const tagUser = tagLeaves(user, 'user')
  const tagProject = tagLeaves(project, 'project')
  const sources = deepMerge(deepMerge(tagDefaults, tagUser), tagProject)

  return { value, sources }
}
