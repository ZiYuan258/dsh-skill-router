// The index is written by PowerShell's Export-Csv on the machine this was developed on,
// and that writer emits a UTF-8 BOM. The mark glues itself to the first header cell, so
// `repo === 'repo'` was compared against `\uFEFF"repo"` and never matched — turning the
// header line into a skill named `name`, living at `\uFEFF"repo/relpath/SKILL.md". Search
// returned it; load then reported it missing.
//
// Every writer shape is tested here, because the header is recognized by shape and each
// of these is a real thing a CSV writer does.
import { buildSkillRouterTools } from '../host.js'
import { dropFixture, makeExec, makeFsContext, makeFixture } from './helpers.mjs'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

const root = makeFixture()
const tools = new Map()
buildSkillRouterTools(makeFsContext(root), (name, tool) => tools.set(name, tool))
const search = tools.get('skill_search')
const load = tools.get('skill_load')
const exec = makeExec(root)

const writes = await import('node:fs')
const { join } = await import('node:path')
const indexPath = join(root, '.skill-src', 'skill-index.tsv')
const realRows = writes.readFileSync(indexPath, 'utf8').split('\r\n')
const header = realRows[0]
const body = realRows.slice(1).join('\r\n')

const variants = [
  { label: 'quoted header', text: header + '\r\n' + body },
  { label: 'unquoted header', text: header.replace(/"/g, '') + '\r\n' + body },
  { label: 'BOM-prefixed header', text: '\uFEFF' + header + '\r\n' + body },
  { label: 'BOM with an unquoted header', text: '\uFEFF' + header.replace(/"/g, '') + '\r\n' + body },
  { label: 'BOM and LF-only line endings', text: '\uFEFF' + header.replace(/"/g, '') + '\n' + body.replace(/\r\n/g, '\n') },
]

for (const variant of variants) {
  writes.writeFileSync(indexPath, variant.text, 'utf8')
  const result = await search.execute({ query: 'name', limit: 40 }, exec)
  const phantom = result.hits.filter((hit) => hit.name === 'name' || /\uFEFF/.test(JSON.stringify(hit)))
  check(variant.label + ': the header is not a skill row', phantom.length === 0, JSON.stringify(phantom.map((h) => h.name)))
  check(variant.label + ': nothing carries a BOM into a name or repo', !/\uFEFF/.test(JSON.stringify(result.hits)))
  const byName = await load.execute({ name: 'name' }, exec)
  check(variant.label + ': a skill named "name" does not exist', String(byName.loaded) === '', String(byName.loaded))
}

// And the rows themselves must still parse, or the fix would be "no rows at all".
writes.writeFileSync(indexPath, '\uFEFF' + header + '\r\n' + body, 'utf8')
const after = await search.execute({ query: 'gamma triggers' }, exec)
check('a BOM-prefixed index still yields its real rows', after.hits.some((hit) => hit.name === 'gamma-triggers'), JSON.stringify(after.hits.map((h) => h.name)))

dropFixture(root)
console.log(problems.length === 0 ? 'index header: OK' : 'index header FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
