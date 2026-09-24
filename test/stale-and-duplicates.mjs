// Two behaviours a real library forces, both found by probing one rather than by reasoning
// about it. Neither is hypothetical: a stale index is what deleting a skill directory
// without regenerating produces, and a duplicated name is normal in a library assembled
// from several upstream repositories.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const render = (result) => search.output.render({}, result).map((part) => part.text).join('\n')

// --- a row whose directory is gone -------------------------------------------
// Deleting a skill directory without regenerating the index used to make skill_search
// throw ENOENT, because resolving a path went through ctx.fs.resolve, which throws when
// the path is absent. One stale row took down the whole search.
rmSync(join(root, '.skill-src', 'beta-skills', 'skills', 'beta-gadgets'), { recursive: true, force: true })

let searchResult
let threw
try {
  searchResult = await search.execute({ query: 'beta gadgets' }, exec)
} catch (error) {
  threw = error
}
check('a stale row does not make skill_search throw', threw === undefined, threw === undefined ? undefined : String(threw))
if (searchResult !== undefined) {
  const hit = searchResult.hits.find((entry) => entry.name === 'beta-gadgets')
  check('the stale row is still reported', hit !== undefined)
  check('the stale row is flagged stale', hit?.stale === true, 'stale=' + String(hit?.stale))
  check('the model is told the row is stale', render(searchResult).includes('STALE'), render(searchResult).split('\n').slice(0, 4).join(' / '))
}

const staleLoad = await load.execute({ name: 'beta-gadgets' }, exec)
const staleError = String(staleLoad.skills?.[0]?.error ?? '')
check('loading a stale row names the cause', /index is stale/.test(staleError), staleError.slice(0, 90))
check('loading a stale row sets stale: true', staleLoad.skills?.[0]?.stale === true)
check('loading a stale row does not throw', staleLoad.skills?.length === 1)

// --- a name that exists in several repos --------------------------------------
// The search note tells the model to pass `repo` when copies > 1, so the copy count has to
// be visible in the rendered text: the JSON carries it, but the model reads the text.
const dupes = await search.execute({ query: 'alpha widgets' }, exec)
const dupeText = render(dupes)
check('several copies are reported in the JSON', dupes.hits.every((hit) => hit.copies >= 2), String(dupes.hits[0]?.copies))
check('the rendered text names the repos to choose between', /pass repo to skill_load/.test(dupeText), dupeText.split('\n').slice(-1)[0])
check('the rendered text lists more than one repo', new Set(dupes.hits.map((hit) => hit.repo)).size > 1)

// --- the header must not present a loose match as a normal result set ---------
const loose = await search.execute({ query: 'alpha widgets frobnicator' }, exec)
if (loose.fallback === 'or') {
  const head = render(loose).split('\n')[0]
  check('a loose match is announced as partial, not as plain matches', /partial match/.test(head), head)
} else {
  check('the loose-match probe reached the fallback path', false, 'fallback=' + String(loose.fallback))
}

// --- degenerate queries -------------------------------------------------------
const empty = await search.execute({ query: 'the a of' }, exec)
check('a query of stop words alone still answers', empty.error !== undefined || empty.hits.length === 0, JSON.stringify(empty.error))

const cjk = await search.execute({ query: '做视频' }, exec)
check('a non-Latin query explains that keywords must be English', /English/i.test(String(cjk.error)), String(cjk.error).slice(0, 90))

dropFixture(root)
console.log(problems.length === 0 ? 'stale and duplicates: OK' : 'stale and duplicates FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
