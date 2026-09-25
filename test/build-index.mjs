// `tools/build-index.mjs` 的契约测试。
//
// 这个生成器的**存在意义**是让用户不必理解索引格式，所以它错一列就等于插件对用户不可用。而它
// 第一版恰好演示了最难发现的那种错：`relpath` 多套了一层 `repo/`，**行数完全正确**（1028 = 1028），
// 键集合也"看起来对"，但 1028 行里 **0 行**能拼出真实文件。计数类的检查一条都不会红。
//
// 所以这里最重要的一条断言不是"行数对不对"，而是：
//
//   **每一行都必须按插件的路径规则解析到一个真实存在的 SKILL.md。**
//
// 那条断言是拿真库跑出来的（1028/1028），这个文件是把它变成会红的东西。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildIndexRows, renderIndex, main } from '../tools/build-index.mjs'

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

// ── 夹具：一棵尽量像真库的库 ────────────────────────────────────────────────────
//
// 包含真实库里见过的每一种形状：`<repo>/skills/<name>/`、monorepo 那种 `<repo>/.github/...
// /skills/<name>/`、**`<repo>/<repo>/skills/`（同名的重复一层）**、没有 name 的 frontmatter、
// 描述里带制表符、块标量、BOM + CRLF、以及必须被跳过的 `.git` 与 `node_modules`。
const root = mkdtempSync(join(tmpdir(), 'build-index-'))
const skill = (rel, body) => {
  mkdirSync(join(root, rel), { recursive: true })
  writeFileSync(join(root, rel, 'SKILL.md'), body, 'utf8')
}
const fm = (fields, tail = '\nbody\n') => '---\n' + fields.join('\n') + '\n---\n' + tail

skill('plain-repo/skills/alpha', fm(['name: alpha', 'description: First skill, plain shape']))
skill('plain-repo/skills/beta', fm(['name: beta', 'description: Second skill', 'whenToUse: when testing beta']))
// 同名重复一层：真实库里 addyosmani-skills 就是这种布局，第一版就是在这里多套了一层
skill('twin-repo/twin-repo/skills/gamma', fm(['name: gamma', 'description: Nested duplicate repo level']))
// monorepo 布局
skill('mono/.github/plugins/tool/skills/delta', fm(['name: delta', 'description: Deeply nested monorepo skill']))
// frontmatter 缺 name → 用目录名兜底
skill('plain-repo/skills/epsilon', fm(['description: No name field here']))
// 描述里带制表符 → 必须按 CSV 规则加引号，否则整行错列。
// 制表符必须是**真的** \t：第一版在夹具里写了 `\\t`，于是被测的是字面反斜杠+t，断言测了个寂寞。
// 描述里带引号 → 走 YAML 的 `""` 转义。
// **制表符不在这里测**：YAML 规范把制表符当分隔空白，往带引号的标量里塞真 tab 是非法 YAML，
// 解析器把它压成空格是对的。TSV 转义要直接测 writer（见下面第 5 节），不绕 YAML。
skill('plain-repo/skills/zeta', fm(['name: zeta', 'description: "Has a \\"quote\\" inside"']))
// 块标量描述
skill('plain-repo/skills/eta', fm(['name: eta', 'description: >-', '  A folded description that', '  spans two lines']))
// BOM + CRLF
{
  mkdirSync(join(root, 'crlf-repo/skills/theta'), { recursive: true })
  writeFileSync(join(root, 'crlf-repo/skills/theta/SKILL.md'), '\uFEFF---\r\nname: theta\r\ndescription: BOM and CRLF file\r\n---\r\n\r\nbody\r\n', 'utf8')
}
// 没有 frontmatter 的技能（真实库里微软那个 monorepo 就有）
skill('mono/skills/bare', '# Just a heading\n\nNo frontmatter at all.\n')
// 辅助文件，用来验 files/KB 两列
writeFileSync(join(root, 'plain-repo/skills/alpha', 'reference.md'), 'x'.repeat(2048), 'utf8')
// 必须被跳过
mkdirSync(join(root, 'plain-repo/.git'), { recursive: true })
writeFileSync(join(root, 'plain-repo/.git/SKILL.md'), fm(['name: from-git', 'description: must not be indexed']), 'utf8')
mkdirSync(join(root, 'plain-repo/node_modules/pkg'), { recursive: true })
writeFileSync(join(root, 'plain-repo/node_modules/pkg/SKILL.md'), fm(['name: from-modules', 'description: must not be indexed']), 'utf8')

console.log('索引生成器:')

const built = buildIndexRows(root)
const rows = built.rows
const byName = new Map(rows.map((row) => [row.name, row]))

