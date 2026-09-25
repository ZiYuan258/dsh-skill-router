// 入门技能库（starter library）的测试。
//
// 这一层要同时满足两件互相牵制的事：
//
//   1. **装完就能用**：用户没有自己的库时，`skill_search` / `skill_load` 立刻有东西可用；
//   2. **绝不进常驻目录**：入门技能不能因为"方便"被放进 `.dsh/skills/`。那个前导点目录是插件全部
//      价值的前提——一旦技能进了常驻目录，它们每轮都会进上下文，用户装这个插件就白装了。
//
// 第 2 条是**产品不变量**，不是风格偏好，所以它有独立断言（下面第 4、5 节），而且断言的是"插件没有
// 用任何常驻注册手段"，不是"我没这么写"。
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { buildSkillRouterTools } from '../host.js'
import { buildIndexRows, renderIndex } from '../tools/build-index.mjs'

/** 本机的真库：先看 SKILL_LIBRARY_ROOT，否则从仓库位置向上找带 .skill-src 的祖先。 */
function realLibraryRoot() {
  const explicit = process.env.SKILL_LIBRARY_ROOT
  if (explicit !== undefined && existsSync(join(explicit, '.skill-src', 'skill-index.tsv'))) return join(resolve(explicit), '.skill-src')
  let dir = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, '.skill-src', 'skill-index.tsv'))) return join(dir, '.skill-src')
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}


const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const starterRoot = join(root, 'resources', 'starter-skills')
const hostSource = readFileSync(join(root, 'host.js'), 'utf8')

console.log('入门技能库:')

// ── 1) 它存在、可被发现、索引与磁盘一致 ─────────────────────────────────────────
ok('resources/starter-skills 存在', existsSync(starterRoot))
const indexFile = join(starterRoot, 'skill-index.tsv')
ok('索引文件存在（不是靠运行时现场生成）', existsSync(indexFile))
const built = buildIndexRows(starterRoot)
ok('入门技能数量在 5–15 之间（' + built.rows.length + ' 个）', built.rows.length >= 5 && built.rows.length <= 15)
ok('每个入门技能都能解析到真实文件', built.rows.every((row) => existsSync(join(starterRoot, row.repo, row.relpath, 'SKILL.md'))))
ok('每个入门技能都有 description（否则搜不到）', built.rows.every((row) => String(row.description ?? '') !== ''))

// 提交的索引必须与磁盘一致：入门技能改了却忘了重新生成，用户装到的是旧内容
const committed = readFileSync(indexFile, 'utf8').replace(/\r\n/g, '\n').trimEnd()
ok('提交的索引与当前磁盘一致（改了技能要重跑 build-index）', committed === renderIndex(built.rows).trimEnd(), '跑 node tools/build-index.mjs resources/starter-skills')

// ── 2) 发布清单必须包含它 ──────────────────────────────────────────────────────
//
// 这个坑踩过两次（discovery.js、resources/）：本地开发永远正常，用户装上就是缺文件。
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
ok('package.json 的 files 含 resources', Array.isArray(manifest.files) && manifest.files.includes('resources'), JSON.stringify(manifest.files))
ok('files 含 host.js 与 discovery.js（相对导入的对方）', manifest.files.includes('host.js') && manifest.files.includes('discovery.js'))

