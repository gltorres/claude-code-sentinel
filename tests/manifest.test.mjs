import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

const manifest = JSON.parse(readFileSync(resolve(REPO, '.claude-plugin/plugin.json'), 'utf8'))
const hooks = JSON.parse(readFileSync(resolve(REPO, 'hooks/hooks.json'), 'utf8'))

test('plugin.json has required minimal fields', () => {
  assert.equal(manifest.name, 'sentinel')
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.author && typeof manifest.author === 'object')
})

test('plugin.json has no forbidden fields (no version, no hooks block here)', () => {
  assert.equal(manifest.version, undefined)
  assert.equal(manifest.hooks, undefined)
  assert.equal(manifest.commands, undefined)
})

test('hooks/hooks.json registers all four event names', () => {
  const events = Object.keys(hooks.hooks)
  for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
    assert.ok(events.includes(ev), `missing event: ${ev}`)
  }
})

test('every hook entry has timeout:5 and CLAUDE_PLUGIN_ROOT command', () => {
  for (const [eventName, matchers] of Object.entries(hooks.hooks)) {
    for (const m of matchers) {
      for (const h of m.hooks) {
        assert.equal(h.type, 'command', `${eventName} hook type`)
        assert.equal(h.timeout, 5, `${eventName} timeout`)
        assert.ok(
          h.command.includes('${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs'),
          `${eventName} command must reference CLAUDE_PLUGIN_ROOT and hook.mjs`,
        )
      }
    }
  }
})

test('SessionStart and SessionEnd hooks declare async:true', () => {
  for (const ev of ['SessionStart', 'SessionEnd']) {
    for (const m of hooks.hooks[ev]) {
      for (const h of m.hooks) {
        assert.equal(h.async, true, `${ev} hook must be async:true`)
      }
    }
  }
})
