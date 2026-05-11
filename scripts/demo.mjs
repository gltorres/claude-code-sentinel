#!/usr/bin/env node
// Sentinel demo driver — Sprint 10, Spec 02.
// Runs four scripted demo steps through the hook entry, capturing stdout/stderr.
// Usage:
//   node scripts/demo.mjs
//   node scripts/demo.mjs --write-transcript=demo/transcript.md
//
// Environment:
//   CLAUDE_PLUGIN_DATA  — set internally to <repoRoot>/demo/ for hermeticity
//
// Exit codes: 0 = all steps passed, 1 = one or more steps failed.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot   = join(__dirname, '..')
const HOOK       = join(repoRoot, 'src', 'sentinel', 'hook.mjs')
const REVIEW_CLI = join(repoRoot, 'src', 'sentinel', 'review-cli.mjs')
const demoDataDir = join(repoRoot, 'demo')
const auditPath   = join(demoDataDir, 'audit.jsonl')

// ── Argv parse (matches review-cli.mjs:7-10 hand-rolled pattern) ──────────────
// process.argv: ['node', 'scripts/demo.mjs', ...flags]
const transcriptFlag = process.argv.find(a => a.startsWith('--write-transcript='))
const transcriptPath = transcriptFlag ? transcriptFlag.slice('--write-transcript='.length) : null

// ── runStep({event, stdin, expect}) ──────────────────────────────────────────
// Spawns `node ${HOOK} <event>` with `stdin` piped in.
// Parses the stdout JSON envelope; compares every key in `expect` against
// the corresponding field in hookSpecificOutput (or the envelope itself for
// PostToolUse additionalContext checks).
// Returns { ok: boolean, actual: object, stdout: string, stderr: string }.
function runStep({ event, stdin, expect, extraEnv = {} }) {
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: demoDataDir,
      ...extraEnv,
    },
  })

  let envelope = {}
  try { envelope = JSON.parse(result.stdout.trim()) } catch { /* fail-open */ }

  const hso = envelope.hookSpecificOutput ?? {}

  // Flatten the fields the driver cares about into one comparison object.
  // For PreToolUse: permissionDecision and permissionDecisionReason live in hso.
  // For PostToolUse: additionalContext lives in hso.
  // Custom expect keys beginning with 'additionalContext_includes' do a substring match.
  let ok = true
  const mismatches = []

  for (const [key, expectedValue] of Object.entries(expect)) {
    if (key.endsWith('_includes')) {
      // Substring match: e.g. additionalContext_includes -> check hso.additionalContext
      const field = key.slice(0, -'_includes'.length)
      const actual = hso[field] ?? ''
      if (!actual.includes(expectedValue)) {
        ok = false
        mismatches.push(`  ${key}: expected to find "${expectedValue}" in "${actual}"`)
      }
    } else {
      const actual = hso[key] ?? envelope[key]
      if (actual !== expectedValue) {
        ok = false
        mismatches.push(`  ${key}: expected "${expectedValue}", got "${actual}"`)
      }
    }
  }

  return { ok, mismatches, envelope, stdout: result.stdout, stderr: result.stderr }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
mkdirSync(demoDataDir, { recursive: true })
// Clear stale audit log so line-count assertions in step 4 and tests are deterministic.
if (existsSync(auditPath)) {
  try { unlinkSync(auditPath) } catch { /* fail-open */ }
}

// ── Run steps (populated in Phase 2) ─────────────────────────────────────────
const failures = []
const steps = []

// ── Step 1: cat .env → deny (bash.cat) ────────────────────────────────────────
{
  process.stdout.write('Step 1: PreToolUse Bash "cat .env" → expect deny (bash.cat)\n')
  const s1 = runStep({
    event: 'PreToolUse',
    stdin: {
      hook_event_name: 'PreToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_input: { command: 'cat .env' },
    },
    expect: {
      permissionDecision: 'deny',
    },
  })
  if (s1.ok) {
    process.stdout.write(`  PASS  decision=deny  stderr=${s1.stderr.trim()}\n`)
  } else {
    process.stdout.write(`  FAIL\n${s1.mismatches.join('\n')}\n`)
    failures.push('Step 1')
  }
  steps.push({
    label: 'Step 1 — paths: cat .env → deny',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_input: { command: 'cat .env' },
    }, null, 2),
    output: (s1.stdout ?? '') + (s1.stderr ?? ''),
  })
}

// ── Step 2: pip install huggingface-cli-utils → ask (registry.too_new) ────────
{
  process.stdout.write('Step 2: PreToolUse Bash "pip install huggingface-cli-utils" → expect ask (registry.too_new)\n')

  // Write a hermetic stub fixture so the demo needs no network access.
  // The body uses upload_time_iso_8601 3 days ago to trigger the ageDays<14 branch.
  const stubFixture = {
    'https://pypi.org/pypi/huggingface-cli-utils/': {
      status: 200,
      body: {
        info: {
          name: 'huggingface-cli-utils',
          home_page: 'https://huggingface.co',
          project_urls: { Source: 'https://github.com/example/huggingface-cli-utils' },
        },
        urls: [
          { upload_time_iso_8601: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
        ],
        last_serial: 1,
      },
    },
  }
  const stubPath = join(demoDataDir, 'demo-stub-fetch.json')
  writeFileSync(stubPath, JSON.stringify(stubFixture))

  const s2 = runStep({
    event: 'PreToolUse',
    stdin: {
      hook_event_name: 'PreToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_input: { command: 'pip install huggingface-cli-utils' },
    },
    expect: {
      permissionDecision: 'ask',
    },
    extraEnv: {
      SENTINEL_TEST_FETCH_FIXTURES: stubPath,
    },
  })
  if (s2.ok) {
    process.stdout.write(`  PASS  decision=ask  stderr=${s2.stderr.trim()}\n`)
  } else {
    process.stdout.write(`  FAIL\n${s2.mismatches.join('\n')}\n`)
    failures.push('Step 2')
  }
  steps.push({
    label: 'Step 2 — registry: pip install <package> → ask',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_input: { command: 'pip install huggingface-cli-utils' },
    }, null, 2),
    output: (s2.stdout ?? '') + (s2.stderr ?? ''),
  })
}

