import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

const marketplace = JSON.parse(
  readFileSync(resolve(REPO, '.claude-plugin/marketplace.json'), 'utf8'),
)

test('marketplace.json declares exactly one plugin entry', () => {
  assert.ok(Array.isArray(marketplace.plugins), 'plugins must be an array')
  assert.equal(marketplace.plugins.length, 1)
})

test('marketplace plugin slug is sentinel', () => {
  assert.equal(marketplace.plugins[0].name, 'sentinel')
})

test('marketplace plugin source points at the repo root', () => {
  assert.equal(marketplace.plugins[0].source, './')
})
