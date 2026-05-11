import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubContext } from '../src/sentinel/scrubber-context.mjs'

test('context: redacts DB_PASSWORD=hunter2', () => {
  const { text, redactions } = scrubContext('DB_PASSWORD=hunter2')
  assert.ok(text.includes('<REDACTED:assignment>'))
  assert.ok(!text.includes('hunter2'))
  assert.equal(redactions[0].family, 'assignment')
})

test('context: redacts JSON-shaped "api_token": "x"', () => {
  const { text } = scrubContext('{"api_token": "abcd1234"}')
  assert.ok(text.includes('<REDACTED:assignment>'))
  assert.ok(!text.includes('abcd1234'))
})

test('context: handles api-key, client_secret, access_key, private_key', () => {
  for (const kw of ['api-key', 'client_secret', 'access_key', 'private_key']) {
    const t = `${kw}=secretvalue123`
    const { text } = scrubContext(t)
    assert.ok(text.includes('<REDACTED:assignment>'), `${kw} should match`)
  }
})

test('context: skips placeholder values', () => {
  for (const v of ['none', 'null', 'undefined', 'TODO', 'XXXX', 'changeme']) {
    const { text } = scrubContext(`password=${v}`)
    assert.ok(text.includes(v), `${v} should be preserved as placeholder`)
  }
})

test('context: does not re-tag already-redacted values', () => {
  const { text, redactions } = scrubContext('password=<REDACTED:openai>')
  assert.ok(text.includes('<REDACTED:openai>'))
  assert.equal(redactions.length, 0)
})

test('context: ignores non-secret keywords', () => {
  const { text } = scrubContext('name=alice age=30 city=Boston')
  assert.equal(text, 'name=alice age=30 city=Boston')
})

test('context: short values (<4 chars) are not redacted', () => {
  const { text } = scrubContext('password=ab')
  assert.equal(text, 'password=ab')
})

test('context: instances carry prefix/length/line', () => {
  const { redactions } = scrubContext('DB_PASSWORD=hunter2longvalue')
  const inst = redactions[0].instances[0]
  assert.equal(inst.prefix, 'hunt')
  assert.equal(inst.length, 'hunter2longvalue'.length)
  assert.equal(inst.line, 1)
})
