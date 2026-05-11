#!/usr/bin/env node
// Sentinel — single ESM hook entry. Static imports only.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { writeAuditLine } from './audit.mjs'
import { matchPath } from './paths.mjs'
import { evaluateBash } from './bash-policy.mjs'
import { evaluateRegistry } from './registry-policy.mjs'
import { resolveCachePath, loadCache, flushCache } from './registry-cache.mjs'
import { scrubResponse } from './scrubber-policy.mjs'
import { summariseAuditWindow, composeBanner } from './session.mjs'

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

export async function runBashBranch({ command, cwd, home, config, fetchFn, now, cache, emit: emitFn, envelope: envelopeFn }) {
  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s ?? ''))

  let bashResult
  try {
    bashResult = evaluateBash({ command, cwd, home, config })
  } catch {
    bashResult = { decision: 'allow', rule: null, matched: null, matched_segment: null }
  }

  if (bashResult.decision === 'deny') {
    const seg = truncate(bashResult.matched_segment, 40)
    const reason =
      BANNER_PREFIX +
      `bash segment '${seg}' reads ${bashResult.matched} (${bashResult.rule})`
    return emitFn(
      envelopeFn('PreToolUse', {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }),
      {
        event: 'block',
        decision: 'deny',
        rule: bashResult.rule,
        matched: bashResult.matched,
        matched_segment: bashResult.matched_segment,
      },
    )
  }

  if (bashResult.decision === 'ask') {
    const reason =
      BANNER_PREFIX + 'bash shape not statically analysable; confirm before running'
    return emitFn(
      envelopeFn('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      }),
      {
        event: 'ask',
        decision: 'ask',
        rule: bashResult.rule || 'bash.exotic',
        matched: null,
        matched_segment: null,
      },
    )
  }

  // bashResult.decision === 'allow' — proceed to registry check
  let reg
  try {
    reg = await evaluateRegistry({ command, config, fetchFn, cache, now })
  } catch {
    reg = { decision: 'allow', rule: 'registry.unavailable', matched: null, matched_segment: null, reason: 'registry check failed; allowing fail-open' }
  }

  flushCache(resolveCachePath(process.env), cache, (config?.registry?.cacheMaxEntries) ?? 1024)

  if (reg.decision === 'deny') {
    return emitFn(
      envelopeFn('PreToolUse', {
        permissionDecision: 'deny',
        permissionDecisionReason: BANNER_PREFIX + reg.reason,
      }),
      {
        event: 'block',
        decision: 'deny',
        rule: reg.rule,
        matched: reg.matched,
        matched_segment: reg.matched_segment,
      },
    )
  }

  if (reg.decision === 'ask') {
    return emitFn(
      envelopeFn('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: BANNER_PREFIX + reg.reason,
      }),
      {
        event: 'ask',
        decision: 'ask',
        rule: reg.rule,
        matched: reg.matched,
        matched_segment: reg.matched_segment,
      },
    )
  }

  // reg.decision === 'allow'
  if (reg.rule === 'registry.unavailable') {
    return emitFn(
      envelopeFn('PreToolUse', { permissionDecision: 'allow' }),
      {
        event: 'warn',
        decision: 'allow',
        rule: 'registry.unavailable',
        matched: null,
        matched_segment: null,
      },
    )
  }

  // Silent allow — widely-used package, clean registry check
  return emitFn(
    envelopeFn('PreToolUse', { permissionDecision: 'allow' }),
    undefined,
  )
}

