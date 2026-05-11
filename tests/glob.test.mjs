// Glob matcher tests — Sprint 03.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileGlob, matchGlob } from '../src/sentinel/glob.mjs'

// ── literal patterns ─────────────────────────────────────────────────────────

test('literal: exact match succeeds', () => {
  assert.equal(matchGlob('README.md', 'README.md'), true)
})

test('literal: different extension does not match', () => {
  assert.equal(matchGlob('README.md', 'README.txt'), false)
})

test('literal: path separator in pattern requires separator in path', () => {
  assert.equal(matchGlob('src/index.mjs', 'src/index.mjs'), true)
  assert.equal(matchGlob('src/index.mjs', 'lib/index.mjs'), false)
})

// ── single-star wildcard ──────────────────────────────────────────────────────

test('*: matches any non-/ sequence within a segment', () => {
  assert.equal(matchGlob('*.md', 'README.md'), true)
  assert.equal(matchGlob('*.md', 'CHANGELOG.md'), true)
})

test('*: does not cross a path separator', () => {
  assert.equal(matchGlob('*.md', 'docs/README.md'), false)
})

test('*: infix wildcard matches partial segment', () => {
  assert.equal(matchGlob('credentials*.json', 'credentials_prod.json'), true)
  assert.equal(matchGlob('credentials*.json', 'credentials.json'), true)
  assert.equal(matchGlob('credentials*.json', 'not-credentials.json'), false)
})

// ── question-mark wildcard ────────────────────────────────────────────────────

test('?: matches exactly one non-/ character', () => {
  assert.equal(matchGlob('id_?', 'id_a'), true)
  assert.equal(matchGlob('id_?', 'id_'), false)
  assert.equal(matchGlob('id_?', 'id_ab'), false)
})

test('?: does not match a path separator', () => {
  assert.equal(matchGlob('a?b', 'a/b'), false)
})

// ── double-star wildcard ──────────────────────────────────────────────────────

test('**: **/.env matches .env at any depth', () => {
  assert.equal(matchGlob('**/.env', '.env'), true)
  assert.equal(matchGlob('**/.env', '/home/user/proj/.env'), true)
  assert.equal(matchGlob('**/.env', 'a/b/c/.env'), true)
})

test('**: **/.env does not match .env.example', () => {
  assert.equal(matchGlob('**/.env', '.env.example'), false)
  assert.equal(matchGlob('**/.env', '/home/user/.env.example'), false)
})

test('**: **/*.pem matches pem files at any depth', () => {
  assert.equal(matchGlob('**/*.pem', 'server.pem'), true)
  assert.equal(matchGlob('**/*.pem', '/etc/ssl/certs/server.pem'), true)
  assert.equal(matchGlob('**/*.pem', '/home/user/.ssh/key.pem'), true)
})

test('**: **/.ssh/id_* matches private key files', () => {
  assert.equal(matchGlob('**/.ssh/id_*', '/home/user/.ssh/id_ed25519'), true)
  assert.equal(matchGlob('**/.ssh/id_*', '/home/user/.ssh/id_rsa'), true)
  assert.equal(matchGlob('**/.ssh/id_*', '/home/user/.ssh/id_ed25519.pub'), true)
})

test('**: **/credentials*.json matches at any depth', () => {
  assert.equal(matchGlob('**/credentials*.json', 'credentials.json'), true)
  assert.equal(matchGlob('**/credentials*.json', '/home/.aws/credentials_prod.json'), true)
  assert.equal(matchGlob('**/credentials*.json', 'a/b/c/credentials_staging.json'), true)
})

// ── character classes ─────────────────────────────────────────────────────────

test('[abc]: matches any listed character', () => {
  assert.equal(matchGlob('secret[sy]', 'secrets'), true)
  assert.equal(matchGlob('secret[sy]', 'secrety'), true)
  assert.equal(matchGlob('secret[sy]', 'secretz'), false)
})

test('[a-z]: range class matches lowercase letters', () => {
  assert.equal(matchGlob('file[a-z].txt', 'filea.txt'), true)
  assert.equal(matchGlob('file[a-z].txt', 'fileZ.txt'), false)
})

test('[!a]: negated class excludes listed characters', () => {
  assert.equal(matchGlob('[!.]env', 'aenv'), true)
  assert.equal(matchGlob('[!.]env', '.env'), false)
})

// ── leading-dot (hidden) files ────────────────────────────────────────────────

test('leading-dot: literal .env matches .env', () => {
  assert.equal(matchGlob('.env', '.env'), true)
})

test('leading-dot: **/.bashrc matches nested hidden file', () => {
  assert.equal(matchGlob('**/.bashrc', '/home/user/.bashrc'), true)
  assert.equal(matchGlob('**/.bashrc', '.bashrc'), true)
})

// ── absolute-path anchoring ───────────────────────────────────────────────────

test('absolute: /etc/passwd matches exactly, not a subpath', () => {
  assert.equal(matchGlob('/etc/passwd', '/etc/passwd'), true)
  assert.equal(matchGlob('/etc/passwd', '/etc/passwd.bak'), false)
})

// ── compileGlob returns a RegExp ──────────────────────────────────────────────

test('compileGlob: returns a RegExp instance', () => {
  const re = compileGlob('**/*.json')
  assert.ok(re instanceof RegExp)
})

test('compileGlob: compiled regexp is reusable across multiple paths', () => {
  const re = compileGlob('**/.env')
  assert.equal(re.test('.env'), true)
  assert.equal(re.test('/a/b/.env'), true)
  assert.equal(re.test('.env.local'), false)
})

// ── PRD canonical patterns ────────────────────────────────────────────────────

test('PRD: **/.ssh/id_* does not match id_ed25519.pub via separate allow pattern', () => {
  // The deny pattern matches .pub files too — allow-overrides-deny is Spec 2's job.
  // Here we just verify the deny pattern is inclusive.
  assert.equal(matchGlob('**/.ssh/id_*', '/home/user/.ssh/id_ed25519.pub'), true)
})

test('PRD: **/*.key matches private key files', () => {
  assert.equal(matchGlob('**/*.key', '/etc/ssl/private/server.key'), true)
  assert.equal(matchGlob('**/*.key', 'mykey.key'), true)
  assert.equal(matchGlob('**/*.key', 'mykey.pub'), false)
})

test('PRD: **/.netrc matches netrc at any depth', () => {
  assert.equal(matchGlob('**/.netrc', '/home/user/.netrc'), true)
  assert.equal(matchGlob('**/.netrc', '.netrc'), true)
  assert.equal(matchGlob('**/.netrc', '/home/user/.netrcfoo'), false)
})
