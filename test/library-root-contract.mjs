// 运行时与 doctor 必须找到**同一个**技能库。
//
// 这条契约单独成文件，是因为它跨两个实现：
//
//   运行时（host.js 的 resolveRoot）: 会话 cwd 向上最多 8 层找 .skill-src/skill-index.tsv，找不到才回退入门库
//   doctor（tools/doctor.mjs）:      必须复现第 1 条，但**不做回退**（它体检的是用户自己的库）
//
// 第一版的 doctor 只查了 --root / $DSH_HOME / 主目录 / 当前目录，没有向上走。于是出现过分叉：
//
//   会话开在 <工作区>/projects/a/b/c
//   运行时向上找到 <工作区>/.skill-src → 正常工作
//   doctor 说"找不到技能库"           → 用户去查一个不存在的问题
//
// **诊断工具报出与运行时相反的结论，比没有诊断更糟。** 所以这里不只是"doctor 会向上走"，而是
// "两者从同一个 cwd 得到同一个答案"——分叉之所以危险，正是因为两个实现各自看起来都对。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSkillRouterTools } from '../host.js'
import { buildIndexRows, renderIndex } from '../tools/build-index.mjs'
import { findLibraryRoot } from '../tools/doctor.mjs'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

/** 一套够用的 ctx.fs：真实的 node 实现，`resolve` 不抛（不存在的文件由 `stat` 返回 undefined）。 */
function makeCtx() {
  const registered = new Map()
  const ctx = {
    fs: {
      async resolve(path) {
        const abs = resolve(String(path))
        return { targetKey: abs, displayPath: abs }
      },
      async stat(target) {
        try {
          const info = statSync(target.targetKey)
          return { version: String(info.mtimeMs), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
        } catch {
          return undefined
        }
      },
      async readText(target) {
        return readFileSync(target.targetKey, 'utf8')
      },
      async listDir(target) {
        return readdirSync(target.targetKey).map((name) => ({ name }))
      },
    },
    tools: { register: (tool) => registered.set(tool.name, tool) },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    logger: { warn() {}, info() {} },
  }
  buildSkillRouterTools(ctx, (toolName, tool) => registered.set(toolName, tool))
  return registered
}

console.log('库根契约（运行时 vs doctor）:')

// ── 夹具：库在工作区根，会话开在它下面四层 ───────────────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'library-root-'))
const library = join(workspace, '.skill-src')
mkdirSync(join(library, 'upstream', 'skills', 'nested-skill'), { recursive: true })
writeFileSync(
  join(library, 'upstream', 'skills', 'nested-skill', 'SKILL.md'),
  '---\nname: nested-skill\ndescription: reachable only by walking up\n---\n\nbody\n',
  'utf8',
)
// 索引就用手上的生成器产出，形状与真实索引一致
const built = buildIndexRows(library)
writeFileSync(join(library, 'skill-index.tsv'), renderIndex(built.rows), 'utf8')
const nestedCwd = join(workspace, 'projects', 'a', 'b', 'c')
mkdirSync(nestedCwd, { recursive: true })

ok('夹具成立：索引在库根，会话 cwd 在它下面四层', existsSync(join(library, 'skill-index.tsv')) && existsSync(nestedCwd))

// ── 运行时 ─────────────────────────────────────────────────────────────────────
const tools = makeCtx()
const call = async (tool, args, cwd) => {
  const out = await tools.get(tool).execute(args, { agent: { session: { header: { cwd } } }, signal: undefined })
  return JSON.parse(typeof out === 'string' ? out : JSON.stringify(out))
}
const runtime = await call('skill_search', { query: 'nested' }, nestedCwd)
ok('运行时从嵌套 cwd 向上找到库', resolve(String(runtime.library)) === resolve(library), 'library=' + runtime.library)
ok('运行时用的是用户的库，不是入门库', runtime.starterLibrary === undefined && runtime.total >= 1, 'starterLibrary=' + runtime.starterLibrary + ' total=' + runtime.total)
ok('找到的技能就是这个夹具里的', (runtime.hits || []).some((hit) => hit.name === 'nested-skill'), JSON.stringify((runtime.hits || []).map((h) => h.name)))

// ── doctor ─────────────────────────────────────────────────────────────────────
ok('doctor 从同一个 cwd 找到同一个库', resolve(String(findLibraryRoot(undefined, nestedCwd))) === resolve(library), 'doctor=' + findLibraryRoot(undefined, nestedCwd))
// --root 仍然优先，且指向不存在的地方时返回 undefined 而不是编一个
ok('--root 优先', resolve(String(findLibraryRoot(library, nestedCwd))) === resolve(library))
ok('--root 指向不存在处时返回 undefined', findLibraryRoot(join(workspace, 'nope'), nestedCwd) === undefined)

// ── 边界：两者对"走不到"的判断也一致 ───────────────────────────────────────────
// 深到超出 8 层：运行时找不到库 → 回退入门库；doctor 找不到 → undefined。两者都不该"找到"这个库。
const tooDeep = join(workspace, ...Array.from({ length: 12 }, () => 'deep'))
mkdirSync(tooDeep, { recursive: true })
ok('超出 8 层时 doctor 找不到', findLibraryRoot(undefined, tooDeep) === undefined)
const deepRuntime = await call('skill_search', { query: 'nested' }, tooDeep)
ok('超出 8 层时运行时不使用这个库（回退到入门库）', String(deepRuntime.library) !== resolve(library) && deepRuntime.starterLibrary === true, 'library=' + deepRuntime.library)

// ── 回退只在运行时发生：doctor 不体检插件自带的示例 ─────────────────────────────
const emptyWorkspace = mkdtempSync(join(tmpdir(), 'library-root-empty-'))
const emptyRuntime = await call('skill_search', { query: 'nested' }, emptyWorkspace)
ok('没有库时运行时回退到入门库', emptyRuntime.starterLibrary === true, 'library=' + emptyRuntime.library)
ok('没有库时 doctor 报"找不到"而不是去体检入门库', findLibraryRoot(undefined, emptyWorkspace) === undefined)

rmSync(workspace, { recursive: true, force: true })
rmSync(emptyWorkspace, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n库根契约: OK' : '\n库根契约 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