// ── Step 3: PostToolUse with sk-ant-api03-… → scrub ───────────────────────────
{
  process.stdout.write('Step 3: PostToolUse Bash tool_response contains sk-ant-api03-… → expect short banner naming anthropic\n')
  const s3 = runStep({
    event: 'PostToolUse',
    stdin: {
      hook_event_name: 'PostToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_response: { stdout: 'Running deployment... API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done.', stderr: '' },
    },
    expect: {
      additionalContext_includes: 'anthropic',
    },
  })
  if (s3.ok) {
    process.stdout.write(`  PASS  additionalContext banner names anthropic family\n`)
  } else {
    process.stdout.write(`  FAIL\n${s3.mismatches.join('\n')}\n`)
    failures.push('Step 3')
  }

  // Honest-limitation footer — required by AC 1 (research doc §3.4, §4.4).
  // Wording derived from README.md:22.
  process.stdout.write(
    '\n  NOTE: PostToolUse scrubbing is a next-turn backstop only. The raw value ' +
    "'sk-ant-api03-...' reached the model's context window this turn. " +
    'additionalContext blocks re-quoting in subsequent turns — it does not erase ' +
    "what the model already received. For true in-turn prevention, rely on " +
    'PreToolUse path-deny and bash-exfil-deny rules.\n\n'
  )
  steps.push({
    label: 'Step 3 — scrubber: sk-ant-… in tool_response → redact',
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'demo-session-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_response: { stdout: 'Running deployment... API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done.', stderr: '' },
    }, null, 2),
    output: (s3.stdout ?? '') + (s3.stderr ?? ''),
  })
}

// ── Step 4: review-cli recent 3 → assert 3 audit lines ────────────────────────
{
  process.stdout.write('Step 4: node review-cli.mjs recent 3 → expect 3 audit lines (steps 1–3)\n')
  const s4 = spawnSync(process.execPath, [REVIEW_CLI, 'recent', '3'], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: demoDataDir,
    },
  })

  const lines = (s4.stdout ?? '').split('\n').filter(Boolean)
  const ok = s4.status === 0 && lines.length === 3
  if (ok) {
    process.stdout.write(`  PASS  3 audit lines found\n`)
    for (const line of lines) {
      process.stdout.write(`    ${line}\n`)
    }
  } else {
    process.stdout.write(
      `  FAIL  exit=${s4.status} lines=${lines.length} (expected 3)\n` +
      `        stderr: ${(s4.stderr ?? '').trim()}\n`
    )
    failures.push('Step 4')
  }
  steps.push({
    label: 'Step 4 — review: /sentinel-review recent 3',
    input: `node src/sentinel/review-cli.mjs recent 3`,
    output: s4.stdout ?? '',
  })
}

// ── Exit ──────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  process.stderr.write(`\nDemo FAILED — ${failures.length} step(s) did not match expectations.\n`)
  process.exit(1)
}
process.stdout.write('\nDemo PASSED — all steps matched expectations.\n')

// ── Transcript ────────────────────────────────────────────────────────────────
if (transcriptPath) {
  writeTranscript({ path: transcriptPath, steps })
}

// ── writeTranscript ───────────────────────────────────────────────────────────
function writeTranscript({ path: outPath, steps }) {
  try {
    const abs = resolve(outPath)
    const lines = []

    lines.push('# Sentinel Demo Transcript')
    lines.push('')
    lines.push('Generated by `make demo`. Each step drives `node src/sentinel/hook.mjs` directly')
    lines.push('with a synthetic event payload — no Claude API key or live session required.')
    lines.push('')

    for (const step of steps) {
      lines.push(`## ${step.label}`)
      lines.push('')
      lines.push('```text')
      lines.push(step.input.trimEnd())
      lines.push('```')
      lines.push('')
      lines.push('```text')
      lines.push(step.output.trimEnd())
      lines.push('```')
      lines.push('')
    }

    lines.push('## Caveat — next-turn scrubber')
    lines.push('')
    lines.push('> **Output scrubber — next-turn backstop, not in-turn redaction.** By the time the')
    lines.push('> `PostToolUse` hook runs, the raw tool result has already been delivered to the model\'s')
    lines.push('> context window and written to the on-disk JSONL transcript. The `additionalContext`')
    lines.push('> field is *additive*: it injects extra text into the model\'s next turn; it does not')
    lines.push('> replace, mutate, or erase the tool result the model already received. The scrubber')
    lines.push('> therefore stops a leaked credential from being *re-quoted, summarised, or memorised*')
    lines.push('> across subsequent turns — it does not stop the raw value from reaching the model in')
    lines.push('> this turn. For true in-turn prevention, rely on the `PreToolUse` path-deny rules')
    lines.push('> (Sprint 03) and bash-exfil-deny rules (Sprint 04), which block the tool call before')
    lines.push('> the result is ever produced.')
    lines.push('')

    writeFileSync(abs, lines.join('\n'), 'utf8')
  } catch (err) {
    process.stderr.write(`demo: warning: could not write transcript to ${outPath}: ${err.message}\n`)
  }
}
