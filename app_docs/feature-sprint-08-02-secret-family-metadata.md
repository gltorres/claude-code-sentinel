# Secret Family Metadata Module

**Task ID:** sprint-08-spec-02
**Date:** 2026-05-10
**Specification:** specs/sprint-08-investigator-agent/spec-02-secret-family-metadata.md

## Overview

Introduces `src/sentinel/secret-families.mjs`, a pure lookup module that maps a scrubber family ID to structured remediation metadata — display name, revocation URL, optional CLI hint, and severity classification. The module provides the `getFamilyMetadata` function consumed by the forensic investigator agent (spec-05) and any future tooling that needs authoritative, per-family revocation guidance without duplicating URLs or severity judgements across multiple files.

## What Was Built

- `src/sentinel/secret-families.mjs` — exports `getFamilyMetadata(ruleId)` with a frozen `FAMILY_METADATA` map covering all 13 scrubber families
- `tests/secret-families.test.mjs` — 40+ `it` blocks covering shape invariants, prefix stripping, PRD-required URL anchors, severity hints, unknown-ID fallback, and mutation guard

## Technical Implementation

### Files Modified

- `src/sentinel/secret-families.mjs`: New module; pure synchronous lookup with no I/O or external imports
- `tests/secret-families.test.mjs`: New `node:test` suite covering all 13 family IDs and edge cases

### Key Changes

- **`getFamilyMetadata(ruleId)`** accepts both bare family names (`'github_pat'`) and the audit-log-prefixed form (`'scrubber.github_pat'`), stripping the prefix before lookup; never throws, returns the generic fallback for any unrecognised ID
- **`FAMILY_METADATA`** is a frozen plain object with 13 entries — eleven hardcoded scrubber families (`anthropic`, `openai`, `github_pat`, `aws_akid`, `aws_session`, `slack`, `stripe_live`, `sendgrid`, `atlassian`, `langsmith`, `jwt`) plus `high_entropy` and `custom`; each entry is also individually frozen
- **Severity scale** — `critical` for live credentials with billing/exfiltration impact (`anthropic`, `openai`, `aws_akid`, `aws_session`, `stripe_live`, `sendgrid`); `high` for broad access tokens (`github_pat`, `slack`, `atlassian`, `langsmith`); `medium` for context-dependent or entropy-detected patterns (`jwt`, `high_entropy`, `custom`)
- **`aws_session` and `jwt` omit `revocationCli`** — AWS session tokens require source IAM role rotation (not a single CLI command); JWTs are stateless and require server-side denylist or key rotation
- **Six PRD-required URL anchors** are embedded verbatim: `github_pat → https://github.com/settings/tokens`, `aws_akid → https://console.aws.amazon.com/iam/home#/security_credentials`, `stripe_live → https://dashboard.stripe.com/apikeys`, `slack → https://api.slack.com/apps`, `anthropic → https://console.anthropic.com/settings/keys`, `openai → https://platform.openai.com/api-keys`

## How to Use

```js
import { getFamilyMetadata } from './src/sentinel/secret-families.mjs'

// Bare family name (from audit input_summary.family)
const meta = getFamilyMetadata('github_pat')
// → { displayName: 'GitHub Personal Access Token',
//     revocationUrl: 'https://github.com/settings/tokens',
//     revocationCli: 'gh auth logout',
//     severityHint: 'high' }

// Prefixed form (from audit rule field)
const same = getFamilyMetadata('scrubber.github_pat')
// Produces identical output — both forms are equivalent

// Unknown / custom extra-pattern family
const fallback = getFamilyMetadata('my_internal_token')
// → { displayName: 'Unknown secret',
//     revocationUrl: 'https://owasp.org/...',
//     severityHint: 'medium' }
```

The function is O(1): a single string prefix check followed by a property lookup on the frozen map. It contributes zero measurable latency to the hook's 300 ms budget.

## Configuration

No configuration required. The module is stateless and reads nothing from disk. User-named `extraPatterns` families (defined in `config/defaults.json` under `scrubber.extraPatterns`) fall through to the generic fallback — callers needing custom metadata for named extras must extend the lookup externally.

## Testing

```bash
node --test tests/secret-families.test.mjs   # run spec-02 suite only
node --test tests/                            # full suite (zero regressions)
make validate                                 # lint + full test + self-test
```

The test file covers: shape invariants for all 13 families, `scrubber.` prefix stripping for all 13 families, 7 exact URL anchor assertions, 13 severity hint assertions, 6 fallback edge cases (bare unknown, prefixed unknown, `null`, `undefined`, no-arg, empty string), and 1 mutation guard.

## Notes

- **`aws_session` severity is `critical`** — session tokens grant the same IAM access as the long-lived credential that generated them for their full TTL (often 1–12 hours), making the blast radius equivalent to `aws_akid` compromise
- **`sendgrid` severity is `critical`** — full-permission API keys enable phishing-scale email abuse on the account's verified domains, beyond mere billing impact
- **No import from `scrubber-families.mjs`** — the family ID strings are the public contract; importing the regex array would create unnecessary coupling to Sprint 06 internals
- **Family ID alignment is a manual contract** — if a future sprint adds a new family to `scrubber-families.mjs`, `secret-families.mjs` and `KNOWN_FAMILIES` in the test file must be updated in the same PR
- **No `low` severity is assigned** — the value is reserved; all current families have meaningful access scope
