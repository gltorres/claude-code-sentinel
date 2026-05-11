import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { matchPath } from '../src/sentinel/paths.mjs'

// Minimal config that mirrors the shape produced by loadConfig after Spec 2.
const DEFAULT_CONFIG = {
  paths: {
    deny: [
      '**/.env',
      '**/.env.*',
      '**/.envrc',
      '**/credentials*.json',
      '**/secrets*.y?ml',
      '**/.bashrc',
      '**/.zshrc',
      '**/.profile',
      '**/.bash_profile',
      '**/*.pem',
      '**/*.key',
      '**/.aws/credentials',
      '**/.aws/config',
      '**/.kube/config',
      '**/.ssh/id_*',
      '**/.npmrc',
      '**/.pypirc',
      '**/.git-credentials',
      '**/.netrc'
    ],
    allow: [
      '**/.env.example',
      '**/.env.sample',
      '**/.env.template',
      '**/*.pub',
      '**/*.public.*'
    ]
  }
}

const CWD = '/home/user/project'
const HOME = '/home/user'

test('.env is denied', () => {
  const result = matchPath({
    filePath: '/home/user/project/.env',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'deny')
  assert.equal(result.rule, 'paths.deny')
  assert.ok(result.matched, 'matched must be set')
})

test('.env.example is allowed despite **/.env.* deny pattern', () => {
  const result = matchPath({
    filePath: '/home/user/project/.env.example',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.rule, 'paths.allow')
})

test('id_ed25519 is denied', () => {
  const result = matchPath({
    filePath: '/home/user/.ssh/id_ed25519',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'deny')
  assert.equal(result.rule, 'paths.deny')
})

test('id_ed25519.pub is allowed', () => {
  const result = matchPath({
    filePath: '/home/user/.ssh/id_ed25519.pub',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.rule, 'paths.allow')
})

test('relative path is resolved against cwd before matching', () => {
  // .env relative to CWD resolves to /home/user/project/.env
  const result = matchPath({
    filePath: '.env',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'deny')
})

test('tilde path is expanded against home before matching', () => {
  // ~/.ssh/id_rsa expands to /home/user/.ssh/id_rsa
  const result = matchPath({
    filePath: '~/.ssh/id_rsa',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'deny')
})

test('tilde pub path is allowed after tilde expansion', () => {
  // ~/.ssh/id_ed25519.pub expands to /home/user/.ssh/id_ed25519.pub
  const result = matchPath({
    filePath: '~/.ssh/id_ed25519.pub',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.rule, 'paths.allow')
})

test('unmatched path defaults to allow with no rule', () => {
  const result = matchPath({
    filePath: '/home/user/project/src/index.mjs',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.rule, undefined)
  assert.equal(result.matched, undefined)
})

test('.npmrc is denied', () => {
  const result = matchPath({
    filePath: '/home/user/project/.npmrc',
    cwd: CWD,
    home: HOME,
    config: DEFAULT_CONFIG
  })
  assert.equal(result.decision, 'deny')
  assert.equal(result.rule, 'paths.deny')
})

test('empty allow and deny lists default to allow', () => {
  const result = matchPath({
    filePath: '/home/user/project/.env',
    cwd: CWD,
    home: HOME,
    config: { paths: { deny: [], allow: [] } }
  })
  assert.equal(result.decision, 'allow')
  assert.equal(result.rule, undefined)
})
