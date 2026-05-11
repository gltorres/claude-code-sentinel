// secret-families — Sprint 08, Spec 02.
//
// Maps a scrubber family ID (bare or 'scrubber.'-prefixed) to structured
// remediation metadata for use by the Sentinel investigator agent (spec-05)
// and any future tooling that needs per-family revocation guidance.
//
// Family IDs mirror those emitted by src/sentinel/scrubber-families.mjs and
// src/sentinel/scrubber-entropy.mjs. This module does NOT import from those
// files — the ID strings are the public contract; the regex array is not.
//
// severityHint scale:
//   critical — live credential with direct billing/data-exfiltration impact
//   high     — access token granting broad repository or service access
//   medium   — dependent-on-context credential or entropy-detected pattern
//   low      — (reserved; no current family warrants this rating)

const GENERIC_FALLBACK = Object.freeze({
  displayName: 'Unknown secret',
  revocationUrl: 'https://owasp.org/www-community/vulnerabilities/Insecure_Storage_of_Sensitive_Information',
  severityHint: 'medium',
})

// Each entry is frozen so callers cannot accidentally mutate canonical records.
const FAMILY_METADATA = Object.freeze({
  anthropic: Object.freeze({
    displayName: 'Anthropic API key',
    revocationUrl: 'https://console.anthropic.com/settings/keys',
    revocationCli: 'open https://console.anthropic.com/settings/keys',
    severityHint: 'critical',
  }),

  openai: Object.freeze({
    displayName: 'OpenAI API key',
    revocationUrl: 'https://platform.openai.com/api-keys',
    revocationCli: 'open https://platform.openai.com/api-keys',
    severityHint: 'critical',
  }),

  github_pat: Object.freeze({
    displayName: 'GitHub Personal Access Token',
    revocationUrl: 'https://github.com/settings/tokens',
    revocationCli: 'gh auth logout',
    severityHint: 'high',
  }),

  aws_akid: Object.freeze({
    displayName: 'AWS Access Key ID',
    revocationUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    revocationCli: 'aws iam delete-access-key --access-key-id <KEY_ID>',
    severityHint: 'critical',
  }),

  aws_session: Object.freeze({
    displayName: 'AWS Session Token',
    revocationUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    // Session tokens expire naturally; revoking requires invalidating the STS role session.
    // Direct AWS CLI revocation of a session token is not supported; rotate the source role.
    severityHint: 'critical',
  }),

  slack: Object.freeze({
    displayName: 'Slack OAuth / Bot token',
    revocationUrl: 'https://api.slack.com/apps',
    revocationCli: 'open https://api.slack.com/apps',
    severityHint: 'high',
  }),

  stripe_live: Object.freeze({
    displayName: 'Stripe live secret key',
    revocationUrl: 'https://dashboard.stripe.com/apikeys',
    revocationCli: 'open https://dashboard.stripe.com/apikeys',
    severityHint: 'critical',
  }),

  sendgrid: Object.freeze({
    displayName: 'SendGrid API key',
    revocationUrl: 'https://app.sendgrid.com/settings/api_keys',
    revocationCli: 'open https://app.sendgrid.com/settings/api_keys',
    severityHint: 'critical',
  }),

  atlassian: Object.freeze({
    displayName: 'Atlassian API token',
    revocationUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    revocationCli: 'open https://id.atlassian.com/manage-profile/security/api-tokens',
    severityHint: 'high',
  }),

  langsmith: Object.freeze({
    displayName: 'LangSmith API key',
    revocationUrl: 'https://smith.langchain.com/settings',
    revocationCli: 'open https://smith.langchain.com/settings',
    severityHint: 'high',
  }),

  jwt: Object.freeze({
    displayName: 'JSON Web Token (JWT)',
    revocationUrl: 'https://owasp.org/www-community/vulnerabilities/Insecure_Storage_of_Sensitive_Information',
    // JWTs are stateless by design; revocation requires server-side denylist or
    // key rotation. No universal CLI command exists.
    severityHint: 'medium',
  }),

  high_entropy: Object.freeze({
    displayName: 'High-entropy string (possible secret)',
    revocationUrl: 'https://owasp.org/www-community/vulnerabilities/Insecure_Storage_of_Sensitive_Information',
    // Family unknown — cannot provide a service-specific revocation command.
    severityHint: 'medium',
  }),

  custom: Object.freeze({
    displayName: 'Custom secret pattern',
    revocationUrl: 'https://owasp.org/www-community/vulnerabilities/Insecure_Storage_of_Sensitive_Information',
    // Revocation depends on the service that issued the credential.
    severityHint: 'medium',
  }),
})

// Return remediation metadata for a scrubber family.
//
// Parameters:
//   ruleId {string} — bare family name (e.g. 'github_pat') OR the audit-log
//                     prefixed form (e.g. 'scrubber.github_pat'). Both are
//                     accepted and produce identical output.
//
// Returns:
//   { displayName: string,
//     revocationUrl: string,
//     revocationCli?: string,
//     severityHint: 'low'|'medium'|'high'|'critical' }
//
// Never throws. Returns the generic fallback for any unrecognised family ID.
export function getFamilyMetadata(ruleId) {
  const bare =
    typeof ruleId === 'string' && ruleId.startsWith('scrubber.')
      ? ruleId.slice('scrubber.'.length)
      : String(ruleId ?? '')
  return FAMILY_METADATA[bare] ?? GENERIC_FALLBACK
}
