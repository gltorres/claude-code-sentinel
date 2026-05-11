// bash policy — Sprint 04.
import { walk } from './bash-walker.mjs'
import { matchPath } from './paths.mjs'

const SK_ANT_RE = /sk-ant-[A-Za-z0-9_-]+/g
const SEGMENT_CAP = 80

function sanitiseSegment(raw) {
  return raw.replace(SK_ANT_RE, '[REDACTED]').slice(0, SEGMENT_CAP)
}

function candidatePaths(segment) {
  const candidates = []
  for (const arg of segment.args) {
    // @-prefixed flag values (e.g. curl --data-binary @.env) — strip the @
    if (arg.startsWith('@')) {
      candidates.push(arg.slice(1))
      continue
    }
    // anything containing a slash, starting with ~, or bearing a file extension
    if (arg.includes('/') || arg.startsWith('~') || /\.\w{1,6}$/.test(arg)) {
      candidates.push(arg)
    }
  }
  // Only < (read) redirects are exfil candidates; write redirects are ignored per §5
  const READ_OPS = new Set(['<'])
  for (const r of segment.redirects) {
    if (READ_OPS.has(r.op) && r.target) {
      candidates.push(r.target)
    }
  }
  return candidates
}

function isValueStrip(segment, bashCfg) {
  const allowStrip = bashCfg.allowValueStripping !== false
  if (!allowStrip) return false
  const stripList = Array.isArray(bashCfg.valueStrippingCommands) ? bashCfg.valueStrippingCommands : []
  return stripList.includes(segment.command)
}

// grep -c / --count → output is a count, not content → safe
// wc (any invocation, including bare) → output is size/line counts → safe
function isCountBounded(segment) {
  const cmd = segment.command
  if (cmd === 'wc') return true
  if (cmd === 'grep' || cmd === 'rg') {
    return segment.args.some(a => a === '-c' || a === '--count')
  }
  return false
}

// Evaluate whether a bash command string should be allowed, denied, or escalated.
//
// Decision order per segment:
//   1. If walk() reports exotic → return ask immediately.
//   2. For each segment:
//      a. Collect candidate paths (positional args, @-values, < redirects).
//      b. For each candidate, call matchPath. If decision === 'deny' the segment
//         touches a secret.
//      c. If the segment touches a secret:
//         - Value-stripping commands (wc, stat, shasum, …) with allowValueStripping
//           true → skip (allow this segment).
//         - Count-bounded commands (grep -c, wc) → skip (allow this segment).
//         - All other commands → deny with rule 'bash.<command>' and the matched
//           path from matchPath.
//         - Unknown commands (not in denyList and not in stripList) touching a
//           secret → deny with rule 'bash.unknown-command-touching-secret'
//           (fail-closed per research §5).
//   3. If all segments pass → allow.
//
// Returns:
//   { decision: 'allow', rule: null, matched: null, matched_segment: null }
//   { decision: 'deny',  rule: string, matched: string, matched_segment: string }
//   { decision: 'ask',   rule: 'bash.exotic', matched: null, matched_segment: null }
//
// Options:
//   command {string}  — raw bash command string from tool_input.command
//   cwd     {string}  — working directory for relative-path resolution
//   home    {string}  — home directory for tilde expansion
//   config  {object}  — merged Sentinel config object
export function evaluateBash({ command, cwd, home, config } = {}) {
  const bashCfg = (config && config.bash) || {}
  const denyList = Array.isArray(bashCfg.denyCommands) ? bashCfg.denyCommands : []
  const stripList = Array.isArray(bashCfg.valueStrippingCommands) ? bashCfg.valueStrippingCommands : []
  const allowStrip = bashCfg.allowValueStripping !== false

  let walked
  try {
    walked = walk(command)
  } catch {
    // tokenizer/walker threw — treat as exotic
    return { decision: 'ask', rule: 'bash.exotic', matched: null, matched_segment: null }
  }

  if (walked.exotic) {
    return { decision: 'ask', rule: 'bash.exotic', matched: null, matched_segment: null }
  }

  for (const segment of walked.segments) {
    // propagate segment-level exotic (walker may set it per-segment)
    if (segment.exotic) {
      return { decision: 'ask', rule: 'bash.exotic', matched: null, matched_segment: null }
    }

    const paths = candidatePaths(segment)
    let secretPath = null
    let pathRule = null
    let pathMatched = null

    for (const cand of paths) {
      const r = matchPath({ filePath: cand, cwd, home, config })
      if (r.decision === 'deny') {
        secretPath = cand
        pathRule = r.rule        // e.g. 'paths.deny'
        pathMatched = r.matched  // e.g. '**/.env'
        break
      }
    }

    if (secretPath !== null) {
      // Value-strip allowance: wc, stat, shasum, etc. → skip
      if (isValueStrip(segment, bashCfg)) continue
      // Count-bounded allowance: grep -c, wc → skip
      if (isCountBounded(segment)) continue

      // Determine the rule string
      const rule = denyList.includes(segment.command)
        ? `bash.${segment.command}`
        : 'bash.unknown-command-touching-secret'

      return {
        decision: 'deny',
        rule,
        matched: pathMatched,
        matched_segment: sanitiseSegment(segment.raw)
      }
    }
  }

  return { decision: 'allow', rule: null, matched: null, matched_segment: null }
}
