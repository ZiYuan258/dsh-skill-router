// End-to-end smoke test of both tools, against the real library when this machine has
// one and against a generated fixture otherwise, so a fresh clone can still run it.
//
// Uses no assertion library: it fails by exiting non-zero on any unexpected result.
import { buildSkillRouterTools, inject, name } from '../host.js'
import { findLibrary, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

// --- registration shape -------------------------------------------------------
const registrations = new Map()
buildSkillRouterTools(makeFsContext('.'), (toolName, tool) => registrations.set(toolName, tool))
console.log('plugin:', name, '| inject:', inject.join(','), '| tools:', [...registrations.keys()].join(', '))
check('registers exactly skill_search and skill_load', registrations.size === 2)
for (const [toolName, tool] of registrations) {
  check(`${toolName} has a description`, typeof tool.description === 'string' && tool.description.length > 40)
  check(`${toolName} has render + execute`, typeof tool.output?.render === 'function' && typeof tool.execute === 'function')
  check(`${toolName} parameters are object-rooted`, tool.parameters?.type === 'object' && tool.parameters?.additionalProperties === false)
}

// --- live behaviour -----------------------------------------------------------
const libraryRoot = findLibrary()
const fixture = libraryRoot === undefined ? makeFixture() : undefined
const cwd = libraryRoot ?? fixture
console.log(libraryRoot === undefined ? 'using a generated fixture library' : 'using the real library at ' + libraryRoot)

const tools = new Map()
buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
const search = tools.get('skill_search')
const load = tools.get('skill_load')
const exec = makeExec(cwd)

if (libraryRoot === undefined) {
  const hits = await search.execute({ query: 'alpha widgets' }, exec)
  check('search finds a fixture skill', hits.total >= 1 && hits.hits.some((hit) => hit.name === 'alpha-widgets'))
  check('search reports the copy count', hits.hits.every((hit) => typeof hit.copies === 'number'))

  const one = await load.execute({ name: 'beta-gadgets' }, exec)
  check('single load returns the body', String(one.skills?.[0]?.content ?? '').includes('Fixture body'))
  check('single load reports its source', one.skills?.[0]?.source === 'library')

  const many = await load.execute({ names: 'alpha-widgets, beta-gadgets' }, exec)
  check('batch load returns both', String(many.loaded).split(', ').filter(Boolean).length === 2)

  const dupes = await load.execute({ name: 'alpha-widgets' }, exec)
  check('duplicate names resolve to the shallowest copy', String(dupes.skills?.[0]?.resourceDir ?? '').endsWith('alpha-skills\\skills\\alpha-widgets') || String(dupes.skills?.[0]?.resourceDir ?? '').endsWith('alpha-skills/skills/alpha-widgets'))
} else {
  const hits = await search.execute({ query: 'remotion video' }, exec)
  check('search returns matches', hits.total >= 1 && hits.hits.length >= 1)

  const one = await load.execute({ name: 'pytest-skill' }, exec)
  check('single load returns a body', String(one.skills?.[0]?.content ?? '').length > 200)
  check('single load reports the base directory', String(one.skills?.[0]?.resourceDir ?? '') !== '')

  const pathForm = await load.execute({ name: String(hits.hits[0].path) }, exec)
  check('a full SKILL.md path is accepted', String(pathForm.skills?.[0]?.content ?? '').length > 0)
}

const miss = await load.execute({ name: 'definitely-not-a-skill-xyz' }, exec)
check('unknown name reports an actionable error', String(miss.skills?.[0]?.error ?? '').includes('skill_search'))

const empty = await load.execute({}, exec)
check('empty call explains how to pass a name', String(empty.note ?? '').includes('Pass name'))

const outside = await search.execute({ query: 'x' }, makeExec(process.platform === 'win32' ? 'C:\\Windows' : '/'))
check('a cwd without a library reports it', String(outside.error ?? '').includes('skill-index.tsv'))

if (fixture !== undefined) {
  const { dropFixture } = await import('./helpers.mjs')
  dropFixture(fixture)
}

console.log(problems.length === 0 ? '\nverify: OK' : '\nverify FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
