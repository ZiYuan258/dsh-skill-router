// End-to-end smoke test of both tools, against the real library when this machine has
// one and against a generated fixture otherwise, so a fresh clone can still run it.
//
// Uses no assertion library: it fails by exiting non-zero on any unexpected result.
import { buildSkillRouterTools, inject, name } from '../host.js'
import { findLibrary, makeExec, makeFixture, makeFsContext } from './helpers.mjs'
import { join } from 'node:path'

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
  // `copies` 从数字变成了按来源分开的对象：库内多份要靠 `repo` 选，跨域同名不能靠 `repo` 选，
  // 合成一个数字会让模型去找一个不存在的 repo 参数。断言随之改成检查**结构**，
  // 而不是只检查类型——只查 typeof 的话，`{total, library, catalog}` 三处任一丢失都测不出来。
  check(
    'search reports the copy breakdown',
    hits.hits.every(
      (hit) =>
        hit.copies !== null &&
        typeof hit.copies === 'object' &&
        typeof hit.copies.total === 'number' &&
        typeof hit.copies.library === 'number' &&
        typeof hit.copies.catalog === 'number' &&
        hit.copies.total === hit.copies.library + hit.copies.catalog,
    ),
  )

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

// --- the alarm must reach the RENDERED text, not only the JSON ---------------
//
// v1.16.0 shipped an index-integrity alarm that the model could never see: the text went into
// `result.note`, and `render()` never emitted `note` — it renders hits, errors, stale rows and
// the duplicate hint, and nothing else. Every test passed, because they all asserted the JSON
// (`result.indexAlarm`, `result.note`) and none asserted what the model actually reads.
//
// Found only by restarting and calling the real tool. This block is the missing layer: it drives
// `render()` with a synthetic alarm and requires the text to carry it. It deliberately does NOT
// go through `execute()` — a real alarm needs a corrupted index on disk, and a test that needs a
// broken fixture to prove a rendering path is a test nobody will keep running.
const searchTool = registrations.get('skill_search')
const rendered = searchTool.output.render(
  { query: 'anything' },
  {
    library: 'X',
    total: 0,
    strict: 0,
    shown: 0,
    fallback: 'none',
    hits: [],
    error: '',
    note: 'Call skill_load with one exact name.',
    indexAlarm: ['the index was written after its identity file (index version 1 > sidecar 0)'],
  },
)
const renderedText = Array.isArray(rendered) ? rendered.map((part) => String(part.text ?? '')).join('\n') : ''
check('an index alarm is rendered into the text the model reads', /INDEX INTEGRITY ALARM/.test(renderedText), renderedText.slice(0, 120))
check('the rendered alarm carries the specific problem', /written after its identity file/.test(renderedText), renderedText.slice(0, 160))
check('the rendered alarm says how to fix it', /scan-skills\.ps1/.test(renderedText), renderedText.slice(0, 200))
check('the rendered alarm says results are still shown but unverified', /unverified/.test(renderedText), renderedText.slice(0, 240))

// The same call with no alarm must stay clean — otherwise the block above would pass on noise.
const cleanRender = searchTool.output.render(
  { query: 'anything' },
  { library: 'X', total: 0, strict: 0, shown: 0, fallback: 'none', hits: [], error: '', note: 'nothing to see' },
)
const cleanText = Array.isArray(cleanRender) ? cleanRender.map((part) => String(part.text ?? '')).join('\n') : ''
check('a healthy index renders no alarm banner', /INDEX INTEGRITY ALARM/.test(cleanText) === false, cleanText.slice(0, 120))

// --- a catalog row must never be labelled STALE just because ctx.fs cannot read it ---------
//
// The second defect from the same restart: bundled skills live inside `app.asar`, which is a
// FILE, so `ctx.fs` cannot open the path even though the host process reads it fine (measured:
// `skill_load cordis-plugin-development` succeeds with `source: resident`). Stat-ing the path and
// reporting the failure labelled three perfectly healthy skills "STALE: SKILL.md is missing".
//
// "Cannot read it from here" is not "it is not there". The rule under test: a catalog row's
// `stale` stays false even when every fs call for it throws.
{
  const unreadable = makeFsContext(libraryRoot ?? fixture ?? '.')
  const realResolve = unreadable.fs.resolve
  unreadable.fs.resolve = async (path) => {
    // Everything works except the catalog path — exactly the asar case.
    if (String(path).includes('unreadable-catalog-skill')) throw new Error('ENOENT: asar is a file')
    return await realResolve(path)
  }
  const catalogEntry = {
    name: 'unreadable-catalog-skill',
    path: join('Z:', 'app.asar', 'skills', 'unreadable-catalog-skill', 'SKILL.md'),
    description: 'A catalog skill whose path the virtual fs cannot open. Used to prove a row is not called stale for that reason.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'filesystem',
  }
  unreadable.get = (service) => (service === 'skills' ? { async list() { return [catalogEntry] }, async get() { return undefined } } : undefined)
  const isolated = new Map()
  buildSkillRouterTools(unreadable, (toolName, tool) => isolated.set(toolName, tool))
  const found = await isolated.get('skill_search').execute({ query: 'unreadable catalog skill' }, exec)
  const row = (found.hits ?? []).find((hit) => hit.name === 'unreadable-catalog-skill')
  check('an unreadable catalog path still reaches the results', row !== undefined, 'hits=' + (found.hits ?? []).map((h) => h.name).join(', '))
  check('an unreadable catalog path is NOT reported as stale', row !== undefined && row.stale === false, 'stale=' + String(row?.stale))
  check('an unreadable catalog path is still offered by its own absolute path', row !== undefined && String(row.path).includes('unreadable-catalog-skill'), String(row?.path))
  if (row !== undefined) {
    const text = isolated.get('skill_search').output.render({ query: 'x' }, found).map((part) => String(part.text ?? '')).join('\n')
    check('the rendered text does not call that row STALE', text.includes('STALE') === false, text.slice(0, 160))
  }
}

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
