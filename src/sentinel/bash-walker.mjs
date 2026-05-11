// bash walker — segments a tokenized command string into structured segments — Sprint 04.

import { tokenize } from './bash-tokenizer.mjs'

// Operator token texts that act as segment separators.
const SEPARATORS = new Set([';', '&&', '||', '|', '&'])

// Redirect operator texts the walker understands.
// Any op token NOT in SEPARATORS is assumed to be a redirect.
const REDIRECT_OPS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '>&'])

/**
 * A single command segment parsed from a compound shell command string.
 *
 * @typedef {Object} Segment
 * @property {string}   command   - The command name (first word of the segment).
 * @property {string[]} args      - Positional arguments (subsequent words, excluding redirect targets).
 * @property {Array<{ op: string, target: string }>} redirects - Redirect pairs extracted from the segment.
 * @property {string}   raw       - Trimmed source text of the segment (used by the audit log's matched_segment field).
 */

/**
 * Walk a shell command string and split it into structured segments.
 *
 * Calls the tokenizer from bash-tokenizer.mjs. If the tokenizer signals
 * exotic: true (heredoc, process substitution, unbalanced quotes, command
 * substitution, etc.), returns { segments: [], exotic: true } immediately so
 * the caller can emit an `ask` decision without further evaluation.
 *
 * For parseable commands, splits on operator tokens (;  &&  ||  |  &),
 * extracts redirect pairs (op + target word), and builds a Segment for each
 * non-empty run of word tokens.
 *
 * Background `&` is treated as a hard separator identical to `;`; the
 * preceding tokens become a complete segment.
 *
 * @param {string} commandString - Raw shell command string from tool_input.command.
 * @returns {{ segments: Segment[], exotic: boolean }}
 */
export function walk(commandString) {
  let tokenResult
  try {
    tokenResult = tokenize(commandString)
  } catch {
    // Tokenizer threw — treat as exotic (fail closed).
    return { segments: [], exotic: true }
  }

  if (tokenResult.exotic) {
    return { segments: [], exotic: true }
  }

  const tokens = tokenResult.tokens
  const segments = []

  // currentWords: word texts accumulated for the segment being built.
  // currentRawParts: raw source strings for each token in the current segment
  //   (including redirect ops and their targets), used to reconstruct raw.
  let currentWords = []
  let currentRawParts = []
  let currentRedirects = []
  let i = 0

  function flushSegment() {
    if (currentWords.length === 0 && currentRedirects.length === 0) {
      // Empty segment (e.g. trailing separator) — skip.
      currentWords = []
      currentRawParts = []
      currentRedirects = []
      return
    }
    const command = currentWords[0] ?? ''
    const args = currentWords.slice(1)
    const raw = currentWords.join(' ')
    if (command !== '') {
      segments.push({ command, args, redirects: currentRedirects, raw })
    }
    currentWords = []
    currentRawParts = []
    currentRedirects = []
  }

  while (i < tokens.length) {
    const tok = tokens[i]

    if (tok.type === 'op' && SEPARATORS.has(tok.text)) {
      // Separator — flush the current segment and skip the separator token.
      flushSegment()
      i++
      continue
    }

    if (tok.type === 'redirect' || (tok.type === 'op' && REDIRECT_OPS.has(tok.text))) {
      // Redirect operator — the next token must be a word (the target).
      const nextTok = tokens[i + 1]
      if (!nextTok || nextTok.type !== 'word') {
        // Missing or non-word redirect target — fail closed.
        return { segments: [], exotic: true }
      }
      currentRawParts.push(tok.raw ?? tok.text)
      currentRawParts.push(' ')
      currentRawParts.push(nextTok.raw ?? nextTok.text)
      currentRedirects.push({ op: tok.text, target: nextTok.text })
      // Consume both the redirect op and its target.
      i += 2
      continue
    }

    // Plain word token — add to current segment.
    currentWords.push(tok.text)
    currentRawParts.push(tok.raw ?? tok.text)
    i++
  }

  // Flush any remaining tokens as the last segment.
  flushSegment()

  return { segments, exotic: false }
}