// ── 3) 回退行为：没有自己的库时用入门库，有则不用 ───────────────────────────────
function makeCtx() {
  return {
    fs: {
      async resolve(p) {
        const abs = resolve(String(p))
        return { targetKey: abs, displayPath: abs }
      },
      async stat(target) {
        const info = statSync(target.targetKey)
        return { version: String(info.mtimeMs), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      },
      async readText(target) {
        return readFileSync(target.targetKey, 'utf8')
      },
      async listDir(target) {
        return readdirSync(target.targetKey).map((name) => ({ name }))
      },
    },
    tools: { register() {} },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    logger: { warn() {}, info() {} },
  }
}
const emptyWorkspace = mkdtempSync(join(tmpdir(), 'starter-empty-'))
const tools = new Map()
buildSkillRouterTools(makeCtx(), (name, tool) => tools.set(name, tool))
const call = async (tool, args, cwd) => {
  const out = await tools.get(tool).execute(args, { agent: { session: { header: { cwd } } }, signal: undefined })
  return JSON.parse(typeof out === 'string' ? out : JSON.stringify(out))
}

const found = await call('skill_search', { query: 'debug' }, emptyWorkspace)
ok('空工作区里能搜到入门技能', found.total >= 1 && found.hits.length >= 1, 'total=' + found.total)
ok('结果标了 starterLibrary: true（用户能分辨这不是他自己的库）', found.starterLibrary === true)
ok('library 指向插件包内的入门库', String(found.library).includes('starter-skills'), String(found.library))
ok('入门库带 repo 名（消歧与 repo 过滤仍可用）', found.hits.every((hit) => typeof hit.repo === 'string' && hit.repo !== ''))

const loaded = await call('skill_load', { name: 'debug-with-evidence' }, emptyWorkspace)
ok('能真正加载入门技能的正文', loaded.loaded === 'debug-with-evidence' && String(loaded.skills[0].content).includes('Debug with evidence'), JSON.stringify(loaded.loaded))
ok('加载返回的 source 是 library（不是常驻目录）', loaded.skills[0].source === 'library', String(loaded.skills[0].source))

// 中文查询在入门库上同样给出"没有可搜索关键词"，而不是假装没找到
const zh = await call('skill_search', { query: '帮我调试' }, emptyWorkspace)
ok('中文查询仍明确说明需要英文关键词', String(zh.error).includes('Latin script'), String(zh.error).slice(0, 50))

// 有自己的库时，标记必须消失（否则用户会以为自己的库没被读到）。
// 本机没有真库时**跳过**，不拿插件的 resources/ 去伪造——那个目录里没有 .skill-src，
// 回退照常触发，于是这条断言会以"看似失败"的方式说谎。
const real = realLibraryRoot()
if (real === undefined) {
  console.log('  --  本机没有真库，跳过"有自己的库时不出现标记"')
} else {
  const own = await call('skill_search', { query: 'debug' }, resolve(real, '..'))
  ok('有自己的库时不出现 starterLibrary 标记', own.starterLibrary === undefined, 'library=' + own.library)
}

// ── 4) 不变量：入门技能绝不进常驻目录 ──────────────────────────────────────────
//
// 断言的是"插件没有任何把技能注册进常驻目录的调用"，而不是"我没这么写"。
const residentCalls = [...hostSource.matchAll(/\bctx\.skills\s*\.\s*(\w+)/g)].map((m) => m[1])
const registering = residentCalls.filter((name) => /register|install|add|create|write/i.test(name))
ok('host.js 没有任何"往常驻目录注册技能"的调用（ctx.skills.* 只有读）', registering.length === 0, registering.join(', '))
ok('入门库不在 .dsh/skills 这类常驻路径下', starterRoot.includes('.dsh') === false && starterRoot.includes('skills' + sep + 'skills') === false)

// 目录名不以点开头的库对 DSH 扫描器是可见的——这是它**必须**在插件包内的原因之一：
// 它在 node_modules 里，而 DSH 的 skill 扫描器只看工作区与 .dsh。
ok('入门库位于插件包内（不是工作区里的可见目录）', starterRoot.includes('resources') && existsSync(join(root, 'package.json')))

// ── 5) 每个入门技能都是自洽的文档 ─────────────────────────────────────────────
for (const row of built.rows) {
  const text = readFileSync(join(starterRoot, row.repo, row.relpath, 'SKILL.md'), 'utf8')
  const hasHeading = /^#\s+\S/m.test(text)
  const frontmatterOk = text.startsWith('---\n') && /^name:\s*\S/m.test(text) && /^description:\s*\S/m.test(text)
  ok('入门技能结构完整: ' + row.name, hasHeading && frontmatterOk)
  // 描述应以 "Use when" 开头——这是给检索器与模型同时看的触发措辞
  ok('描述是触发措辞: ' + row.name, String(row.description).startsWith('Use when'), String(row.description).slice(0, 40))
}

rmSync(emptyWorkspace, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n入门技能库: OK' : '\n入门技能库 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1

/** host 与 POSIX 的路径分隔符（只用于上面那条路径断言）。 */
function require$sep() {
  return process.platform === 'win32' ? '\\' : '/'
}