// --self-test branch: load fixtures, run matchPath in-process, report timing
if (process.argv.includes('--self-test')) {
  (async () => {
    // Inline stub lookup: first stubFetch key that is a prefix of url wins.
    function lookupStub(stubFetch, url) {
      for (const prefix of Object.keys(stubFetch)) {
        if (url.startsWith(prefix)) return stubFetch[prefix]
      }
      return undefined
    }

    const fixtureDirs = ['paths', 'bash', 'registry', 'scrubber', 'session']
    const selfTestConfig = loadConfig()
    let failures = 0
    let count = 0
    const t0 = performance.now()
    for (const bucket of fixtureDirs) {
      const fixturesDir = new URL(`../../tests/fixtures/${bucket}`, import.meta.url).pathname
      const files = readdirSync(fixturesDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        const raw = readFileSync(fixturesDir + '/' + file, 'utf8')
        const fixture = JSON.parse(raw)
        const { event: fixtureEvent, expect: fixtureExpect } = fixture
        const toolName = fixtureEvent.tool_name
        let actual
        if (bucket === 'paths') {
          let filePath
          if (toolName === 'Glob') {
            filePath = fixtureEvent.tool_input.pattern
          } else if (toolName === 'NotebookEdit') {
            filePath = fixtureEvent.tool_input.notebook_path ?? fixtureEvent.tool_input.file_path
          } else {
            filePath = fixtureEvent.tool_input.file_path
          }
          actual = matchPath({
            filePath,
            cwd: fixtureEvent.cwd,
            home: homedir(),
            config: selfTestConfig,
          })
        } else if (bucket === 'bash') {
          actual = evaluateBash({
            command: fixtureEvent.tool_input.command,
            cwd: fixtureEvent.cwd,
            home: homedir(),
            config: selfTestConfig,
          })
        } else if (bucket === 'registry') {
          // Build a fixture-driven fetchFn from fixture.stubFetch:
          //   stubFetch: { '<urlPrefix>': { status: 200|404|500, body?: <json>, throw?: 'abort'|'network' } }
          const fetchFn = async (url) => {
            const entry = lookupStub(fixture.stubFetch, url)
            if (!entry) return { ok: false, status: 500, async json() { return {} } }
            if (entry.throw === 'network') throw new Error('network')
            if (entry.throw === 'abort') {
              const e = new Error('abort')
              e.name = 'AbortError'
              throw e
            }
            return {
              ok: entry.status >= 200 && entry.status < 300,
              status: entry.status,
              async json() { return entry.body ?? {} },
            }
          }
          const cache = {}
          actual = await evaluateRegistry({
            command: fixtureEvent.tool_input.command,
            config: fixtureEvent.config ?? selfTestConfig,
            fetchFn,
            cache,
            now: fixture.now ?? Date.now(),
          })
        } else if (bucket === 'scrubber') {
          const text = String(fixtureEvent.tool_response ?? '')
          const fixtureConfig = fixture.config ?? selfTestConfig
          const result = scrubResponse({ text, config: fixtureConfig })
          // Map scrubResponse result to the shape the comparator expects.
          // rule: first family that fired (prefixed), or null if none.
          // decision: always 'allow' (PostToolUse is additive-only).
          // matched: always null (the matched value is the secret — never log it).
          const firstFamily = result.redactions.length > 0 ? result.redactions[0].family : null
          actual = {
            decision: result.decision,
            rule: firstFamily != null ? 'scrubber.' + firstFamily : null,
            matched: result.matched,
          }
        } else if (bucket === 'session') {
          // Materialise fixture.audit_lines into a temp audit.jsonl file.
          const tmpDir = mkdtempSync(tmpdir() + '/sentinel-selftest-')
          let banner = ''
          try {
            const auditPath = tmpDir + '/audit.jsonl'
            const lines = fixture.audit_lines ?? []
            writeFileSync(auditPath, lines.map(l => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8')
            // Build a minimal config that overrides the audit path.
            const fixtureConfig = {
              ...(fixture.config ?? selfTestConfig),
              audit: {
                ...((fixture.config ?? selfTestConfig).audit ?? {}),
                path: auditPath,
              },
            }
            const summary = summariseAuditWindow({ config: fixtureConfig, now: fixture.now ?? Date.now() })
            banner = composeBanner(summary)
          } finally {
            rmSync(tmpDir, { recursive: true, force: true })
          }
          actual = { banner }
        }
        const expectKeys = Object.keys(fixtureExpect)
        const pass = expectKeys.every(k => {
          if (k === 'banner_includes') {
            // Substring match: actual.banner must contain the expected string.
            return typeof actual.banner === 'string' && actual.banner.includes(fixtureExpect[k])
          }
          return (actual[k] ?? null) === (fixtureExpect[k] ?? null)
        })
        if (!pass) {
          process.stderr.write(
            BANNER_PREFIX + `self-test FAIL [${file}]: ` +
            `expected ${JSON.stringify(fixtureExpect)} got ${JSON.stringify(actual)}\n`
          )
          failures++
        }
        count++
      }
    }
    const elapsed = (performance.now() - t0).toFixed(1)
    if (failures > 0) {
      process.stderr.write(BANNER_PREFIX + `self-test failed (${failures} fixture(s))\n`)
      process.exit(1)
    }
    process.stderr.write(BANNER_PREFIX + `self-test ok (${count} fixtures, ${elapsed} ms total)\n`)
    process.exit(0)
  })()
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
await (async () => {
  switch (which) {
    case 'PreToolUse': {
      const tool = event.tool_name ?? ''
      const cwd = event.cwd ?? process.cwd()

      // Extract the path under test for the five protected tool types.
      let filePath = null
      if (tool === 'Read' || tool === 'Edit' || tool === 'Grep') {
        filePath = event.tool_input?.file_path ?? event.tool_input?.path ?? null
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
      } else if (tool === 'Bash') {
        const command = (event.tool_input && event.tool_input.command) || ''
        const cachePath = resolveCachePath(process.env)
        const cache = loadCache(cachePath)
        // Wire SENTINEL_TEST_FETCH_FIXTURES for hermetic E2E tests: load the fixture map
        // and replace globalThis.fetch with a stub that matches by URL prefix.
        let fetchFn = globalThis.fetch
        const fixtureFile = process.env.SENTINEL_TEST_FETCH_FIXTURES
        if (fixtureFile) {
          let stubMap
          try { stubMap = JSON.parse(readFileSync(fixtureFile, 'utf8')) } catch { stubMap = {} }
          fetchFn = async (url) => {
            let entry
            for (const prefix of Object.keys(stubMap)) {
              if (url.startsWith(prefix)) { entry = stubMap[prefix]; break }
            }
            if (!entry) return { ok: false, status: 500, async json() { return {} } }
            if (entry.throw) throw new Error('stub network error')
            return {
              ok: entry.status >= 200 && entry.status < 300,
              status: entry.status,
              async json() { return entry.body ?? {} },
            }
          }
        }
        await runBashBranch({
          command,
          cwd,
          home: homedir(),
          config,
          fetchFn,
          now: Date.now(),
          cache,
          emit,
          envelope,
        })
        return // async IIFE calls emit() which calls process.exit(0); this return is belt-and-suspenders
      } else {
        // Unrecognised tool names: scaffold-allow (unchanged from Sprint 02)
        emit(envelope('PreToolUse', {
          permissionDecision: 'allow',
          permissionDecisionReason: BANNER_PREFIX + 'scaffold no-op',
        }))
      }
      break
    }
    case 'PostToolUse': {
      try {
        if (config?.scrubber?.enabled === false) {
          process.stdout.write(JSON.stringify(envelope('PostToolUse', { additionalContext: '' })) + '\n')
          process.exit(0)
        }
        const text = String(event.tool_response ?? '')
        const result = scrubResponse({ text, config })
        for (const { family, count } of result.redactions) {
          try {
            writeAuditLine(
              config,
              'PostToolUse',
              { ...event, scrub_family: family, scrub_count: count },
              { event: 'scrub', decision: 'allow', rule: 'scrubber.' + family, matched: null },
            )
          } catch {}
        }
        process.stdout.write(JSON.stringify(envelope('PostToolUse', { additionalContext: result.redacted })) + '\n')
        process.exit(0)
      } catch {
        // Fail-open: scrubber crash must never block the tool turn
        process.stdout.write(JSON.stringify(envelope('PostToolUse', { additionalContext: '' })) + '\n')
        process.exit(0)
      }
    }
    case 'SessionStart': {
      let banner
      try {
        const summary = summariseAuditWindow({ config, now: Date.now() })
        banner = composeBanner(summary)
      } catch {
        banner = 'Sentinel active — no events yet. PostToolUse scrubbing is next-turn-only; PreToolUse is the primary defence.'
      }
      emit(envelope('SessionStart', { additionalContext: banner }))
      break
    }
    case 'SessionEnd':
      emit(
        envelope('SessionEnd', { additionalContext: '' }),
        { event: 'warn', decision: 'allow', rule: 'session.end', matched: null },
      )
      break
    case '--self-test':
      // Handled by the top-level async self-test IIFE above; do nothing here.
      break
    default:
      emit(envelope('PreToolUse', {
        permissionDecision: 'allow',
        permissionDecisionReason: BANNER_PREFIX + `unknown event ${which || '<none>'}; allowing fail-open`,
      }))
  }
})()
}
