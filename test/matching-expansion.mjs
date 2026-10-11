// v1.17: stem + synonym + CJK→EN expansion makes skill_search match across
// word-form, synonym, and language boundaries that the old pure-lexical .includes()
// could not bridge. Each test creates a fixture whose skills are only reachable
// through expansion — a flat .includes('debugging') would miss a skill named "debug".
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSkillRouterTools } from '../host.js'
import { makeExec, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

// A fixture with skills that only match through expansion:
//   - "debug"               ← query "debugging" (stem: -ing)
//   - "release-notes"       ← query "deploy"    (synonym: deploy→release)
//   - "performance-tuning"  ← query "性能"      (CJK→EN: 性能→performance)
//   - "code-review"         ← query "审查"      (CJK→EN: 审查→review)
function makeExpansionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-router-expand-'))
  const skills = [
    { repo: 'x', relpath: 'skills/debug', name: 'debug', description: 'Systematic debugging of failures.' },
    { repo: 'x', relpath: 'skills/release-notes', name: 'release-notes', description: 'Write release notes and publish.' },
    { repo: 'x', relpath: 'skills/performance-tuning', name: 'performance-tuning', description: 'Optimize application performance.' },
    { repo: 'x', relpath: 'skills/code-review', name: 'code-review', description: 'Review code for quality and security.' },
  ]
  const indexDir = join(root, '.skill-src')
  mkdirSync(indexDir, { recursive: true })
  const rows = ['"repo"\t"relpath"\t"name"\t"description"\t"files"\t"KB"\t"whenToUse"']
  for (const skill of skills) {
    const dir = join(indexDir, skill.repo, skill.relpath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nBody.\n`, 'utf8')
    rows.push([skill.repo, skill.relpath, skill.name, skill.description, '1', '1', ''].map((c) => `"${c}"`).join('\t'))
  }
  writeFileSync(join(indexDir, 'skill-index.tsv'), rows.join('\r\n'), 'utf8')
  return root
}

const root = makeExpansionFixture()
const tools = new Map()
buildSkillRouterTools(makeFsContext(root), (name, tool) => tools.set(name, tool))
const search = tools.get('skill_search')
const exec = makeExec(root)

// --- stem: "debugging" → stem "debug" → matches skill named "debug" ---
const stemResult = await search.execute({ query: 'debugging' }, exec)
check('stem: "debugging" finds skill named "debug"', stemResult.total > 0 && stemResult.hits.some((h) => h.name === 'debug'), JSON.stringify({ total: stemResult.total, names: stemResult.hits.map((h) => h.name) }))

// --- synonym: "deploy" → syn "release" → matches "release-notes" ---
const synResult = await search.execute({ query: 'deploy' }, exec)
check('synonym: "deploy" finds "release-notes" via deploy→release', synResult.total > 0 && synResult.hits.some((h) => h.name === 'release-notes'), JSON.stringify({ total: synResult.total, names: synResult.hits.map((h) => h.name) }))

// --- CJK→EN: "性能" → en "performance" → matches "performance-tuning" ---
const cjkResult = await search.execute({ query: '性能' }, exec)
check('CJK→EN: "性能" finds "performance-tuning" via 性能→performance', cjkResult.total > 0 && cjkResult.hits.some((h) => h.name === 'performance-tuning'), JSON.stringify({ total: cjkResult.total, names: cjkResult.hits.map((h) => h.name) }))

// --- CJK→EN: "审查" → en "review" → matches "code-review" ---
const cjkResult2 = await search.execute({ query: '审查' }, exec)
check('CJK→EN: "审查" finds "code-review" via 审查→review', cjkResult2.total > 0 && cjkResult2.hits.some((h) => h.name === 'code-review'), JSON.stringify({ total: cjkResult2.total, names: cjkResult2.hits.map((h) => h.name) }))

// --- regression: exact word still works (no expansion needed) ---
const exactResult = await search.execute({ query: 'debug' }, exec)
check('regression: exact "debug" still finds "debug"', exactResult.total > 0 && exactResult.hits.some((h) => h.name === 'debug'))

if (problems.length > 0) {
  console.log('FAIL ' + problems.length + ' checks failed')
  process.exitCode = 1
} else {
  console.log('all ok')
}
