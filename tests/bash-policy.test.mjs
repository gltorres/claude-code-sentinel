import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBash } from '../src/sentinel/bash-policy.mjs'

const CFG = {
  paths: {
    deny: [
      '**/.env', '**/.env.*', '**/.envrc', '**/credentials*.json',
      '**/secrets*.y?ml', '**/.bashrc', '**/.zshrc', '**/.profile',
      '**/.bash_profile', '**/*.pem', '**/*.key', '**/.aws/credentials',
      '**/.aws/config', '**/.kube/config', '**/.ssh/id_*', '**/.npmrc',
      '**/.pypirc', '**/.git-credentials', '**/.netrc'
    ],
    allow: [
      '**/.env.example', '**/.env.sample', '**/.env.template',
      '**/*.pub', '**/*.public.*'
    ]
  },
  bash: {
    denyCommands: ['cat','head','tail','less','more','bat','view','xxd',
      'hexdump','base64','grep','rg','awk','sed','perl','cp','mv',
      'tee','pbcopy','xclip','nc','curl'],
    warnCommands: [],
    allowValueStripping: true,
    valueStrippingCommands: ['wc','file','stat','ls','du','shasum','sha256sum','md5sum']
  }
}

const CWD = '/home/user/project'
const HOME = '/home/user'
const OPTS = { cwd: CWD, home: HOME, config: CFG }

test('cat .env is denied', () => {
  const r = evaluateBash({ command: 'cat .env', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.cat')
  assert.ok(r.matched, 'matched must be set')
  assert.ok(r.matched_segment, 'matched_segment must be set')
  assert.ok(r.matched_segment.includes('cat'))
})

test('wc -l .env is allowed (value-strip)', () => {
  const r = evaluateBash({ command: 'wc -l .env', ...OPTS })
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
  assert.equal(r.matched, null)
  assert.equal(r.matched_segment, null)
})

test('cat .env | pbcopy is denied', () => {
  const r = evaluateBash({ command: 'cat .env | pbcopy', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.cat')
  assert.ok(r.matched_segment.includes('cat'))
})

test('cp .env /tmp/x is denied (exfil via copy)', () => {
  const r = evaluateBash({ command: 'cp .env /tmp/x', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.cp')
  assert.ok(r.matched_segment.includes('cp'))
})

test('cat .env > /tmp/x is denied (cat reads secret, write redirect ignored)', () => {
  const r = evaluateBash({ command: 'cat .env > /tmp/x', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.cat')
})

test('grep -c FOO .env is allowed (count-bounded)', () => {
  const r = evaluateBash({ command: 'grep -c FOO .env', ...OPTS })
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
})

test('grep FOO .env is denied (content-leaking grep)', () => {
  const r = evaluateBash({ command: 'grep FOO .env', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.grep')
})

test('ls && cat .env is denied (compound command)', () => {
  const r = evaluateBash({ command: 'ls && cat .env', ...OPTS })
  assert.equal(r.decision, 'deny')
  assert.equal(r.rule, 'bash.cat')
})

test('echo hello && wc -l .env is allowed', () => {
  const r = evaluateBash({ command: 'echo hello && wc -l .env', ...OPTS })
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
})

test('heredoc returns ask (exotic shape)', () => {
  const r = evaluateBash({ command: 'cat <<EOF\nhello\nEOF', ...OPTS })
  assert.equal(r.decision, 'ask')
  assert.equal(r.rule, 'bash.exotic')
  assert.equal(r.matched, null)
  assert.equal(r.matched_segment, null)
})

test('cat README.md is allowed (no secret path)', () => {
  const r = evaluateBash({ command: 'cat README.md', ...OPTS })
  assert.equal(r.decision, 'allow')
  assert.equal(r.rule, null)
})

test('empty command string is allowed (no segments)', () => {
  const r = evaluateBash({ command: '', ...OPTS })
  assert.equal(r.decision, 'allow')
})
