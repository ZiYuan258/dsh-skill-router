// Covers the two behaviours added after a design review:
//   1. keyword-AND returning nothing must degrade to a partial (OR) match, labelled so the
//      model can tell a near-miss from a real hit;
//   2. an oversized SKILL.md must be reported as truncated — including the boundary case a
//      previous version got wrong (a body of exactly the cap was clamped and reported clean).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSkillRouterTools } from '../host.js'
import { dropFixture, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

// Always build our own fixture here: this test needs skills with a known, controlled
// description vocabulary rather than whatever library the machine happens to have.
const cwd = makeFixture()
const bigDir = join(cwd, '.skill-src', 'gamma-skills', 'skills', 'gamma-huge')
mkdirSync(bigDir, { recursive: true })
const HUGE = 'A'.repeat(130000)
writeFileSync(join(bigDir, 'SKILL.md'), `---\nname: gamma-huge\ndescription: A deliberately oversized skill for the truncation test.\n---\n\n${HUGE}\n`, 'utf8')

const tools = new Map()
buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
const search = tools.get('skill_search')
const load = tools.get('skill_load')
const exec = makeExec(cwd)

// --- 1. the OR fallback -------------------------------------------------------
console.log('search fallback:')
const exact = await search.execute({ query: 'alpha widgets' }, exec)
check('all-keyword match reports no fallback', exact.fallback === 'none', 'fallback=' + exact.fallback)
check('all-keyword match finds the skill', exact.hits.some((hit) => hit.name === 'alpha-widgets'))
check('hits carry a matchCount', exact.hits.every((hit) => typeof hit.matchCount === 'number'))

// "widgets beta" appears in no single row: alpha rows have widgets, beta rows have beta.
const loose = await search.execute({ query: 'widgets beta' }, exec)
check('no all-keyword match falls back to OR', loose.fallback === 'or', 'fallback=' + loose.fallback)
check('OR fallback still returns candidates', loose.hits.length > 0, 'got ' + loose.hits.length)
check('OR fallback labels partial matches', loose.hits.every((hit) => hit.matchCount < 2), JSON.stringify(loose.hits.map((h) => h.matchCount)))
check('OR fallback explains itself', String(loose.note).includes('match only some'), String(loose.note))

const single = await search.execute({ query: 'nonexistentword' }, exec)
check('a single keyword never reports OR fallback', single.fallback === 'none' && single.hits.length === 0, 'fallback=' + single.fallback)

// --- 1b. the optional whenToUse column ---------------------------------------
// DSH skills may carry a whenToUse frontmatter field; upstream libraries usually leave it
// empty (0 of 1025 in the reference library), so both its presence and its absence must work.
console.log('\nwhenToUse (optional 7th index column):')
const byTrigger = await search.execute({ query: 'frobnicator' }, exec)
check('a whenToUse-matched skill is found', byTrigger.hits.some((hit) => hit.name === 'gamma-triggers'), JSON.stringify(byTrigger.hits.map((h) => h.name)))
const triggerHit = byTrigger.hits.find((hit) => hit.name === 'gamma-triggers')
check('its trigger phrasing is returned', String(triggerHit?.whenToUse).includes('frobnicator'), JSON.stringify(triggerHit?.whenToUse))
check('the card shows the trigger line', search.output.render({}, byTrigger)[0].text.includes('when: ship the frobnicator'))

const plainHit = (await search.execute({ query: 'beta gadgets' }, exec)).hits.find((hit) => hit.name === 'beta-gadgets')
check('a skill without whenToUse still matches', plainHit !== undefined)
check('and reports it as empty', String(plainHit?.whenToUse) === '', JSON.stringify(plainHit?.whenToUse))

// A column the writer omitted entirely (6-column index) must still parse.
const noColumn = await search.execute({ query: 'alpha widgets' }, exec)
check('a 6-column index still parses', noColumn.hits.some((hit) => hit.name === 'alpha-widgets'))
check('the missing column yields an empty value', noColumn.hits.every((hit) => typeof hit.whenToUse === 'string'))

// --- 2. truncation, including the boundary -----------------------------------
console.log('\ntruncation:')
const big = await load.execute({ name: 'gamma-huge' }, exec)
check('oversized body is reported as truncated', big.skills[0].truncated === true)
check('truncated body is capped', String(big.skills[0].content).length <= 120000, 'length=' + String(big.skills[0].content).length)
const reported = Number((/of (\d+) characters/.exec(String(big.skills[0].error)) ?? [])[1])
check(
  'the warning reports the real original length',
  Number.isFinite(reported) && reported > 120000 && reported <= 130100,
  'reported=' + reported,
)
check('the warning says where to read the whole file', String(big.skills[0].error).includes('SKILL.md'))

const small = await load.execute({ name: 'alpha-widgets' }, exec)
check('a normal body is not reported as truncated', small.skills[0].truncated === false)
check('a normal body carries no error', String(small.skills[0].error) === '')

// The regression: exactly-at-cap used to be clamped silently, because the caller tested
// `text.length > cap`, which can never hold after a clamp.
const exactDir = join(cwd, '.skill-src', 'gamma-skills', 'skills', 'gamma-exact')
mkdirSync(exactDir, { recursive: true })
const HEAD = (name) => `---\nname: ${name}\ndescription: Boundary probe.\n---\n\n`
const filler = 120000 - HEAD('gamma-exact').length
writeFileSync(join(exactDir, 'SKILL.md'), HEAD('gamma-exact') + 'B'.repeat(filler) + '\n', 'utf8')
const boundary = await load.execute({ name: 'gamma-exact' }, exec)
const boundaryLength = String(boundary.skills[0].content).length
check(
  'a body of exactly the cap is passed through intact',
  boundaryLength > 119950 && boundary.skills[0].truncated === false,
  'length=' + boundaryLength + ' truncated=' + boundary.skills[0].truncated,
)

dropFixture(cwd)
console.log(problems.length === 0 ? '\nrobustness: OK' : '\nrobustness FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
