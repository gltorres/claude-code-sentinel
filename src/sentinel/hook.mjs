#!/usr/bin/env node
// Sentinel — single ESM hook entry. Static imports only.
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { loadConfig } from './config.mjs'
import { writeAuditLine } from './audit.mjs'
import { matchPath } from './paths.mjs'

const EVENT_NAMES = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']
const MIN_NODE = '20.10.0'
const BANNER_PREFIX = 'Sentinel: '

// EVENT_NAMES is defined here for Sprint 02+ audit writer import reuse.
void EVENT_NAMES

function compareSemver(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  return 0
}

function envelope(eventName, extra = {}) {
  return { hookSpecificOutput: { hookEventName: eventName, ...extra } }
}

function emit(obj, decisionCtx = {}) {
  // Write one audit line per hook decision; fail-open so audit never breaks the envelope
  try { writeAuditLine(config, which, event, decisionCtx) } catch {}
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(0)
}

// --self-test branch: load fixtures, run matchPath in-process, report timing
if (process.argv.includes('--self-test')) {
  const fixturesDir = new URL('../../../tests/fixtures/paths', import.meta.url).pathname
  const files = readdirSync(fixturesDir).filter(f => f.endsWith('.json'))
  const selfTestConfig = loadConfig()
  let failures = 0
  const t0 = performance.now()
  for (const file of files) {
    const raw = readFileSync(fixturesDir + '/' + file, 'utf8')
    const { event: fixtureEvent, expect: fixtureExpect } = JSON.parse(raw)
    const toolName = fixtureEvent.tool_name
    let filePath
    if (toolName === 'Glob') {
      filePath = fixtureEvent.tool_input.pattern
    } else if (toolName === 'NotebookEdit') {
      filePath = fixtureEvent.tool_input.notebook_path ?? fixtureEvent.tool_input.file_path
    } else {
      filePath = fixtureEvent.tool_input.file_path
    }
    const result = matchPath({
      filePath,
      cwd: fixtureEvent.cwd,
      home: homedir(),
      config: selfTestConfig,
    })
    const pass =
      result.decision === fixtureExpect.decision &&
      (result.rule ?? null) === (fixtureExpect.rule ?? null) &&
      (result.matched ?? null) === (fixtureExpect.matched ?? null)
    if (!pass) {
      process.stderr.write(
        BANNER_PREFIX + `self-test FAIL [${file}]: ` +
        `expected ${JSON.stringify(fixtureExpect)} got ${JSON.stringify(result)}\n`
      )
      failures++
    }
  }
  const elapsed = (performance.now() - t0).toFixed(1)
  if (failures > 0) {
    process.stderr.write(BANNER_PREFIX + `self-test failed (${failures} fixture(s))\n`)
    process.exit(1)
  }
  process.stderr.write(BANNER_PREFIX + `self-test ok (${files.length} fixtures, ${elapsed} ms total)\n`)
  process.exit(0)
}

// Node version preflight — fail-open with advisory if < MIN_NODE
const nodeVer = (process.versions.node || '0.0.0').split('-')[0]
if (compareSemver(nodeVer, MIN_NODE) < 0) {
  emit(envelope('PreToolUse', {
    permissionDecision: 'allow',
    permissionDecisionReason: BANNER_PREFIX + `requires Node >= ${MIN_NODE} (have ${nodeVer}); allowing fail-open`,
  }))
}

// Stdin buffer — synchronous read; events are tiny (well under a few KB).
// Fail-open on EAGAIN, empty pipe, or any read error.
let raw = ''
try { raw = readFileSync(0, 'utf8') } catch { raw = '' }

// JSON parse — fail-open on malformed input
let event = {}
if (raw.trim().length > 0) {
  try { event = JSON.parse(raw) } catch { event = {} }
}

// Sprint 02: load merged config (shipped defaults + user + project overlays)
// Pass event.cwd so the project-level sentinel.json is found correctly.
const config = loadConfig({ cwd: event.cwd })

const which = process.argv[2]

switch (which) {
  case 'PreToolUse': {
    const tool = event.tool_name ?? ''
    const cwd = event.cwd ?? process.cwd()

    // Extract the path under test for the five protected tool types.
    let filePath = null
    if (tool === 'Read' || tool === 'Edit' || tool === 'Grep') {
      filePath = event.tool_input?.file_path ?? null
    } else if (tool === 'NotebookEdit') {
      filePath = event.tool_input?.notebook_path ?? event.tool_input?.file_path ?? null
    } else if (tool === 'Glob') {
      // For Glob, the pattern itself is the path under test; resolve it against cwd.
      filePath = event.tool_input?.pattern ?? null
    }

    if (filePath !== null &&
        (tool === 'Read' || tool === 'Edit' || tool === 'Grep' ||
         tool === 'Glob' || tool === 'NotebookEdit')) {
      const result = matchPath({ filePath, cwd, home: homedir(), config })
      if (result.decision === 'deny') {
        const reason =
          BANNER_PREFIX + `read of ${result.matched} blocked by ${result.rule}`
        const decisionCtx = {
          event: 'block',
          decision: 'deny',
          rule: result.rule,
          matched: result.matched,
        }
        emit(
          envelope('PreToolUse', {
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          }),
          decisionCtx,
        )
      } else {
        emit(envelope('PreToolUse', {
          permissionDecision: 'allow',
          permissionDecisionReason: BANNER_PREFIX + 'path allowed',
        }))
      }
    } else {
      // Bash and unrecognised tool names: scaffold-allow (unchanged from Sprint 02)
      emit(envelope('PreToolUse', {
        permissionDecision: 'allow',
        permissionDecisionReason: BANNER_PREFIX + 'scaffold no-op',
      }))
    }
    break
  }
  case 'PostToolUse':
    emit(envelope('PostToolUse', { additionalContext: '' }))
    break
  case 'SessionStart':
    emit(envelope('SessionStart', { additionalContext: '' }))
    break
  case 'SessionEnd':
    emit(envelope('SessionEnd', { additionalContext: '' }))
    break
  default:
    emit(envelope('PreToolUse', {
      permissionDecision: 'allow',
      permissionDecisionReason: BANNER_PREFIX + `unknown event ${which || '<none>'}; allowing fail-open`,
    }))
}
