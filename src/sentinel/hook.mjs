#!/usr/bin/env node
// Sentinel — single ESM hook entry. Static imports only.
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { loadConfig } from './config.mjs'
import { writeAuditLine } from './audit.mjs'

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

function emit(obj) {
  // Write one audit line per hook decision; fail-open so audit never breaks the envelope
  try { writeAuditLine(config, which, event) } catch {}
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(0)
}

// --self-test branch: no-op, exit 0 (wired into `make validate` via Makefile)
if (process.argv.includes('--self-test')) {
  process.stderr.write(BANNER_PREFIX + 'self-test ok\n')
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
const config = loadConfig()

const which = process.argv[2]

switch (which) {
  case 'PreToolUse':
    emit(envelope('PreToolUse', {
      permissionDecision: 'allow',
      permissionDecisionReason: BANNER_PREFIX + 'scaffold no-op',
    }))
    break
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
