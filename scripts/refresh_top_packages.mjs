/**
 * scripts/refresh_top_packages.mjs
 *
 * Refreshes the bundled top-500 package-name lists used by the
 * sentinel-investigator agent for typosquat distance checks.
 *
 * Upstream sources (chosen for stability and machine-readable formats):
 *
 *   npm   — https://raw.githubusercontent.com/anvaka/npm-rank/master/data/popular.txt
 *            Community-maintained static ranking; one package name per line.
 *            Caveat: last updated on the maintainer's own schedule; not real-time.
 *            Fallback if the file is unavailable: the existing seed list in
 *            src/sentinel/data/top_packages_npm.json is left unchanged.
 *            Alternative considered: registry.npmjs.org does not expose a
 *            top-N downloads endpoint for arbitrary date ranges without an
 *            API key; the anvaka list is the best public alternative.
 *
 *   pypi  — https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json
 *            Canonical source, rebuilt daily from PyPI BigQuery public dataset.
 *            Schema: { rows: [{ project: string, download_count: number }, ...] }
 *            Takes the top 500 rows by existing sort order (pre-sorted descending).
 *
 *   crates — https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=N
 *            Official crates.io API, paginated. Pages 1–5 = 500 entries.
 *            Requires a polite User-Agent header per crates.io crawler policy.
 *
 * Run:   node scripts/refresh_top_packages.mjs
 *         make refresh-data
 *         npm run refresh-data
 */

import { writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'src', 'sentinel', 'data')

const TIMEOUT_MS = 15_000
const UA = 'claude-code-sentinel-refresh (https://github.com/gltorres/claude-code-sentinel)'

/** Normalise a raw string array: lowercase, dedup via Set, sort ascending, truncate to 500. */
function normalise (raw) {
  return [...new Set(raw.map(s => s.toLowerCase().trim()).filter(Boolean))]
    .sort()
    .slice(0, 500)
}

/** Atomically write a JSON array to `finalPath` via a .tmp side file. */
function atomicWrite (finalPath, arr) {
  const tmp = finalPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8')
  renameSync(tmp, finalPath)
}

// ─── npm fetcher ─────────────────────────────────────────────────────────────

async function fetchNpm () {
  const url = 'https://raw.githubusercontent.com/anvaka/npm-rank/master/data/popular.txt'
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`npm-rank fetch failed: HTTP ${res.status}`)
  const text = await res.text()
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

// ─── PyPI fetcher ─────────────────────────────────────────────────────────────

async function fetchPypi () {
  const url = 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json'
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`PyPI fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  // data.rows is pre-sorted descending by download_count
  return data.rows.slice(0, 500).map(r => r.project)
}

// ─── crates.io fetcher ────────────────────────────────────────────────────────

async function fetchCrates () {
  const names = []
  for (let page = 1; page <= 5; page++) {
    const url = `https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${page}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) throw new Error(`crates.io fetch failed on page ${page}: HTTP ${res.status}`)
    const data = await res.json()
    for (const c of data.crates) names.push(c.name)
  }
  return names
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  // npm
  const npmRaw = await fetchNpm()
  const npmList = normalise(npmRaw)
  atomicWrite(join(DATA_DIR, 'top_packages_npm.json'), npmList)
  console.log(`npm: ${npmList.length} entries written`)

  // PyPI
  const pypiRaw = await fetchPypi()
  const pypiList = normalise(pypiRaw)
  atomicWrite(join(DATA_DIR, 'top_packages_pypi.json'), pypiList)
  console.log(`pypi: ${pypiList.length} entries written`)

  // crates.io
  const cratesRaw = await fetchCrates()
  const cratesList = normalise(cratesRaw)
  atomicWrite(join(DATA_DIR, 'top_packages_crates.json'), cratesList)
  console.log(`crates: ${cratesList.length} entries written`)
} catch (err) {
  console.error('refresh_top_packages: fatal error:', err.message)
  process.exit(1)
}
