// Per-tool textual-field extraction for PostToolUse scrubbing.
// Returns { text, skip } — when skip is true, callers should treat the
// response as out-of-scope for scrubbing (e.g. lockfiles, sourcemaps).

const DEFAULT_SKIP_PATH_GLOBS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
]

function matchGlob(path, glob) {
  const re = '^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*') + '$'
  try { return new RegExp(re).test(path) } catch { return false }
}

export function extractScrubInput(toolName, response, skipPaths = DEFAULT_SKIP_PATH_GLOBS) {
  if (response == null) return { text: '', skip: false }
  if (typeof response === 'string') return { text: response, skip: false }

  if (toolName === 'Read' || toolName === 'NotebookEdit') {
    const fp = response.file?.filePath ?? response.filePath ?? ''
    if (fp && skipPaths.some(g => matchGlob(fp, g))) return { text: '', skip: true }
    return { text: response.file?.content ?? response.content ?? '', skip: false }
  }

  if (toolName === 'Bash') {
    const parts = [response.stdout, response.stderr].filter(s => typeof s === 'string')
    return { text: parts.join('\n'), skip: false }
  }

  if (toolName === 'Grep') {
    const c = response.content
    return { text: typeof c === 'string' ? c : (response.matches ? JSON.stringify(response.matches) : ''), skip: false }
  }

  if (toolName === 'Edit' || toolName === 'Write') return { text: '', skip: true }

  try { return { text: JSON.stringify(response), skip: false } } catch { return { text: '', skip: false } }
}

export { DEFAULT_SKIP_PATH_GLOBS }
