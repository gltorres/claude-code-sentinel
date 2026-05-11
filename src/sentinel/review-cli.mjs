#!/usr/bin/env node
import os from 'node:os'
import process from 'node:process'
import { summariseByEventClass, tailAuditEntries } from './audit.mjs'
import { loadConfigWithSources } from './config.mjs'

function parseArgv(argv) {
  const [, , subcommand = '', ...args] = argv
  return { subcommand, args }
}

function* flattenLeaves(value, sources, prefix = '') {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    sources !== null &&
    typeof sources === 'object' &&
    !Array.isArray(sources)
  ) {
    for (const key of Object.keys(value)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key
      yield* flattenLeaves(value[key], sources[key], childPrefix)
    }
  } else {
    yield { path: prefix, value, source: sources ?? 'default' }
  }
}

async function cmdSummary(config) {
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  const counts = await summariseByEventClass({ config, sinceMs })
  const labels = ['block', 'ask', 'scrub', 'warn']
  for (const label of labels) {
    process.stdout.write(`${label.padEnd(6)}: ${counts[label] ?? 0}\n`)
  }
  process.stdout.write(`${'total'.padEnd(6)}: ${counts.total ?? 0}\n`)
}

async function cmdRecent(config, args) {
  const n = args[0] !== undefined ? parseInt(args[0], 10) : 20
  if (!Number.isFinite(n) || n < 1) {
    process.stderr.write(`sentinel-review-cli: recent requires a positive integer N\n`)
    process.exit(1)
  }
  const entries = await tailAuditEntries({ config, n })
  for (const entry of entries) {
    const ts = entry.ts ?? ''
    const event = entry.event ?? ''
    const rule = entry.rule ?? ''
    const matched = entry.matched ?? ''
    const inputSummary = JSON.stringify(entry.input_summary ?? {})
    process.stdout.write(`${ts} | ${event} | ${rule} | ${matched} | ${inputSummary}\n`)
  }
}

async function cmdConfig(home, cwd) {
  const { value, sources } = loadConfigWithSources({ home, cwd })
  const leaves = [...flattenLeaves(value, sources)]
  leaves.sort((a, b) => a.path.localeCompare(b.path))
  for (const leaf of leaves) {
    process.stdout.write(`${leaf.path} = ${JSON.stringify(leaf.value)} [${leaf.source}]\n`)
  }
}

async function main() {
  const { subcommand, args } = parseArgv(process.argv)

  const home = process.env.SENTINEL_HOME || os.homedir()
  const cwd = process.env.SENTINEL_CWD || process.cwd()

  const { value: config } = loadConfigWithSources({ home, cwd })

  switch (subcommand) {
    case 'summary':
      await cmdSummary(config)
      break
    case 'recent':
      await cmdRecent(config, args)
      break
    case 'config':
      await cmdConfig(home, cwd)
      break
    default:
      process.stderr.write(
        `sentinel-review-cli: unknown subcommand '${subcommand}'. ` +
        `Supported: summary, recent [N], config\n`
      )
      process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`sentinel-review-cli: ${err.message}\n`)
  process.exit(1)
})
