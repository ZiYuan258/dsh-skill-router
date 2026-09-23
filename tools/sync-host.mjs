#!/usr/bin/env node
// Keep a second checkout of host.js in step with this one.
//
// Why this exists: host.js was once edited in two places at once (the deployed package
// and a dev checkout) and the two silently diverged — one copy went a whole edit behind,
// and a test run against that copy "passed" a state the package never had. Editing one
// file and copying is the fix; this is the copy.
//
// This package copy is the authority. Point the mirror at wherever you keep the second
// checkout:
//
//   SKILL_ROUTER_DEV_DIR=/path/to/dev-copy node tools/sync-host.mjs
//   SKILL_ROUTER_DEV_DIR=/path/to/dev-copy node tools/sync-host.mjs --check
//
// With no environment variable it looks for `../dsh-skill-router-dev`. `--check` exits 1
// on drift, so CI or a pre-commit hook can refuse a split brain.
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const authority = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'host.js')
const devDir = process.env.SKILL_ROUTER_DEV_DIR ?? resolve(dirname(authority), '..', 'dsh-skill-router-dev')
const mirror = join(devDir, 'host.js')
const checkOnly = process.argv.includes('--check')

if (!existsSync(authority)) {
  console.error('authority host.js not found: ' + authority)
  process.exit(1)
}
if (!existsSync(mirror)) {
  console.error('mirror host.js not found: ' + mirror)
  console.error('set SKILL_ROUTER_DEV_DIR to the directory holding the second checkout')
  process.exit(1)
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const before = { authority: digest(authority), mirror: digest(mirror) }

if (before.authority === before.mirror) {
  console.log('in sync — ' + before.authority.slice(0, 12))
  process.exit(0)
}

if (checkOnly) {
  console.error('DRIFT: the two host.js copies differ')
  console.error('  authority ' + before.authority.slice(0, 12) + ' -> ' + authority)
  console.error('  mirror    ' + before.mirror.slice(0, 12) + ' -> ' + mirror)
  console.error('run without --check to copy the authority over the mirror')
  process.exit(1)
}

copyFileSync(authority, mirror)
console.log('synced ' + before.mirror.slice(0, 12) + ' -> ' + digest(mirror).slice(0, 12) + ' (authority -> mirror)')
