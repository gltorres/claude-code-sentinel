// Registry clients — Sprint 05.
// Per-ecosystem fetch helpers that normalise registry responses into a
// uniform metadata shape.  Accepts an injected fetchFn for testability.
// Never throws: all errors are converted to { status: 'error' }.
//
// Exported:
//   fetchPackageMetadata({ ecosystem, name, fetchFn, timeoutMs })
//     → Promise<{ status: 'ok'|'not_found'|'error',
//                 meta?: { ageDays: number,
//                          weeklyDownloads: number|null,
//                          hasHomepage: boolean,
//                          hasRepository: boolean } }>

// ── Helper ────────────────────────────────────────────────────────────────────

// Compute age in whole days from an ISO-8601 creation timestamp.
function ageFromIso(isoString) {
  return Math.floor((Date.now() - new Date(isoString).getTime()) / 86_400_000)
}

// ── Per-ecosystem helpers ─────────────────────────────────────────────────────

async function fetchNpm(name, fetchFn, timeoutMs) {
  try {
    // Primary: package document
    const pkgUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`
    const pkgRes = await fetchFn(pkgUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (pkgRes.status === 404) return { status: 'not_found' }
    if (!pkgRes.ok)            return { status: 'error' }
    const pkg = await pkgRes.json()

    const createdIso    = pkg.time && pkg.time.created
    const ageDays       = createdIso ? ageFromIso(createdIso) : 0
    const hasHomepage   = Boolean(pkg.homepage)
    const hasRepository = Boolean(pkg.repository)

    // Secondary: weekly downloads (fail-soft — null on any error)
    let weeklyDownloads = null
    try {
      const dlUrl = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`
      const dlRes = await fetchFn(dlUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (dlRes.ok) {
        const dl = await dlRes.json()
        if (typeof dl.downloads === 'number') weeklyDownloads = dl.downloads
      }
    } catch { /* downloads unavailable — leave weeklyDownloads: null */ }

    return { status: 'ok', meta: { ageDays, weeklyDownloads, hasHomepage, hasRepository } }
  } catch {
    return { status: 'error' }
  }
}

async function fetchPyPI(name, fetchFn, timeoutMs) {
  try {
    // Primary: package JSON
    const pkgUrl = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
    const pkgRes = await fetchFn(pkgUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (pkgRes.status === 404) return { status: 'not_found' }
    if (!pkgRes.ok)            return { status: 'error' }
    const pkg = await pkgRes.json()

    const info = pkg.info || {}

    // Earliest release upload time — prefer pkg.releases (full history), fall back to pkg.urls
    let ageDays = 0
    const releases = pkg.releases || {}
    let earliest = null
    for (const files of Object.values(releases)) {
      if (!Array.isArray(files)) continue
      for (const f of files) {
        if (f.upload_time_iso_8601 && (!earliest || f.upload_time_iso_8601 < earliest)) {
          earliest = f.upload_time_iso_8601
        }
      }
    }
    if (!earliest && Array.isArray(pkg.urls)) {
      for (const f of pkg.urls) {
        if (f.upload_time_iso_8601 && (!earliest || f.upload_time_iso_8601 < earliest)) {
          earliest = f.upload_time_iso_8601
        }
      }
    }
    if (earliest) ageDays = ageFromIso(earliest)

    const hasHomepage = Boolean(info.home_page)
    const projectUrls = info.project_urls || {}
    const repoKeys    = ['Repository', 'Source', 'Source Code', 'Code', 'GitHub']
    const hasRepository = repoKeys.some(k => Boolean(projectUrls[k]))

    // Secondary: weekly downloads via pypistats.org (fail-soft)
    let weeklyDownloads = null
    try {
      const statsName = encodeURIComponent((name || '').toLowerCase())
      const statsUrl  = `https://pypistats.org/api/packages/${statsName}/recent?period=week`
      const statsRes  = await fetchFn(statsUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (statsRes.ok) {
        const stats = await statsRes.json()
        if (stats.data && typeof stats.data.last_week === 'number') {
          weeklyDownloads = stats.data.last_week
        }
      }
    } catch { /* stats unavailable — leave weeklyDownloads: null */ }

    return { status: 'ok', meta: { ageDays, weeklyDownloads, hasHomepage, hasRepository } }
  } catch {
    return { status: 'error' }
  }
}

async function fetchCrates(name, fetchFn, timeoutMs) {
  try {
    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { status: 'not_found' }
    if (!res.ok)            return { status: 'error' }
    const json = await res.json()

    const crate         = json.crate || {}
    const ageDays       = crate.created_at ? ageFromIso(crate.created_at) : 0
    const hasHomepage   = Boolean(crate.homepage)
    const hasRepository = Boolean(crate.repository)
    // crates.io has no weekly-download granularity; policy skips rule 3 for null
    const weeklyDownloads = null

    return { status: 'ok', meta: { ageDays, weeklyDownloads, hasHomepage, hasRepository } }
  } catch {
    return { status: 'error' }
  }
}

// ── Exported dispatcher ───────────────────────────────────────────────────────

// Fetch normalised package metadata from the appropriate registry.
//
// Parameters:
//   ecosystem  {string}   — 'npm' | 'pypi' | 'crates'
//   name       {string}   — package name (may include scope, e.g. '@org/pkg')
//   fetchFn    {Function} — fetch-compatible function; injected for testability
//   timeoutMs  {number}   — per-request abort timeout in milliseconds
//
// Returns:
//   Promise<{ status: 'ok' | 'not_found' | 'error',
//             meta?: { ageDays: number,
//                      weeklyDownloads: number|null,
//                      hasHomepage: boolean,
//                      hasRepository: boolean } }>
export async function fetchPackageMetadata({ ecosystem, name, fetchFn, timeoutMs }) {
  switch (ecosystem) {
    case 'npm':    return fetchNpm(name, fetchFn, timeoutMs)
    case 'pypi':   return fetchPyPI(name, fetchFn, timeoutMs)
    case 'crates': return fetchCrates(name, fetchFn, timeoutMs)
    default:       return { status: 'error' }
  }
}
