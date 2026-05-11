import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, '..', 'src', 'sentinel', 'hook.mjs')

function runHook(args, input = '{}') {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  })
}

test('--self-test exits 0', () => {
  const r = runHook(['--self-test'], '')
  assert.equal(r.status, 0)
})

for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
  test(`${ev} returns valid envelope and exits 0`, () => {
    const r = runHook([ev], '{}')
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.hookSpecificOutput.hookEventName, ev)
  })
}

test('PreToolUse envelope carries permissionDecision allow', () => {
  const r = runHook(['PreToolUse'], '{}')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})

test('unknown event falls through to allow', () => {
  const r = runHook(['Foo'], '{}')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})

test('invalid JSON on stdin is fail-open', () => {
  const r = runHook(['PreToolUse'], 'not-json-{{')
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
})
