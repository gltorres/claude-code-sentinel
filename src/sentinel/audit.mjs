// Sentinel audit writer — Sprint 02, Spec 3.
// Appends one JSONL line per hook event to a size-capped rotating log file.
// Never throws — all I/O errors are silently swallowed (fail-open contract).
import { statSync, renameSync, mkdirSync, appendFileSync, openSync, readSync, closeSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { ulid } from './ulid.mjs'

// Sidecar pointer file at the fallback root that records the most-recent
// resolved audit path. Readers in a different env (no CLAUDE_PLUGIN_DATA,
// e.g. the /sentinel-review CLI launched via the Bash tool) consult this
// file to discover where the hook is currently writing. The pointer lives
// at a stable, env-independent location so it is always reachable.
//
// SENTINEL_HOME mirrors the override that loadConfigWithSources / review-cli
// honour; tests use it to redirect homedir() without monkey-patching.
function auditPointerPath() {
  const home = process.env.SENTINEL_HOME || homedir()
  return join(home, '.claude', 'sentinel', '.audit-path')
}

const AUDIT_POINTER_PATH = auditPointerPath()

function persistAuditPointer(resolvedPath) {
  try {
    const pointerPath = auditPointerPath()
    // Idempotence: skip the write if the pointer already matches the
    // resolved path. Keeps the hot path to a single readFileSync call
    // (a few bytes) on the common case where the path is stable.
    try {
      if (readFileSync(pointerPath, 'utf8').trim() === resolvedPath) return
    } catch {}
    const dir = dirname(pointerPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(pointerPath, resolvedPath + '\n')
  } catch {
    // Fail-open: a pointer-write failure must never break the primary
    // audit-write path. Worst case the reader falls back to its own
    // resolveAuditPath result, which is the pre-fix behaviour.
  }
}

// Resolve the absolute audit file path from config, env, or fallback.
// Priority: config.audit.path > CLAUDE_PLUGIN_DATA env var > ~/.claude/sentinel/audit.jsonl
export function resolveAuditPath(config) {
  const configured = config?.audit?.path
  if (configured) {
    // Expand leading ~ to the OS home directory
    return configured.startsWith('~')
      ? join(homedir(), configured.slice(1))
      : configured
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return join(process.env.CLAUDE_PLUGIN_DATA, 'audit.jsonl')
  }
  // PRD §10 fallback path — used in dev / offline runs.
  // Honour SENTINEL_HOME so tests (and any caller that redirects home for
  // process isolation) keep their writes inside their own territory; this
  // mirrors the SENTINEL_HOME contract loadConfigWithSources / review-cli use.
  const home = process.env.SENTINEL_HOME || homedir()
  return join(home, '.claude', 'sentinel', 'audit.jsonl')
}

// Build a tool-specific input summary that never echoes raw tool_input or tool_response.
// Each branch returns the minimum data needed to reconstruct what happened.
export function summariseInput(hookEvent, tool, eventJson, decisionCtx = {}) {
  if (hookEvent === 'PostToolUse' && eventJson.scrub_family != null) {
    // PostToolUse scrub events: log what family was redacted and how many times
    return {
      family: eventJson.scrub_family ?? null,
      count: eventJson.scrub_count ?? 0,
    }
  }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Grep' || tool === 'Glob') {
    return {
      path: eventJson.tool_input?.file_path ?? eventJson.tool_input?.notebook_path ?? eventJson.tool_input?.path ?? null,
      glob: eventJson.tool_input?.pattern ?? null,
    }
  }
  if (tool === 'NotebookEdit') {
    return {
      path: eventJson.tool_input?.notebook_path ?? eventJson.tool_input?.file_path ?? null,
    }
  }
  if (tool === 'Bash') {
    // Truncate at 80 chars, then scrub sk-ant-* tokens so secrets never reach the log
    const raw = String(eventJson.tool_input?.command ?? '').slice(0, 80)
    const scrubbed = raw.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    return {
      command_prefix: scrubbed,
      matched_segment: decisionCtx?.matched_segment ?? null,
    }
  }
  return {}
}

// Append one JSON audit line to the resolved path.
// Rotates to <path>.1 (overwriting prior rotation) when the pre-append size
// exceeds config.audit.maxSizeMb * 1024 * 1024.
// Any error at any step is silently swallowed — the hook must not crash.
export function writeAuditLine(
  config,
  hookEvent,
  eventJson,
  decision = { event: 'warn', decision: 'allow', rule: null, matched: null },
) {
  try {
    const path = resolveAuditPath(config)
    persistAuditPointer(path)
    const maxSizeMb = config?.audit?.maxSizeMb ?? 10
    const tool = eventJson.tool_name ?? null
    const record = {
      id: ulid(),
      ts: new Date().toISOString(),
      session_id: eventJson.session_id ?? '',
      cwd: eventJson.cwd ?? process.cwd(),
      event: decision.event ?? 'warn',
      hook: hookEvent,
      tool,
      rule: decision.rule ?? null,
      matched: decision.matched ?? null,
      input_summary: summariseInput(hookEvent, tool, eventJson, decision),
      decision: decision.decision ?? 'allow',
      metadata: {},
    }

    // Check current size and rotate before appending if over the cap
    let currentSize = 0
    try { currentSize = statSync(path).size } catch { currentSize = 0 }
    if (currentSize > maxSizeMb * 1024 * 1024) {
      // Single-level rotation — overwrite any prior .1 file
      renameSync(path, path + '.1')
    }

    // Ensure parent directory exists, then append the serialised record
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n')
  } catch {}
}

// Private helper — resolves the ordered list of audit file paths to scan.
// Returns [primary] when the rotated file does not exist, or
// [primary, primary + '.1'] when both exist.
// When callers supply an explicit `paths` array it is used as-is; this
// helper is only invoked when `paths` is undefined.
function listAuditPaths(config) {
  const primary = resolveAuditPath(config)
  const candidates = new Set([primary, primary + '.1'])

  // Discover the writer's actual path via the sidecar pointer when our
  // env differs from the writer's env (e.g. CLI launched via the Bash
  // tool has no CLAUDE_PLUGIN_DATA). Stale pointers are filtered out by
  // the existsSync gate below, so there is no failure mode to clean up.
  try {
    const pointer = readFileSync(auditPointerPath(), 'utf8').trim()
    if (pointer && pointer !== primary) {
      candidates.add(pointer)
      candidates.add(pointer + '.1')
    }
  } catch {}

  return [...candidates].filter(existsSync)
}

const TAIL_CHUNK_SIZE = 8 * 1024 // 8 KiB, same as session.mjs

// Return the most-recent `n` audit records, newest-first, by reverse-chunk scan.
//
// Parameters:
//   config  {object}   — merged Sentinel config (as returned by loadConfig)
//   n       {number}   — maximum number of records to return (default 20)
//   paths   {string[]} — explicit list of file paths to scan, newest first.
//                        When omitted, defaults to [primary, primary+'.1'] filtered
//                        to existing files via listAuditPaths(config).
//
// Returns: Array of parsed record objects, newest first. Empty array on any
//          I/O error or when no matching records exist.
//
// Fail-open: errors from individual files are silently skipped.
export function tailAuditEntries({ config, n = 20, paths } = {}) {
  const filePaths = paths ?? listAuditPaths(config)
  // Each file is reverse-scanned and capped at n records. After all files
  // are processed we merge globally by `record.ts` descending so multi-file
  // listings (primary + rotated + pointer-discovered) interleave correctly
  // in time order — string compare on ISO-8601 with `Z` suffix is correct.
  const perFile = []

  for (const filePath of filePaths) {
    const fileResults = []

    let size
    try { size = statSync(filePath).size } catch { perFile.push(fileResults); continue }
    if (size === 0) { perFile.push(fileResults); continue }

    let fd
    try {
      fd = openSync(filePath, 'r')
      const buf = Buffer.allocUnsafe(TAIL_CHUNK_SIZE)
      let remaining = size
      // carry holds an incomplete line fragment from the right edge of the
      // previous (more-rightward) chunk — same pattern as session.mjs:39
      let carry = ''

      while (remaining > 0 && fileResults.length < n) {
        const readSize = Math.min(TAIL_CHUNK_SIZE, remaining)
        const offset = remaining - readSize
        const bytesRead = readSync(fd, buf, 0, readSize, offset)
        remaining -= bytesRead

        // Prepend chunk text to carry so carry stays at the right boundary
        const chunkText = buf.toString('utf8', 0, bytesRead)
        const combined = chunkText + carry

        // Split into lines; leftmost may be incomplete — save as new carry
        const lines = combined.split('\n')
        carry = lines.shift() // leftmost (potentially partial) line

        // Process lines right-to-left (newest first within the chunk)
        for (let i = lines.length - 1; i >= 0 && fileResults.length < n; i--) {
          const line = lines[i].trim()
          if (!line) continue
          let record
          try { record = JSON.parse(line) } catch { continue }
          if (!record || typeof record.id !== 'string') continue
          fileResults.push(record)
        }
      }

      // Process any remaining carry (the very first line of the file)
      if (fileResults.length < n && carry.trim()) {
        let record
        try { record = JSON.parse(carry.trim()) } catch { record = null }
        if (record && typeof record.id === 'string') {
          fileResults.push(record)
        }
      }
    } catch {
      // I/O error on this file — skip it, try next
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
      }
    }

    perFile.push(fileResults)
  }

  // Global merge: sort by ts descending (newest first). Records lacking a
  // string ts sort last to preserve fail-open behaviour.
  const merged = perFile.flat().sort((a, b) => {
    const ta = typeof a.ts === 'string' ? a.ts : ''
    const tb = typeof b.ts === 'string' ? b.ts : ''
    return ta < tb ? 1 : ta > tb ? -1 : 0
  })
  return merged.slice(0, n)
}

