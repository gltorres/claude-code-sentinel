// install-commands tests — Sprint 05.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstallSegments } from '../src/sentinel/install-commands.mjs'

// ── Test helper ───────────────────────────────────────────────────────────────

// Build a minimal walked object from a simple (non-compound) command string.
// Splits on the first whitespace run: first token is command, rest are args.
// Does NOT call bash-walker — keeps this test file self-contained.
function seg(commandLine) {
  const parts = commandLine.trim().split(/\s+/)
  const command = parts[0] ?? ''
  const args = parts.slice(1)
  return {
    exotic: false,
    segments: [{ command, args, redirects: [], raw: commandLine.trim() }],
  }
}

const ALL_ECO = { ecosystems: { npm: true, pypi: true, crates: true } }

// ── Each of the 6 install command families ────────────────────────────────────

test('npm install <pkg> yields one npm entry', () => {
  const r = parseInstallSegments(seg('npm install lodash'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'npm')
  assert.equal(r[0].name, 'lodash')
})

test('npm i <pkg> shorthand also yields npm entry', () => {
  const r = parseInstallSegments(seg('npm i express'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'npm')
  assert.equal(r[0].name, 'express')
})

test('pnpm add <pkg> yields npm entry', () => {
  const r = parseInstallSegments(seg('pnpm add axios'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'npm')
  assert.equal(r[0].name, 'axios')
})

test('yarn add <pkg> yields npm entry', () => {
  const r = parseInstallSegments(seg('yarn add react'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'npm')
  assert.equal(r[0].name, 'react')
})

test('pip install <pkg> yields pypi entry', () => {
  const r = parseInstallSegments(seg('pip install requests'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'pypi')
  assert.equal(r[0].name, 'requests')
})

test('pip3 install <pkg> also yields pypi entry', () => {
  const r = parseInstallSegments(seg('pip3 install flask'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'pypi')
  assert.equal(r[0].name, 'flask')
})

test('uv add <pkg> yields pypi entry', () => {
  const r = parseInstallSegments(seg('uv add httpx'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'pypi')
  assert.equal(r[0].name, 'httpx')
})

test('cargo add <pkg> yields crates entry', () => {
  const r = parseInstallSegments(seg('cargo add serde'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].ecosystem, 'crates')
  assert.equal(r[0].name, 'serde')
})

// ── Scoped npm packages (trap #4) ─────────────────────────────────────────────

test('scoped npm package @org/pkg is preserved intact', () => {
  const r = parseInstallSegments(seg('npm install @babel/core'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].name, '@babel/core')
})

test('scoped npm with version @org/pkg@2.0 strips version after inner @', () => {
  const r = parseInstallSegments(seg('npm install @types/node@18'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].name, '@types/node')
})

// ── Version specifiers stripped (trap #6) ─────────────────────────────────────

test('npm package with @version: react@18 → react', () => {
  const r = parseInstallSegments(seg('npm install react@18'), ALL_ECO)
  assert.equal(r[0].name, 'react')
})

test('pip package with ==: lodash==4.0.0 → lodash (double-equals)', () => {
  // pip uses == but so does setuptools; verify == (which contains =) is split.
  const r = parseInstallSegments(seg('pip install lodash==4.0.0'), ALL_ECO)
  assert.equal(r[0].name, 'lodash')
})

test('pip package with >=: requests>=2.0 → requests', () => {
  const r = parseInstallSegments(seg('pip install requests>=2.0'), ALL_ECO)
  assert.equal(r[0].name, 'requests')
})

test('pip package with extras: pkg[extra1] → pkg', () => {
  const r = parseInstallSegments(seg('pip install uvicorn[standard]'), ALL_ECO)
  assert.equal(r[0].name, 'uvicorn')
})

test('pip package with ~=: pkg~=1.0 → pkg', () => {
  const r = parseInstallSegments(seg('pip install django~=4.2'), ALL_ECO)
  assert.equal(r[0].name, 'django')
})

// ── Flags before name (trap #9) ───────────────────────────────────────────────

test('npm install --save-dev typescript: flag stripped, name kept', () => {
  const r = parseInstallSegments(seg('npm install --save-dev typescript'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'typescript')
})

test('pip install --user requests: flag stripped, name kept', () => {
  const r = parseInstallSegments(seg('pip install --user requests'), ALL_ECO)
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'requests')
})

// ── Multiple packages in one command ──────────────────────────────────────────

test('npm install lodash react axios: three entries returned', () => {
  const r = parseInstallSegments(seg('npm install lodash react axios'), ALL_ECO)
  assert.equal(r.length, 3)
  assert.deepEqual(r.map(e => e.name), ['lodash', 'react', 'axios'])
  for (const e of r) assert.equal(e.ecosystem, 'npm')
})

// ── Ecosystem toggle off ───────────────────────────────────────────────────────

test('ecosystems.npm: false → npm install yields no entries', () => {
  const r = parseInstallSegments(
    seg('npm install lodash'),
    { ecosystems: { npm: false, pypi: true, crates: true } }
  )
  assert.equal(r.length, 0)
})

test('ecosystems.pypi: false → pip install yields no entries, npm still works', () => {
  const opts = { ecosystems: { npm: true, pypi: false, crates: true } }
  const pip = parseInstallSegments(seg('pip install requests'), opts)
  assert.equal(pip.length, 0)
  const npm = parseInstallSegments(seg('npm install lodash'), opts)
  assert.equal(npm.length, 1)
})

test('ecosystems.crates: false → cargo add yields no entries', () => {
  const r = parseInstallSegments(
    seg('cargo add serde'),
    { ecosystems: { npm: true, pypi: true, crates: false } }
  )
  assert.equal(r.length, 0)
})

// ── Non-install segments → empty result ───────────────────────────────────────

test('cat .env is not an install command → empty result', () => {
  const r = parseInstallSegments(seg('cat .env'), ALL_ECO)
  assert.equal(r.length, 0)
})

test('git push is not an install command → empty result', () => {
  const r = parseInstallSegments(seg('git push'), ALL_ECO)
  assert.equal(r.length, 0)
})

// ── exotic: true → empty result ───────────────────────────────────────────────

test('walked.exotic === true → returns empty regardless of segments', () => {
  const walked = { exotic: true, segments: [] }
  const r = parseInstallSegments(walked, ALL_ECO)
  assert.equal(r.length, 0)
})

// ── Bare install with no positional args (traps #7 and #8) ───────────────────

test('bare npm install (reads package.json) → empty result', () => {
  const r = parseInstallSegments(seg('npm install'), ALL_ECO)
  assert.equal(r.length, 0)
})

test('pip install -r requirements.txt → no package entries (file-driven)', () => {
  const r = parseInstallSegments(seg('pip install -r requirements.txt'), ALL_ECO)
  assert.equal(r.length, 0)
})
