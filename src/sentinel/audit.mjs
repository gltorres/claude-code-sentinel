// Sentinel audit writer — Sprint 02, Spec 3.
// Appends one JSONL line per hook event to a size-capped rotating log file.
// Never throws — all I/O errors are silently swallowed (fail-open contract).
import { statSync, renameSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { ulid } from './ulid.mjs'

// Resolve the absolute audit file path from config, env, or fallback.
// Priority: config.audit.path > CLAUDE_PLUGIN_DATA env var > ~/.claude/sentinel/audit.jsonl
function resolveAuditPath(config) {
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
  // PRD §10 fallback path — used in dev / offline runs
  return join(homedir(), '.claude', 'sentinel', 'audit.jsonl')
}

// Build a tool-specific input summary that never echoes raw tool_input or tool_response.
// Each branch returns the minimum data needed to reconstruct what happened.
export function summariseInput(hookEvent, tool, eventJson, decisionCtx = {}) {
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
  if (hookEvent === 'PostToolUse' && eventJson.scrub_family != null) {
    // PostToolUse scrub events: log what family was redacted and how many times
    return {
      family: eventJson.scrub_family ?? null,
      count: eventJson.scrub_count ?? 0,
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
