// Collision handling: skill_load must pick a deterministic copy, honour a repo hint, and
// refuse to silently fall back to another repo when the hint matches nothing.
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

const libraryRoot = findLibrary()
const fixture = libraryRoot === undefined ? makeFixture() : undefined
const cwd = libraryRoot ?? fixture

const tools = new Map()
buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
const search = tools.get('skill_search')
const load = tools.get('skill_load')
const exec = makeExec(cwd)
const dirOf = (result) => String(result.skills?.[0]?.resourceDir ?? '')

if (libraryRoot === undefined) {
  // The fixture ships alpha-widgets twice: skills/ and plugins/deep/skills/.
  const plain = await load.execute({ name: 'alpha-widgets' }, exec)
  check('without a hint the shallowest copy wins', dirOf(plain).replace(/\\/g, '/').endsWith('alpha-skills/skills/alpha-widgets'), dirOf(plain))
  // `copies` 是按来源分开的对象（库内多份 vs 跨域同名）。两处分支各自断言它，
  // 且都检查 `.library` 而不是只检查 `.total` —— 只查 total 的话，
  // 一个"把 catalog 计数算进 library"的实现也能通过。
  check('the copy count is reported', plain.skills?.[0]?.copies?.total >= 2, 'copies=' + JSON.stringify(plain.skills?.[0]?.copies))
  check(
    'the copy count separates library copies from catalog ones',
    plain.skills?.[0]?.copies?.library >= 2 && plain.skills?.[0]?.copies?.catalog === 0,
    'copies=' + JSON.stringify(plain.skills?.[0]?.copies),
  )
  check('the chosen repo is reported', plain.skills?.[0]?.repo === 'alpha-skills')

  const hinted = await load.execute({ name: 'alpha-widgets', repo: 'alpha' }, exec)
  check('a matching repo hint still resolves', String(hinted.loaded).includes('alpha-widgets'))

  const wrongRepo = await load.execute({ name: 'alpha-widgets', repo: 'beta' }, exec)
  check('a non-matching repo hint refuses to fall back', String(wrongRepo.skills?.[0]?.error ?? '').includes('exists in'), String(wrongRepo.skills?.[0]?.error))

  const found = await search.execute({ query: 'alpha widgets', names_only: true }, exec)
  check('search surfaces every copy', found.total >= 2, 'total=' + found.total)
} else {
  // The real library ships test-driven-development five times across three repos.
  const name = 'test-driven-development'
  const plain = await load.execute({ name }, exec)
  check('without a hint a copy is chosen deterministically', String(plain.loaded).includes(name))
  check('the copy count is reported', plain.skills?.[0]?.copies?.total >= 2, 'copies=' + JSON.stringify(plain.skills?.[0]?.copies))
  check(
    'the copy count attributes copies to the library, not the catalog',
    plain.skills?.[0]?.copies?.library >= 2 && typeof plain.skills?.[0]?.copies?.catalog === 'number',
    'copies=' + JSON.stringify(plain.skills?.[0]?.copies),
  )

  const second = await load.execute({ name }, exec)
  check('the same name resolves to the same copy twice', dirOf(plain) === dirOf(second), dirOf(plain) + ' vs ' + dirOf(second))

  const hinted = await load.execute({ name, repo: 'superpowers' }, exec)
  check('a repo hint selects that repo', dirOf(hinted).replace(/\\/g, '/').includes('/superpowers/'), dirOf(hinted))

  const wrongRepo = await load.execute({ name, repo: 'microsoft' }, exec)
  check('a non-matching repo hint refuses to fall back', String(wrongRepo.skills?.[0]?.error ?? '').includes('exists in'), String(wrongRepo.skills?.[0]?.error))

  const found = await search.execute({ query: 'test driven development', names_only: true }, exec)
  check('search surfaces every copy', found.total >= 2, 'total=' + found.total)
}

if (fixture !== undefined) dropFixture(fixture)

console.log(problems.length === 0 ? '\ncollisions: OK' : '\ncollisions FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
