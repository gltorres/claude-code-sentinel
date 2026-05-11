// scrubber families — Sprint 06 + Sprint scrubber rebuild.

// Pre-compiled family regexes applied in fixed order.
// Tag format: <REDACTED:<family>>.
const FAMILY_REGEXES = Object.freeze([
  {
    family: 'anthropic',
    re: /sk-ant-[A-Za-z0-9_-]{32,}/g,
    tag: '<REDACTED:anthropic>',
  },
  {
    family: 'openai',
    // Legacy sk-<40+>, modern sk-proj-<32+>, sk-svcacct-<32+>, sk-admin-<32+>.
    // (?!ant-) lookahead preserves the anthropic guard.
    re: /sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    tag: '<REDACTED:openai>',
  },
  {
    family: 'github_pat',
    re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
    tag: '<REDACTED:github_pat>',
  },
  {
    family: 'aws_akid',
    re: /AKIA[0-9A-Z]{16}/g,
    tag: '<REDACTED:aws_akid>',
  },
  {
    family: 'aws_session',
    re: /aws_session_token=([^\s"'&;]+)/gi,
    tag: '<REDACTED:aws_session>',
  },
  {
    family: 'slack',
    re: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    tag: '<REDACTED:slack>',
  },
  {
    family: 'stripe_live',
    re: /sk_live_[A-Za-z0-9]{24,}/g,
    tag: '<REDACTED:stripe_live>',
  },
  {
    family: 'sendgrid',
    re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    tag: '<REDACTED:sendgrid>',
  },
  {
    family: 'atlassian',
    re: /ATATT3[A-Za-z0-9_-]{180,}/g,
    tag: '<REDACTED:atlassian>',
  },
  {
    family: 'langsmith',
    re: /lsv2_pt_[A-Za-z0-9]{32,}/g,
    tag: '<REDACTED:langsmith>',
  },
  {
    family: 'jwt',
    re: /eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=.+/-]+/g,
    tag: '<REDACTED:jwt>',
  },
  {
    family: 'google_api',
    re: /AIza[0-9A-Za-z_-]{35}/g,
    tag: '<REDACTED:google_api>',
  },
  {
    family: 'pem_private_key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    tag: '<REDACTED:pem_private_key>',
  },
  {
    family: 'bearer_header',
    // Authorization: Bearer <token> — capture group 1 = key prefix to keep.
    re: /([Aa]uthorization:\s*[Bb]earer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
    tag: '<REDACTED:bearer_header>',
  },
  {
    family: 'stripe_pk',
    re: /pk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    tag: '<REDACTED:stripe_pk>',
  },
  {
    family: 'stripe_rk',
    re: /rk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    tag: '<REDACTED:stripe_rk>',
  },
  {
    family: 'stripe_whsec',
    re: /whsec_[A-Za-z0-9]{32,}/g,
    tag: '<REDACTED:stripe_whsec>',
  },
  {
    family: 'postgres_url',
    // postgres://user:<password>@host — preserve scheme/user/host, redact password.
    re: /(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/g,
    tag: '<REDACTED:postgres_url>',
  },
  {
    family: 'npm_token',
    re: /npm_[A-Za-z0-9]{36}/g,
    tag: '<REDACTED:npm_token>',
  },
  {
    family: 'huggingface',
    re: /hf_[A-Za-z0-9]{34}/g,
    tag: '<REDACTED:huggingface>',
  },
])

const PRESERVE_PREFIX_FAMILIES = new Set(['aws_session', 'bearer_header', 'postgres_url'])

function countLinesUpTo(text, offset) {
  let n = 0
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function applyFamily(text, { family, re, tag }) {
  const instances = []
  re.lastIndex = 0
  if (!PRESERVE_PREFIX_FAMILIES.has(family)) {
    const out = text.replace(re, (match, ...rest) => {
      const offset = typeof rest[rest.length - 2] === 'number' ? rest[rest.length - 2] : 0
      instances.push({
        prefix: match.slice(0, 4),
        length: match.length,
        line: countLinesUpTo(text, offset) + 1,
      })
      return tag
    })
    return { text: out, instances }
  }
  const out = text.replace(re, (...args) => {
    // args: [match, g1, g2, ..., offset, full]
    const match = args[0]
    const offset = args[args.length - 2]
    instances.push({
      prefix: match.slice(0, 4),
      length: match.length,
      line: countLinesUpTo(text, offset) + 1,
    })
    if (family === 'aws_session') return `aws_session_token=${tag}`
    if (family === 'bearer_header') return `${args[1]}${tag}`
    if (family === 'postgres_url') return `${args[1]}${tag}${args[3]}`
    return tag
  })
  return { text: out, instances }
}

function applyExtra(text, entry) {
  let src, tag, name
  if (typeof entry === 'string') {
    src = entry
    tag = '<REDACTED:custom>'
    name = 'custom'
  } else if (entry && typeof entry === 'object' && entry.name && entry.pattern) {
    src = entry.pattern
    tag = `<REDACTED:${entry.name}>`
    name = entry.name
  } else {
    return { text, instances: [], name: null }
  }
  let re
  try {
    re = new RegExp(src, 'g')
  } catch {
    return { text, instances: [], name: null }
  }
  const instances = []
  const out = text.replace(re, (match, ...rest) => {
    const offset = typeof rest[rest.length - 2] === 'number' ? rest[rest.length - 2] : 0
    instances.push({
      prefix: match.slice(0, 4),
      length: match.length,
      line: countLinesUpTo(text, offset) + 1,
    })
    return tag
  })
  return { text: out, instances, name }
}

// Scan `text` for all hardcoded credential families and any `extraPatterns`.
// Returns:
//   { text: <scrubbed string>,
//     redactions: [{ family, count, instances: [{prefix,length,line}] }, ...] }
export function scrubFamilies(text, extraPatterns) {
  let working = String(text ?? '')
  const redactions = []

  for (const entry of FAMILY_REGEXES) {
    const { text: next, instances } = applyFamily(working, entry)
    working = next
    if (instances.length > 0) {
      redactions.push({ family: entry.family, count: instances.length, instances })
    }
  }

  if (Array.isArray(extraPatterns)) {
    for (const entry of extraPatterns) {
      const { text: next, instances, name } = applyExtra(working, entry)
      if (instances.length > 0) {
        redactions.push({ family: name, count: instances.length, instances })
        working = next
      }
    }
  }

  return { text: working, redactions }
}
