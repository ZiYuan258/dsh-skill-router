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
check('registers exactly skill_search, skill_load and skill_ref', registrations.size === 3, 'got ' + [...registrations.keys()].join(', '))
for (const expected of ['skill_search', 'skill_load', 'skill_ref']) {
  check(`${expected} is registered`, registrations.has(expected))
}
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

  // A cwd that cannot contain a library: the filesystem root. The Windows form is `C:/`
  // rather than a home directory — the point is only "the walk-up reaches the top and finds
  // nothing", and a home path would read like a real machine path in a scanner's report.
  //
  // **v1.11.0 改变了这里的期望。** 找不到用户自己的库不再等于"没有库"——插件会回退到随包发布的
  // 入门技能库，于是"装完就能用"。所以断言从"报错"改成"确实读到了入门库、并且标明了这一点"：
  // 一个没有库的 cwd 现在必须仍然可用，这正是那一层存在的理由。
  const outside = await search.execute({ query: 'x' }, makeExec(process.platform === 'win32' ? 'C:/' : '/'))
  check('a cwd without a user library falls back to the bundled starter library', outside.starterLibrary === true, JSON.stringify(outside.error))
  check('the fallback names the library it used', String(outside.library ?? '').includes('starter-skills'))

  // 旧分支（连入门库都没有）仍然必须存在，而且仍然必须指向读者手上真有的东西。用一份"拒绝任何
  // starter-skills 路径"的 fs **重新构建**一套工具来真正触发它——工具绑定的是构建时的 ctx，
  // 所以不能靠 makeExec 换上下文。光有意图不算，要有一条能跑到的断言。
  const noBundled = makeFsContext(process.platform === 'win32' ? 'C:/' : '/')
  const innerStat = noBundled.fs.stat.bind(noBundled.fs)
  noBundled.fs.stat = async (target) => (String(target.targetKey).includes('starter-skills') ? undefined : innerStat(target))
  const bareTools = new Map()
  buildSkillRouterTools(noBundled, (toolName, tool) => bareTools.set(toolName, tool))
  const bare = await bareTools.get('skill_search').execute({ query: 'x' }, makeExec(process.platform === 'win32' ? 'C:/' : '/'))
  check('with no library at all it reports the missing index', String(bare.error ?? '').includes('skill-index.tsv'), JSON.stringify(bare.error))
  // The missing-library error must point at something a reader of this repo actually has.
  // It used to name a scanner script that existed only in the author's workspace, so anyone
  // else following the message hit a file that was never there.
  check('the missing-library error points at the README', String(bare.error ?? '').includes('README'))
  check('the missing-library error names no private script', !String(bare.error ?? '').includes('scan-skills'))

if (fixture !== undefined) {
  const { dropFixture } = await import('./helpers.mjs')
  dropFixture(fixture)
}

console.log(problems.length === 0 ? '\nverify: OK' : '\nverify FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
