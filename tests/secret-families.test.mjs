// Secret family metadata tests — Sprint 08, Spec 02.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getFamilyMetadata } from '../src/sentinel/secret-families.mjs'

// All thirteen known family IDs (eleven hardcoded + high_entropy + custom).
const KNOWN_FAMILIES = [
  'anthropic',
  'openai',
  'github_pat',
  'aws_akid',
  'aws_session',
  'slack',
  'stripe_live',
  'sendgrid',
  'atlassian',
  'langsmith',
  'jwt',
  'high_entropy',
  'custom',
]

// ---------------------------------------------------------------------------
// Shape invariants — every known family must satisfy these
// ---------------------------------------------------------------------------
describe('shape invariants for all known families', () => {
  for (const family of KNOWN_FAMILIES) {
    it(`${family}: returns a non-null object with required fields`, () => {
      const meta = getFamilyMetadata(family)
      assert.ok(meta !== null && typeof meta === 'object', 'must return an object')
      assert.ok(typeof meta.displayName === 'string' && meta.displayName.length > 0,
        'displayName must be a non-empty string')
      assert.ok(typeof meta.revocationUrl === 'string' && meta.revocationUrl.startsWith('https://'),
        'revocationUrl must be an https URL')
      assert.ok(
        meta.severityHint === 'low' ||
        meta.severityHint === 'medium' ||
        meta.severityHint === 'high' ||
        meta.severityHint === 'critical',
        `severityHint must be one of low|medium|high|critical; got '${meta.severityHint}'`
      )
      if (meta.revocationCli !== undefined) {
        assert.ok(typeof meta.revocationCli === 'string' && meta.revocationCli.length > 0,
          'revocationCli, if present, must be a non-empty string')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// scrubber. prefix stripping
// ---------------------------------------------------------------------------
describe('scrubber. prefix stripping', () => {
  it('prefixed and bare forms return identical metadata', () => {
    const bare    = getFamilyMetadata('github_pat')
    const prefixed = getFamilyMetadata('scrubber.github_pat')
    assert.deepEqual(bare, prefixed,
      'bare and scrubber.-prefixed forms must produce identical metadata')
  })

  it('strips scrubber. prefix before lookup for every known family', () => {
    for (const family of KNOWN_FAMILIES) {
      const bare    = getFamilyMetadata(family)
      const prefixed = getFamilyMetadata(`scrubber.${family}`)
      assert.deepEqual(bare, prefixed,
        `bare and prefixed must match for family '${family}'`)
    }
  })
})

// ---------------------------------------------------------------------------
// PRD-required URL anchors (research §2.3, PRD §11)
// ---------------------------------------------------------------------------
describe('PRD-required revocation URL anchors', () => {
  it('github_pat → https://github.com/settings/tokens', () => {
    assert.equal(
      getFamilyMetadata('github_pat').revocationUrl,
      'https://github.com/settings/tokens'
    )
  })

  it('scrubber.github_pat → https://github.com/settings/tokens (prefix form)', () => {
    assert.equal(
      getFamilyMetadata('scrubber.github_pat').revocationUrl,
      'https://github.com/settings/tokens'
    )
  })

  it('aws_akid → https://console.aws.amazon.com/iam/home#/security_credentials', () => {
    assert.equal(
      getFamilyMetadata('aws_akid').revocationUrl,
      'https://console.aws.amazon.com/iam/home#/security_credentials'
    )
  })

  it('stripe_live → https://dashboard.stripe.com/apikeys', () => {
    assert.equal(
      getFamilyMetadata('stripe_live').revocationUrl,
      'https://dashboard.stripe.com/apikeys'
    )
  })

  it('slack → https://api.slack.com/apps', () => {
    assert.equal(
      getFamilyMetadata('slack').revocationUrl,
      'https://api.slack.com/apps'
    )
  })

  it('anthropic → https://console.anthropic.com/settings/keys', () => {
    assert.equal(
      getFamilyMetadata('anthropic').revocationUrl,
      'https://console.anthropic.com/settings/keys'
    )
  })

  it('openai → https://platform.openai.com/api-keys', () => {
    assert.equal(
      getFamilyMetadata('openai').revocationUrl,
      'https://platform.openai.com/api-keys'
    )
  })
})

// ---------------------------------------------------------------------------
// Severity hints for billing-impact families
// ---------------------------------------------------------------------------
describe('severity hints', () => {
  const criticalFamilies = ['anthropic', 'openai', 'aws_akid', 'aws_session', 'stripe_live', 'sendgrid']
  for (const family of criticalFamilies) {
    it(`${family}: severityHint is 'critical'`, () => {
      assert.equal(getFamilyMetadata(family).severityHint, 'critical')
    })
  }

  const highFamilies = ['github_pat', 'slack', 'atlassian', 'langsmith']
  for (const family of highFamilies) {
    it(`${family}: severityHint is 'high'`, () => {
      assert.equal(getFamilyMetadata(family).severityHint, 'high')
    })
  }

  const mediumFamilies = ['jwt', 'high_entropy', 'custom']
  for (const family of mediumFamilies) {
    it(`${family}: severityHint is 'medium'`, () => {
      assert.equal(getFamilyMetadata(family).severityHint, 'medium')
    })
  }
})

// ---------------------------------------------------------------------------
// Generic fallback for unknown family IDs
// ---------------------------------------------------------------------------
describe('generic fallback for unknown family IDs', () => {
  it('bare unknown ID returns a non-null fallback object', () => {
    const meta = getFamilyMetadata('foobar')
    assert.ok(meta !== null && typeof meta === 'object')
    assert.ok(typeof meta.displayName === 'string' && meta.displayName.length > 0)
    assert.ok(typeof meta.revocationUrl === 'string' && meta.revocationUrl.startsWith('https://'))
    assert.ok(['low', 'medium', 'high', 'critical'].includes(meta.severityHint))
  })

  it('scrubber.foobar returns the generic fallback (not null, not throw)', () => {
    let meta
    assert.doesNotThrow(() => { meta = getFamilyMetadata('scrubber.foobar') },
      'getFamilyMetadata must never throw for any input')
    assert.ok(meta !== null && typeof meta === 'object')
    assert.ok(typeof meta.displayName === 'string')
  })

  it('null/undefined input returns fallback without throwing', () => {
    assert.doesNotThrow(() => getFamilyMetadata(null))
    assert.doesNotThrow(() => getFamilyMetadata(undefined))
    assert.doesNotThrow(() => getFamilyMetadata())
  })

  it('empty string input returns fallback without throwing', () => {
    const meta = getFamilyMetadata('')
    assert.ok(meta !== null && typeof meta === 'object')
  })

  it('fallback displayName is "Unknown secret"', () => {
    assert.equal(getFamilyMetadata('scrubber.foobar').displayName, 'Unknown secret')
  })

  it('fallback severityHint is "medium"', () => {
    assert.equal(getFamilyMetadata('foobar').severityHint, 'medium')
  })
})

// ---------------------------------------------------------------------------
// No mutation of returned objects
// ---------------------------------------------------------------------------
describe('returned objects are frozen (immutable)', () => {
  it('attempting to mutate a returned metadata object does not throw but has no effect', () => {
    const meta = getFamilyMetadata('github_pat')
    const originalUrl = meta.revocationUrl
    // In strict mode, assigning to a frozen property throws in normal code,
    // but we are testing that the module itself returns frozen objects.
    try { meta.revocationUrl = 'https://evil.example.com' } catch {}
    assert.equal(meta.revocationUrl, originalUrl,
      'revocationUrl must remain unchanged after attempted mutation')
  })
})