// ── 1) 最重要的一条：每一行都要能拼出真实文件 ─────────────────────────────────────
//
// 拼法就是插件用的拼法：<库>/<repo>/<relpath>/SKILL.md。第一版 1028 行全部拼不出来，而这条断言
// 当时不存在。
const unresolvable = rows.filter((row) => existsSync(join(root, row.repo, row.relpath.split('/').join('/'), 'SKILL.md')) === false)
ok('每一行都按 <库>/<repo>/<relpath>/SKILL.md 解析到真实文件（' + rows.length + ' 行）', unresolvable.length === 0, unresolvable.map((r) => r.repo + '/' + r.relpath).join(' | '))

// relpath 必须相对**仓库根**：同名的重复一层要留在路径里，不能被吃掉
ok('relpath 相对仓库根（`twin-repo/twin-repo/...` 的那一层被保留）', byName.get('gamma') !== undefined && byName.get('gamma').relpath === 'twin-repo/skills/gamma', JSON.stringify(byName.get('gamma')))
ok('relpath 用正斜杠', rows.every((row) => row.relpath.includes('\\') === false), rows.filter((r) => r.relpath.includes('\\')).map((r) => r.relpath).join(', '))
ok('relpath 以 <repo>/<repo>/ 开头的只有同名重复层那一行', rows.filter((row) => row.relpath.startsWith(row.repo + '/')).map((row) => row.name).join(',') === 'gamma')

// ── 2) 扫描范围 ────────────────────────────────────────────────────────────────
ok('扫到 9 个技能', rows.length === 9, 'rows=' + rows.length + ' → ' + rows.map((r) => r.name).join(','))
ok('跳过 .git 下的 SKILL.md', byName.has('from-git') === false)
ok('跳过 node_modules 下的 SKILL.md', byName.has('from-modules') === false)
ok('深层 monorepo 里的技能被扫到', byName.has('delta') === true)

// ── 3) frontmatter 解析 ────────────────────────────────────────────────────────
ok('普通 name/description', byName.get('alpha') !== undefined && byName.get('alpha').description === 'First skill, plain shape')
ok('缺 name 时用目录名兜底', byName.has('epsilon') === true && byName.get('epsilon').description === 'No name field here')
ok('块标量描述被压成一行', byName.get('eta') !== undefined && byName.get('eta').description === 'A folded description that spans two lines', JSON.stringify(byName.get('eta') && byName.get('eta').description))
ok('BOM + CRLF 的文件照常解析', byName.get('theta') !== undefined && byName.get('theta').description === 'BOM and CRLF file', JSON.stringify(byName.get('theta')))
ok('描述里的 YAML 引号转义被还原', byName.get('zeta') !== undefined && byName.get('zeta').description === 'Has a "quote" inside', JSON.stringify(byName.get('zeta') && byName.get('zeta').description))
ok('没有 frontmatter 时用目录名且描述为空', byName.has('bare') === true && byName.get('bare').description === '')
ok('缺 name / 缺 description 都有警告', built.warnings.length >= 2, built.warnings.slice(0, 3).join(' | '))

// ── 4) whenToUse 的列策略 ──────────────────────────────────────────────────────
ok('至少一行有 whenToUse 时写第 7 列', renderIndex(rows).split('\n')[0].split('\t').length === 7)
ok('全库都没有 whenToUse 时只写 6 列', renderIndex(rows.map((r) => ({ ...r, whenToUse: '' }))).split('\n')[0].split('\t').length === 6)

// ── 5) TSV 转义：描述含制表符时必须加引号，否则整行错列 ─────────────────────────
// 直接构造一行含真制表符与真引号的数据：这才是 writer 的输入域，也是 CSV 规则存在的理由。
const nasty = [{ repo: 'r', relpath: 'skills/x', name: 'nasty', description: 'has\ta tab and a "quote" and a\nnewline', files: 1, KB: 2, whenToUse: '' }]
const nastyLine = renderIndex(nasty).split('\n').slice(1).join('\n')
ok('含制表符/引号/换行的字段被引号包住', nastyLine.startsWith('r\tskills/x\tnasty\t"') === true, JSON.stringify(nastyLine.slice(0, 80)))
ok('内部引号翻倍', nastyLine.includes('""quote""') === true, JSON.stringify(nastyLine.slice(0, 90)))

