import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractScrubInput } from '../src/sentinel/scrubber-extract.mjs'

test('extract: null response → empty, no skip', () => {
  assert.deepEqual(extractScrubInput('Bash', null), { text: '', skip: false })
})

test('extract: string response passes through', () => {
  assert.deepEqual(extractScrubInput('Bash', 'hello'), { text: 'hello', skip: false })
})

test('extract: Bash → joins stdout + stderr', () => {
  const r = { stdout: 'out', stderr: 'err', interrupted: false }
  assert.equal(extractScrubInput('Bash', r).text, 'out\nerr')
})

test('extract: Read → returns file.content only (no envelope)', () => {
  const r = { type: 'text', file: { filePath: '/a/b.js', content: 'sk-ant-XXX' } }
  assert.equal(extractScrubInput('Read', r).text, 'sk-ant-XXX')
})

test('extract: Read package-lock.json → skip', () => {
  const r = { file: { filePath: '/repo/package-lock.json', content: 'sha512-X' } }
  assert.equal(extractScrubInput('Read', r).skip, true)
})

test('extract: Read minified js → skip', () => {
  const r = { file: { filePath: '/dist/app.min.js', content: 'function(){...}' } }
  assert.equal(extractScrubInput('Read', r).skip, true)
})

test('extract: Edit/Write → skip', () => {
  assert.equal(extractScrubInput('Edit', { ok: true }).skip, true)
  assert.equal(extractScrubInput('Write', { ok: true }).skip, true)
})

test('extract: unknown tool → JSON.stringify fallback', () => {
  const r = { weird: 'shape' }
  assert.equal(extractScrubInput('Future', r).text, '{"weird":"shape"}')
})

test('extract: custom skipPaths overrides defaults', () => {
  const r = { file: { filePath: '/repo/foo.txt', content: 'x' } }
  assert.equal(extractScrubInput('Read', r, ['**/foo.txt']).skip, true)
})

test('extract: Read non-skipped path → returns content', () => {
  const r = { file: { filePath: '/repo/src/index.js', content: 'console.log(1)' } }
  const out = extractScrubInput('Read', r)
  assert.equal(out.skip, false)
  assert.equal(out.text, 'console.log(1)')
})
