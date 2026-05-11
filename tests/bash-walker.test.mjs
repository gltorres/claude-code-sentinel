// bash-walker tests — Sprint 04.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { walk } from '../src/sentinel/bash-walker.mjs'

// ── simple single-segment commands ───────────────────────────────────────────

test('single command: ls produces one segment with no args', () => {
  const { segments, exotic } = walk('ls')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'ls')
  assert.deepEqual(segments[0].args, [])
  assert.deepEqual(segments[0].redirects, [])
})

test('single command with args: cat .env produces one segment', () => {
  const { segments, exotic } = walk('cat .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'cat')
  assert.deepEqual(segments[0].args, ['.env'])
  assert.deepEqual(segments[0].redirects, [])
})

// ── compound commands (AC #4 and #5) ─────────────────────────────────────────

test('AC #4: ls && cat .env produces two segments', () => {
  const { segments, exotic } = walk('ls && cat .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].command, 'ls')
  assert.deepEqual(segments[0].args, [])
  assert.equal(segments[1].command, 'cat')
  assert.deepEqual(segments[1].args, ['.env'])
})

test('AC #5: echo hello && wc -l .env produces two segments', () => {
  const { segments, exotic } = walk('echo hello && wc -l .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].command, 'echo')
  assert.deepEqual(segments[0].args, ['hello'])
  assert.equal(segments[1].command, 'wc')
  assert.deepEqual(segments[1].args, ['-l', '.env'])
})

test('semicolon separator: ls; cat .env produces two segments', () => {
  const { segments, exotic } = walk('ls; cat .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].command, 'ls')
  assert.equal(segments[1].command, 'cat')
})

test('OR separator: false || cat .env produces two segments', () => {
  const { segments, exotic } = walk('false || cat .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].command, 'false')
  assert.equal(segments[1].command, 'cat')
})

// ── pipelines ─────────────────────────────────────────────────────────────────

test('pipeline: cat .env | pbcopy produces two segments', () => {
  const { segments, exotic } = walk('cat .env | pbcopy')
  assert.equal(exotic, false)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].command, 'cat')
  assert.deepEqual(segments[0].args, ['.env'])
  assert.equal(segments[1].command, 'pbcopy')
  assert.deepEqual(segments[1].args, [])
})

// ── redirect extraction ───────────────────────────────────────────────────────

test('redirect: cat .env > /tmp/x extracts redirect and keeps only .env in args', () => {
  const { segments, exotic } = walk('cat .env > /tmp/x')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'cat')
  assert.deepEqual(segments[0].args, ['.env'])
  assert.equal(segments[0].redirects.length, 1)
  assert.equal(segments[0].redirects[0].op, '>')
  assert.equal(segments[0].redirects[0].target, '/tmp/x')
})

test('redirect: grep FOO .env >> /tmp/out extracts append redirect', () => {
  const { segments, exotic } = walk('grep FOO .env >> /tmp/out')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'grep')
  assert.deepEqual(segments[0].args, ['FOO', '.env'])
  assert.equal(segments[0].redirects.length, 1)
  assert.equal(segments[0].redirects[0].op, '>>')
  assert.equal(segments[0].redirects[0].target, '/tmp/out')
})

test('redirect: wc -l < .env extracts stdin redirect', () => {
  const { segments, exotic } = walk('wc -l < .env')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'wc')
  assert.deepEqual(segments[0].args, ['-l'])
  assert.equal(segments[0].redirects[0].op, '<')
  assert.equal(segments[0].redirects[0].target, '.env')
})

// ── raw field ─────────────────────────────────────────────────────────────────

test('raw field: single segment raw is the trimmed command text', () => {
  const { segments } = walk('cat .env')
  assert.ok(segments[0].raw.includes('cat'))
  assert.ok(segments[0].raw.includes('.env'))
})

test('raw field: compound command raw fields are non-empty for each segment', () => {
  const { segments } = walk('ls && cat .env')
  assert.ok(segments[0].raw.length > 0)
  assert.ok(segments[1].raw.length > 0)
})

// ── exotic propagation ────────────────────────────────────────────────────────

test('exotic: heredoc returns exotic=true and empty segments', () => {
  const { segments, exotic } = walk('cat <<EOF\nfoo\nEOF')
  assert.equal(exotic, true)
  assert.deepEqual(segments, [])
})

test('exotic: command substitution $(...) returns exotic=true', () => {
  const { segments, exotic } = walk('echo $(cat .env)')
  assert.equal(exotic, true)
  assert.deepEqual(segments, [])
})

test('exotic: process substitution <(...) returns exotic=true', () => {
  const { segments, exotic } = walk('diff <(cat .env) <(cat .env.bak)')
  assert.equal(exotic, true)
  assert.deepEqual(segments, [])
})

// ── background operator ───────────────────────────────────────────────────────

test('background &: sleep 10 & produces one segment (preceding the &)', () => {
  const { segments, exotic } = walk('sleep 10 &')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'sleep')
  assert.deepEqual(segments[0].args, ['10'])
})

// ── trailing separator edge case ──────────────────────────────────────────────

test('trailing semicolon: cat .env; produces exactly one non-empty segment', () => {
  const { segments, exotic } = walk('cat .env;')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'cat')
})

// ── quoted arguments ──────────────────────────────────────────────────────────

test('quoted args: cat "my file.txt" passes quoted string as single arg', () => {
  const { segments, exotic } = walk('cat "my file.txt"')
  assert.equal(exotic, false)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].command, 'cat')
  assert.equal(segments[0].args.length, 1)
  // The arg should be the content of the quoted string (quotes stripped by tokenizer).
  assert.ok(segments[0].args[0].includes('my file.txt') || segments[0].args[0] === '"my file.txt"' || segments[0].args[0] === 'my file.txt')
})