// ── 6) 写出的文件能被**插件的解析规则**读回 ─────────────────────────────────────
//
// 这里不重实现解析器：按插件那条"表头按形状识别"的规则检查，并确认列数一致。
const lines = renderIndex(rows).split('\n').filter((l) => l !== '')
const header = lines[0].split('\t')
ok('表头前两列是 repo 与 name（插件按形状跳过表头）', header[0] === 'repo' && header[2] === 'name', header.join(','))
ok('表头与实际数据行的列数一致', lines.slice(1).every((l) => countFields(l) === header.length), '')
ok('输出以 LF 结尾且首行无 BOM', renderIndex(rows).includes('\r\n') === false && renderIndex(rows).charCodeAt(0) !== 0xfeff)

/** 按 CSV 规则数字段（引号内的制表符不算分隔）。 */
function countFields(line) {
  let fields = 1
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        i += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (ch === '\t' && quoted === false) fields += 1
  }
  return fields
}

// ── 7) files / KB 两列 ─────────────────────────────────────────────────────────
ok('files 统计技能目录下的文件数', byName.get('alpha') !== undefined && byName.get('alpha').files === 2, 'alpha.files=' + (byName.get('alpha') && byName.get('alpha').files))
ok('KB 至少为 1（空目录不该写 0）', rows.every((row) => Number(row.KB) >= 1))

// ── 8) CLI：--check 的三种状态 ─────────────────────────────────────────────────
const cliRoot = mkdtempSync(join(tmpdir(), 'build-index-cli-'))
mkdirSync(join(cliRoot, 'r/skills/one'), { recursive: true })
writeFileSync(join(cliRoot, 'r/skills/one/SKILL.md'), fm(['name: one', 'description: cli fixture']), 'utf8')
const quiet = { log() {}, error() {} }
const realLog = console.log
const realError = console.error
console.log = quiet.log
console.error = quiet.error
ok('--check 在没有索引时返回 1', main([cliRoot, '--check']) === 1)
ok('生成返回 0', main([cliRoot]) === 0)
ok('生成后 --check 返回 0', main([cliRoot, '--check']) === 0)
// 库内容变了 → --check 必须变红
mkdirSync(join(cliRoot, 'r/skills/two'), { recursive: true })
writeFileSync(join(cliRoot, 'r/skills/two/SKILL.md'), fm(['name: two', 'description: added later']), 'utf8')
ok('库变了之后 --check 返回 1', main([cliRoot, '--check']) === 1)
// CRLF 不该被算成"有变化"（Windows 上否则恒报过期）。用全新的夹具目录，排除前面步骤的干扰。
const crlfRoot = mkdtempSync(join(tmpdir(), 'build-index-crlf-'))
mkdirSync(join(crlfRoot, 'r/skills/one'), { recursive: true })
writeFileSync(join(crlfRoot, 'r/skills/one/SKILL.md'), fm(['name: one', 'description: crlf fixture']), 'utf8')
main([crlfRoot])
writeFileSync(join(crlfRoot, 'skill-index.tsv'), readFileSync(join(crlfRoot, 'skill-index.tsv'), 'utf8').replace(/\n/g, '\r\n'), 'utf8')
ok('索引被转成 CRLF 后 --check 仍返回 0（不算过期）', main([crlfRoot, '--check']) === 0)
rmSync(crlfRoot, { recursive: true, force: true })
ok('不存在的目录返回 2', main([join(cliRoot, 'nope')]) === 2)
ok('不给参数返回 2', main([]) === 2)
console.log = realLog
console.error = realError

// ── 9) 真库（有的话）：逐行解析 + 幂等 ───────────────────────────────────────────
const realLibrary = realLibraryRoot()
if (realLibrary === undefined) {
  console.log('  --  本机没有真库，跳过真库校验')
} else {
  const real = buildIndexRows(realLibrary)
  const bad = real.rows.filter((row) => existsSync(join(realLibrary, row.repo, row.relpath, 'SKILL.md')) === false)
  ok('真库：' + real.rows.length + ' 行全部解析到真实文件', bad.length === 0, bad.slice(0, 3).map((r) => r.repo + '/' + r.relpath).join(' | '))
  // 与现有索引的键集合比对（relpath 统一成正斜杠后再比）
  const key = (repo, relpath) => repo + '|' + relpath.replace(/\\/g, '/')
  const current = readFileSync(join(realLibrary, 'skill-index.tsv'), 'utf8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(1)
    .map((l) => {
      const f = l.split('\t').map((s) => s.replace(/^"|"$/g, ''))
      return key(f[0], f[1])
    })
  const mine = new Set(real.rows.map((row) => key(row.repo, row.relpath)))
  const missing = current.filter((k) => mine.has(k) === false)
  ok('真库：与现有索引的键集合一致（' + current.length + ' 个键）', missing.length === 0, missing.slice(0, 3).join(' | '))
}

rmSync(root, { recursive: true, force: true })
rmSync(cliRoot, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n索引生成器: OK' : '\n索引生成器 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
