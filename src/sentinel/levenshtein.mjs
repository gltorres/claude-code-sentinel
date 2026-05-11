// Levenshtein edit distance and nearest-popular-package helper — Sprint 08, Spec 01.
// Pure two-row dynamic-programming implementation. Zero runtime dependencies.
// Used by the sentinel-investigator agent for typosquat distance checks.

/**
 * Compute the Levenshtein edit distance between two strings.
 * Returns 0 for identical strings; returns Math.max(a.length, b.length) when
 * one string is empty.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Integer edit distance ≥ 0
 */
export function levenshtein(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Two-row DP: prev holds costs for row i-1, curr for row i.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let curr = new Array(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      const del = prev[j] + 1
      const ins = curr[j - 1] + 1
      curr[j] = Math.min(sub, del, ins)
    }
    // Swap rows for next iteration
    ;[prev, curr] = [curr, prev]
  }

  return prev[b.length]
}

/**
 * Find the entry in `list` with the smallest Levenshtein distance to `name`.
 * Ties are broken by array order (first minimum wins).
 *
 * @param {string} name - The package name to test (e.g. a possibly-misspelled input)
 * @param {string[]} list - Candidate package names to compare against
 * @returns {{ name: string|null, distance: number }}
 *   `name` is null and `distance` is Infinity when `list` is empty.
 */
export function nearestPopular(name, list) {
  if (!list || list.length === 0) return { name: null, distance: Infinity }

  let best = { name: list[0], distance: levenshtein(name, list[0]) }
  for (let i = 1; i < list.length; i++) {
    const d = levenshtein(name, list[i])
    if (d < best.distance) {
      best = { name: list[i], distance: d }
    }
  }
  return best
}
