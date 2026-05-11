// bash tokenizer tests — Sprint 04.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/sentinel/bash-tokenizer.mjs'

// ── helpers ───────────────────────────────────────────────────────────────────

function types(result) {
  return result.tokens.map(t => t.type)
}

function texts(result) {
  return result.tokens.map(t => t.text)
}

// ── basic word tokens ─────────────────────────────────────────────────────────

test('single bare word produces one word token', () => {
  const r = tokenize('cat')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['cat'])
  assert.deepEqual(types(r), ['word'])
})

test('two words separated by space produce two word tokens', () => {
  const r = tokenize('cat .env')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['cat', '.env'])
})

test('empty string produces empty token array and exotic: false', () => {
  const r = tokenize('')
  assert.equal(r.exotic, false)
  assert.equal(r.tokens.length, 0)
})

// ── separator operators ───────────────────────────────────────────────────────

test('; operator produces an op token between surrounding words', () => {
  const r = tokenize('echo a; echo b')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['echo', 'a', ';', 'echo', 'b'])
  assert.deepEqual(types(r), ['word', 'word', 'op', 'word', 'word'])
})

test('&& operator produces op token with text &&', () => {
  const r = tokenize('ls && cat .env')
  assert.equal(r.exotic, false)
  const ops = r.tokens.filter(t => t.type === 'op')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].text, '&&')
})

test('|| operator produces op token with text ||', () => {
  const r = tokenize('test -f .env || exit 1')
  assert.equal(r.exotic, false)
  const ops = r.tokens.filter(t => t.type === 'op')
  assert.equal(ops[0].text, '||')
})

test('| pipe produces op token with text |', () => {
  const r = tokenize('cat .env | pbcopy')
  assert.equal(r.exotic, false)
  const ops = r.tokens.filter(t => t.type === 'op')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].text, '|')
})

test('& background operator produces op token with text &', () => {
  const r = tokenize('sleep 60 &')
  assert.equal(r.exotic, false)
  const ops = r.tokens.filter(t => t.type === 'op')
  assert.equal(ops[0].text, '&')
})

// ── redirect operators ────────────────────────────────────────────────────────

test('> redirect produces a redirect token followed by the target word', () => {
  const r = tokenize('cat .env > /tmp/out')
  assert.equal(r.exotic, false)
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs.length, 1)
  assert.equal(redirs[0].text, '>')
  const afterRedir = r.tokens[r.tokens.indexOf(redirs[0]) + 1]
  assert.equal(afterRedir.text, '/tmp/out')
})

test('>> append redirect produces redirect token with text >>', () => {
  const r = tokenize('echo hello >> /tmp/log')
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs[0].text, '>>')
})

test('< stdin redirect produces redirect token with text <', () => {
  const r = tokenize('cat < .env')
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs[0].text, '<')
})

test('2> stderr redirect produces redirect token with text 2>', () => {
  const r = tokenize('cmd 2> /dev/null')
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs[0].text, '2>')
})

test('2>> stderr append redirect produces redirect token with text 2>>', () => {
  const r = tokenize('cmd 2>> /tmp/err.log')
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs[0].text, '2>>')
})

test('&> combined redirect produces redirect token with text &>', () => {
  const r = tokenize('cmd &> /dev/null')
  const redirs = r.tokens.filter(t => t.type === 'redirect')
  assert.equal(redirs[0].text, '&>')
})

// ── quoted strings ────────────────────────────────────────────────────────────

test('single-quoted string is a single word token with quotes stripped from text', () => {
  const r = tokenize("cat 'hello world'")
  assert.equal(r.exotic, false)
  assert.equal(r.tokens[1].text, 'hello world')
  assert.equal(r.tokens[1].raw, "'hello world'")
})

test('double-quoted string strips outer quotes and resolves backslash escape', () => {
  const r = tokenize('grep "hello\\"alice"')
  assert.equal(r.exotic, false)
  // text should have the backslash-escaped quote resolved to literal "
  assert.equal(r.tokens[1].text, 'hello"alice')
})

test('comment after # outside quotes is stripped and does not produce tokens', () => {
  const r = tokenize('echo hello # this is a comment')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['echo', 'hello'])
})

test('# inside a double-quoted string is NOT treated as a comment', () => {
  const r = tokenize('echo "hello # world"')
  assert.equal(r.exotic, false)
  assert.equal(r.tokens[1].text, 'hello # world')
})

// ── $VAR opacity ──────────────────────────────────────────────────────────────

test('$VAR reference is passed through opaquely as part of a word token', () => {
  const r = tokenize('cat $HOME/.env')
  assert.equal(r.exotic, false)
  // $HOME/.env should be a single word token
  assert.equal(r.tokens[1].text, '$HOME/.env')
})

test('${VAR} brace reference is passed through opaquely', () => {
  const r = tokenize('echo ${PATH}')
  assert.equal(r.exotic, false)
  assert.equal(r.tokens[1].text, '${PATH}')
})

// ── exotic triggers ───────────────────────────────────────────────────────────

test('heredoc << sets exotic: true', () => {
  const r = tokenize('cat << EOF')
  assert.equal(r.exotic, true)
})

test('process substitution <( sets exotic: true', () => {
  const r = tokenize('diff <(cmd1) <(cmd2)')
  assert.equal(r.exotic, true)
})

test('process substitution >( sets exotic: true', () => {
  const r = tokenize('tee >(cmd)')
  assert.equal(r.exotic, true)
})

test('command substitution $( sets exotic: true', () => {
  const r = tokenize('echo $(cat .env)')
  assert.equal(r.exotic, true)
})

test('backtick substitution sets exotic: true', () => {
  const r = tokenize('echo `cat .env`')
  assert.equal(r.exotic, true)
})

test('unbalanced single quote at EOF sets exotic: true', () => {
  const r = tokenize("cat 'unbalanced")
  assert.equal(r.exotic, true)
})

test('unbalanced double quote at EOF sets exotic: true', () => {
  const r = tokenize('cat "unbalanced')
  assert.equal(r.exotic, true)
})

// ── compound commands (no exotic) ─────────────────────────────────────────────

test('compound command: cat .env | pbcopy tokenizes without exotic', () => {
  const r = tokenize('cat .env | pbcopy')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['cat', '.env', '|', 'pbcopy'])
})

test('compound command: grep -c FOO .env tokenizes without exotic', () => {
  const r = tokenize('grep -c FOO .env')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['grep', '-c', 'FOO', '.env'])
})

test('compound command: ls && cat .env tokenizes without exotic', () => {
  const r = tokenize('ls && cat .env')
  assert.equal(r.exotic, false)
  const opToken = r.tokens.find(t => t.type === 'op')
  assert.equal(opToken.text, '&&')
})

test('compound command: cat .env > /tmp/x tokenizes without exotic', () => {
  const r = tokenize('cat .env > /tmp/x')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['cat', '.env', '>', '/tmp/x'])
  assert.deepEqual(types(r), ['word', 'word', 'redirect', 'word'])
})

test('wc -l .env tokenizes without exotic', () => {
  const r = tokenize('wc -l .env')
  assert.equal(r.exotic, false)
  assert.deepEqual(texts(r), ['wc', '-l', '.env'])
})