// Return the single audit record whose `id` field equals the given 26-char
// Crockford ULID, or null if no match is found.
//
// Parameters:
//   config  {object}   — merged Sentinel config
//   id      {string}   — 26-char Crockford ULID to locate
//   paths   {string[]} — explicit list of file paths to scan.
//                        When omitted, defaults to listAuditPaths(config).
//
// Returns: Parsed record object on match, or null.
// Fail-open: missing files are skipped; malformed lines are skipped.
export function findAuditEntryById({ config, id, paths } = {}) {
  const filePaths = paths ?? listAuditPaths(config)

  for (const filePath of filePaths) {
    let raw
    try { raw = readFileSync(filePath, 'utf8') } catch { continue }
    const lines = raw.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (record && record.id === id) return record
    }
  }

  return null
}

const SUMMARY_EVENTS = new Set(['block', 'ask', 'scrub', 'warn'])

// Return event-class counts for all records whose ts Date.parse >= sinceMs.
//
// Parameters:
//   config   {object}   — merged Sentinel config
//   sinceMs  {number}   — lower bound epoch ms (inclusive). Use Date.now() - 7*24*60*60*1000
//                         for a 7-day window.
//   paths    {string[]} — explicit list of file paths to scan.
//                         When omitted, defaults to listAuditPaths(config).
//
// Returns: { block: number, ask: number, scrub: number, warn: number, total: number }
// Fail-open: missing files and malformed lines are silently skipped.
export function summariseByEventClass({ config, sinceMs = 0, paths } = {}) {
  const counts = { block: 0, ask: 0, scrub: 0, warn: 0 }
  const filePaths = paths ?? listAuditPaths(config)

  for (const filePath of filePaths) {
    let raw
    try { raw = readFileSync(filePath, 'utf8') } catch { continue }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (!record || typeof record.ts !== 'string') continue
      const ts = Date.parse(record.ts)
      if (Number.isNaN(ts) || ts < sinceMs) continue
      if (SUMMARY_EVENTS.has(record.event)) {
        counts[record.event] = (counts[record.event] ?? 0) + 1
      }
    }
  }

  const total = counts.block + counts.ask + counts.scrub + counts.warn
  return { ...counts, total }
}
