import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scrubFamilies } from '../src/sentinel/scrubber-families.mjs'

// ---------------------------------------------------------------------------
// Helper: build a token of exactly `n` chars from a safe alphabet.
// ---------------------------------------------------------------------------
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function rep(n, char = 'A') { return char.repeat(n) }
function alnum(n) { return alpha.slice(0, n % alpha.length || alpha.length).padEnd(n, alpha[0]) }

// ---------------------------------------------------------------------------
// anthropic
// ---------------------------------------------------------------------------
describe('family: anthropic', () => {
  it('positive — sk-ant- prefix with 32+ alnum chars is redacted', () => {
    const token = 'sk-ant-' + alnum(40)
    const { text, redactions } = scrubFamilies(`export ANTHROPIC_API_KEY=${token}`, [])
    assert.ok(text.includes('<REDACTED:anthropic>'), 'tag must appear')
    assert.ok(!text.includes(token), 'raw token must be absent')
    assert.equal(redactions.length, 1)
    assert.equal(redactions[0].family, 'anthropic')
    assert.equal(redactions[0].count, 1)
  })

  it('negative — sk-ant- prefix with only 10 chars is NOT redacted (too short)', () => {
    const token = 'sk-ant-' + alnum(10)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(text, token)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// openai
// ---------------------------------------------------------------------------
describe('family: openai', () => {
  it('positive — sk- prefix (non-ant) with 40+ alnum chars is redacted', () => {
    const token = 'sk-' + alnum(48)
    const { text, redactions } = scrubFamilies(`key=${token}`, [])
    assert.ok(text.includes('<REDACTED:openai>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'openai')
  })

  it('negative — sk-ant- token is NOT matched by openai (negative lookahead)', () => {
    // Even if anthropic family were removed, the openai regex must not match sk-ant-...
    const token = 'sk-ant-' + alnum(40)
    // Pass it through only the openai pattern by using a text that was already
    // scrubbed of the anthropic tag — simulate a partially-scrubbed string.
    // The negative lookahead in the openai regex prevents the match entirely.
    const { text, redactions } = scrubFamilies(token, [])
    // anthropic fires first and replaces it; openai must not add a second entry
    assert.equal(redactions.filter(r => r.family === 'openai').length, 0)
  })
})

// ---------------------------------------------------------------------------
// github_pat
// ---------------------------------------------------------------------------
describe('family: github_pat', () => {
  it('positive — ghp_ prefix with 36+ alnum chars is redacted', () => {
    const token = 'ghp_' + alnum(40)
    const { text, redactions } = scrubFamilies(`GITHUB_TOKEN=${token}`, [])
    assert.ok(text.includes('<REDACTED:github_pat>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'github_pat')
  })

  it('negative — unknown prefix gh_xxxx is NOT redacted', () => {
    const token = 'gh_' + alnum(40)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(text, token)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// aws_akid
// ---------------------------------------------------------------------------
describe('family: aws_akid', () => {
  it('positive — AKIA followed by exactly 16 uppercase alnum chars is redacted', () => {
    const token = 'AKIA' + rep(16, 'A').replace(/A/g, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[i % 36])
    const fixed = 'AKIAIOSFODNN7EXAMPLE'   // classic AWS example (20 chars total)
    const { text, redactions } = scrubFamilies(`AWS_ACCESS_KEY_ID=${fixed}`, [])
    assert.ok(text.includes('<REDACTED:aws_akid>'))
    assert.ok(!text.includes(fixed))
    assert.equal(redactions[0].family, 'aws_akid')
    assert.equal(redactions[0].count, 1)
  })

  it('negative — AKIA with lowercase letters is NOT redacted', () => {
    const token = 'AKIAiosfodnn7example'
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(text, token)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// aws_session
// ---------------------------------------------------------------------------
describe('family: aws_session', () => {
  it('positive — aws_session_token=<value> is redacted (value portion only)', () => {
    const value = alnum(200)
    const input = `aws_session_token=${value} other=stuff`
    const { text, redactions } = scrubFamilies(input, [])
    assert.ok(text.includes('aws_session_token=<REDACTED:aws_session>'), 'key name must remain')
    assert.ok(!text.includes(value), 'raw value must be absent')
    assert.ok(text.includes('other=stuff'), 'trailing content must be preserved')
    assert.equal(redactions[0].family, 'aws_session')
  })

  it('negative — session_token without aws_ prefix is NOT redacted', () => {
    const input = `session_token=${alnum(50)}`
    const { text, redactions } = scrubFamilies(input, [])
    assert.equal(text, input)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// slack
// ---------------------------------------------------------------------------
describe('family: slack', () => {
  it('positive — xoxb- prefix with 10+ alnum-dash chars is redacted', () => {
    const token = 'xoxb-' + alnum(24) + '-' + alnum(24) + '-' + alnum(24)
    const { text, redactions } = scrubFamilies(`SLACK_BOT_TOKEN=${token}`, [])
    assert.ok(text.includes('<REDACTED:slack>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'slack')
  })

  it('negative — xoxz- (invalid prefix letter) is NOT redacted', () => {
    const token = 'xoxz-' + alnum(24)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(text, token)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// stripe_live
// ---------------------------------------------------------------------------
describe('family: stripe_live', () => {
  it('positive — sk_live_ prefix with 24+ alnum chars is redacted', () => {
    const token = 'sk_live_' + alnum(32)
    const { text, redactions } = scrubFamilies(`STRIPE_SECRET=${token}`, [])
    assert.ok(text.includes('<REDACTED:stripe_live>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'stripe_live')
  })

  it('negative — sk_test_ prefix is NOT redacted by stripe_live family', () => {
    const token = 'sk_test_' + alnum(32)
    const { text, redactions } = scrubFamilies(token, [])
    // sk_test_ should not match sk_live_ pattern
    assert.equal(redactions.filter(r => r.family === 'stripe_live').length, 0)
  })
})

// ---------------------------------------------------------------------------
// sendgrid
// ---------------------------------------------------------------------------
describe('family: sendgrid', () => {
  it('positive — SG.<22chars>.<43chars> is redacted', () => {
    const token = 'SG.' + alnum(22) + '.' + alnum(43)
    const { text, redactions } = scrubFamilies(`SENDGRID_API_KEY=${token}`, [])
    assert.ok(text.includes('<REDACTED:sendgrid>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'sendgrid')
  })

  it('negative — SG.<21chars>.<43chars> (part1 too short) is NOT redacted', () => {
    const token = 'SG.' + alnum(21) + '.' + alnum(43)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(redactions.filter(r => r.family === 'sendgrid').length, 0)
  })
})

// ---------------------------------------------------------------------------
// atlassian
// ---------------------------------------------------------------------------
describe('family: atlassian', () => {
  it('positive — ATATT3 prefix with 180+ alnum-dash-underscore chars is redacted', () => {
    const token = 'ATATT3' + alnum(180)
    const { text, redactions } = scrubFamilies(`JIRA_API_TOKEN=${token}`, [])
    assert.ok(text.includes('<REDACTED:atlassian>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'atlassian')
  })

  it('negative — ATATT3 prefix with only 50 chars (too short) is NOT redacted', () => {
    const token = 'ATATT3' + alnum(50)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(redactions.filter(r => r.family === 'atlassian').length, 0)
  })
})

// ---------------------------------------------------------------------------
// langsmith
// ---------------------------------------------------------------------------
describe('family: langsmith', () => {
  it('positive — lsv2_pt_ prefix with 32+ alnum chars is redacted', () => {
    const token = 'lsv2_pt_' + alnum(32)
    const { text, redactions } = scrubFamilies(`LANGCHAIN_API_KEY=${token}`, [])
    assert.ok(text.includes('<REDACTED:langsmith>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'langsmith')
  })

  it('negative — lsv2_pt_ prefix with only 10 chars (too short) is NOT redacted', () => {
    const token = 'lsv2_pt_' + alnum(10)
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(redactions.filter(r => r.family === 'langsmith').length, 0)
  })
})

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------
describe('family: jwt', () => {
  it('positive — eyJ...eyJ...sig three-part JWT is redacted', () => {
    // Minimal valid-shape JWT (not cryptographically valid, but shape-valid)
    const header  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0'
    const sig     = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const token = `${header}.${payload}.${sig}`
    const { text, redactions } = scrubFamilies(`Authorization: Bearer ${token}`, [])
    assert.ok(text.includes('<REDACTED:jwt>'))
    assert.ok(!text.includes(token))
    assert.equal(redactions[0].family, 'jwt')
  })

  it('negative — plain "eyJ" string without dot-separated parts is NOT redacted as jwt', () => {
    // Just the header part, no payload or sig
    const token = 'eyJhbGciOiJIUzI1NiJ9'
    const { text, redactions } = scrubFamilies(token, [])
    assert.equal(redactions.filter(r => r.family === 'jwt').length, 0)
  })
})

// ---------------------------------------------------------------------------
// multiple occurrences — count accuracy
// ---------------------------------------------------------------------------
describe('count accuracy', () => {
  it('two Anthropic tokens in one response produce count=2', () => {
    const t1 = 'sk-ant-' + alnum(40)
    const t2 = 'sk-ant-' + alnum(40).split('').reverse().join('')
    const { redactions } = scrubFamilies(`key1=${t1}\nkey2=${t2}`, [])
    const r = redactions.find(r => r.family === 'anthropic')
    assert.ok(r, 'anthropic redaction entry must exist')
    assert.equal(r.count, 2)
  })
})

// ---------------------------------------------------------------------------
// prose preservation
// ---------------------------------------------------------------------------
describe('prose preservation', () => {
  it('non-secret prose is returned unchanged', () => {
    const input = 'the build passed in 4.2 seconds — 42 tests green, 0 failed.'
    const { text, redactions } = scrubFamilies(input, [])
    assert.equal(text, input)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// extraPatterns — string shape
// ---------------------------------------------------------------------------
describe('extraPatterns: string shape', () => {
  it('raw string pattern matches and tags as <REDACTED:custom>', () => {
    const { text, redactions } = scrubFamilies('MY_SECRET=hunter2', ['hunter2'])
    assert.ok(text.includes('<REDACTED:custom>'))
    assert.ok(!text.includes('hunter2'))
    assert.equal(redactions.find(r => r.family === 'custom')?.count, 1)
  })

  it('malformed regex source is silently skipped, text unchanged', () => {
    const input = 'some text'
    const { text, redactions } = scrubFamilies(input, ['[invalid'])
    assert.equal(text, input)
    assert.equal(redactions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// extraPatterns — {name, pattern} shape
// ---------------------------------------------------------------------------
describe('extraPatterns: {name, pattern} shape', () => {
  it('{name, pattern} object tags as <REDACTED:<name>>', () => {
    const { text, redactions } = scrubFamilies('token=mysecret123', [
      { name: 'myapp', pattern: 'mysecret\\d+' },
    ])
    assert.ok(text.includes('<REDACTED:myapp>'))
    assert.ok(!text.includes('mysecret123'))
    assert.equal(redactions.find(r => r.family === 'myapp')?.count, 1)
  })

  it('entry missing name or pattern is silently skipped', () => {
    const input = 'some text'
    const { text, redactions } = scrubFamilies(input, [
      { name: 'broken' },       // missing pattern
      { pattern: 'text' },      // missing name
    ])
    // 'text' will not be caught because name is missing → custom branch also
    // needs `entry.name` — confirm skipped
    assert.equal(redactions.length, 0)
  })
})
