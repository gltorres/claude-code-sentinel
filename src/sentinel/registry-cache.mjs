// Registry cache — Sprint 05, Spec 04.
// Sync read/write of ${CLAUDE_PLUGIN_DATA}/cache.json with TTL and size-cap eviction.
// Never throws — all I/O errors are silently swallowed (fail-open contract).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Expand a leading ~ to the OS home directory, honoring the provided env.
function expandTilde(p, env) {
  if (!p.startsWith('~')) return p
  const home = env.HOME ?? homedir()
  return join(home, p.slice(1))
}

// Resolve the absolute path for the cache file from env, or fallback.
// Mirrors the audit.mjs:11-24 path resolution for CLAUDE_PLUGIN_DATA.
// Priority: CLAUDE_PLUGIN_DATA env var > ~/.claude/sentinel/cache.json
export function resolveCachePath(env = process.env) {
  const dataDir = env.CLAUDE_PLUGIN_DATA
    ? expandTilde(env.CLAUDE_PLUGIN_DATA, env)
    : join(homedir(), '.claude', 'sentinel')
  return join(dataDir, 'cache.json')
}

// Load the cache from disk and return it as a plain object.
// Returns {} on missing file, corrupt JSON, or any I/O error (fail-open).
export function loadCache(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    // Guard against a file whose top-level value is not an object
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

// Return the cached entry if it exists and has not exceeded ttlMs.
// Returns undefined on miss or TTL expiry.
export function getCached(cache, key, ttlMs, now) {
  const entry = cache[key]
  if (!entry) return undefined
  // Expired entries are treated as a miss so callers re-fetch
  if (now - entry.ts >= ttlMs) return undefined
  return entry
}

// Mutate cache in place: store value at key with ts = now.
// Value shape: { decision, reason, rule } — ts is added here.
export function setCached(cache, key, value, now) {
  cache[key] = { ts: now, ...value }
}

// Trim oldest entries (by ts) when count > maxEntries, then write to disk.
// Creates parent directories as needed. Swallows all errors (fail-open).
export function flushCache(path, cache, maxEntries) {
  try {
    // Evict oldest entries when the cache is over the size cap
    const keys = Object.keys(cache)
    if (keys.length > maxEntries) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts)
      const excess = keys.length - maxEntries
      for (let i = 0; i < excess; i++) {
        delete cache[keys[i]]
      }
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache))
  } catch {}
}
