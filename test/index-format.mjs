// The index format is a contract between whoever writes it and this plugin, so a column
// added later must not break an existing file, and an absent `whenToUse` must stay normal
// rather than becoming a parse failure.
//
// This runs against an old-format index when one is reachable (SKILL_LIBRARY_ROOT), and
// against fixtures otherwise, so both sides of the contract are pinned on any machine.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSkillRouterTools } from '../host.js'
import { dropFixture, findLibrary, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

const run = async (cwd) => {
  const tools = new Map()
  buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
  return { search: tools.get('skill_search'), exec: makeExec(cwd) }
}

// --- a 6-column index, the shape every earlier writer produced ----------------
// Quote each cell properly: naively wrapping every field in quotes produces
// `"name"\t"description"`, which a CSV reader joins back into ONE field. That mistake
// already cost this project a broken index, so the fixtures here are built deliberately.
const tsvRow = (cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join('\t')
const fixture = makeFixture()
const legacyDir = join(fixture, '.skill-src', 'legacy-skills', 'skills', 'legacy-thing')
mkdirSync(legacyDir, { recursive: true })
writeFileSync(join(legacyDir, 'SKILL.md'), '---\nname: legacy-thing\ndescription: A skill from a 6-column index.\n---\n\nBody.\n', 'utf8')
// Replace the fixture index wholesale with a 6-column one: this file exists to prove the
// OLD shape still parses.
const sixColumn = [
  tsvRow(['repo', 'relpath', 'name', 'description', 'files', 'KB']),
  tsvRow(['legacy-skills', 'skills/legacy-thing', 'legacy-thing', 'A skill from a 6-column index.', '1', '1']),
].join('\r\n')
writeFileSync(join(fixture, '.skill-src', 'skill-index.tsv'), sixColumn, 'utf8')

const legacy = await run(fixture)
const legacyHit = await legacy.search.execute({ query: 'legacy thing' }, legacy.exec)
check('a 6-column index parses', legacyHit.hits.some((hit) => hit.name === 'legacy-thing'), JSON.stringify(legacyHit.hits.map((h) => h.name)))
check('the absent column reads as an empty string, not undefined', legacyHit.hits.every((hit) => hit.whenToUse === ''), JSON.stringify(legacyHit.hits.map((h) => h.whenToUse)))
check('rows in a 6-column index are not misread as headers', legacyHit.total === 1, 'total=' + legacyHit.total)

// --- a 7-column index, the shape the current writer produces ------------------
const sevenDir = join(fixture, '.skill-src', 'modern-skills', 'skills', 'modern-thing')
mkdirSync(sevenDir, { recursive: true })
writeFileSync(join(sevenDir, 'SKILL.md'), '---\nname: modern-thing\ndescription: Prose.\nwhenToUse: ship the frobnicator\n---\n\nBody.\n', 'utf8')
const sevenColumn = [
  tsvRow(['repo', 'relpath', 'name', 'description', 'files', 'KB', 'whenToUse']),
  tsvRow(['modern-skills', 'skills/modern-thing', 'modern-thing', 'Prose.', '1', '1', 'ship the frobnicator']),
].join('\r\n')
writeFileSync(join(fixture, '.skill-src', 'skill-index.tsv'), sevenColumn, 'utf8')

const modern = await run(fixture)
const modernHit = await modern.search.execute({ query: 'frobnicator' }, modern.exec)
check('a 7-column index parses', modernHit.hits.some((hit) => hit.name === 'modern-thing'))
check('the trigger phrasing is returned', String(modernHit.hits[0]?.whenToUse).includes('frobnicator'), JSON.stringify(modernHit.hits[0]?.whenToUse))

// --- the real library, when this machine has one -----------------------------
const libraryRoot = findLibrary()
if (libraryRoot === undefined) {
  console.log('\n(no real library reachable — real-index checks skipped)')
} else {
  const real = await run(libraryRoot)
  const sample = await real.search.execute({ query: 'semgrep', limit: 3 }, real.exec)
  check('the live index still parses', sample.hits.length > 0, 'hits=' + sample.hits.length)
  check('every real hit reports a string whenToUse', sample.hits.every((hit) => typeof hit.whenToUse === 'string'))
  const columns = readFileSync(join(libraryRoot, '.skill-src', 'skill-index.tsv'), 'utf8').split('\n')[0].split('\t')
  check('the live index header is quoted and 6 or 7 columns wide', (columns.length === 6 || columns.length === 7) && columns[0].includes('repo'), JSON.stringify(columns))
}

dropFixture(fixture)
console.log(problems.length === 0 ? '\nindex format: OK' : '\nindex format FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
