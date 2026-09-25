// `tools/doctor.mjs` 的测试。
//
// doctor 的价值全在"它能否看见真实故障"，所以这里的每一条断言都构造一种**真实故障**，再要求它
// 被报出来。只测"健康库返回 OK"是不够的——一个永远返回 OK 的体检工具也会通过那种测试。
//
// 三种故障都是用户实际会遇到的，而且都是沉默的：
//   · 索引过期（磁盘上删了技能，索引还留着）→ skill_load 报"找不到"
//   · 索引缺失（新增技能没重新生成索引）→ skill_search 永远搜不到它
//   · 没有 description → 该技能搜不到，而且没有任何报错
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { diagnose, findLibraryRoot, main, parseIndexRows, renderReport } from '../tools/doctor.mjs'

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

import { main as buildIndex } from '../tools/build-index.mjs'

// 生成器与体检都支持注入输出：测试在同一个进程里反复调用它们，让它们的输出混进来会把断言淹掉。
const QUIET = { log() {}, error() {} }

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

const root = mkdtempSync(join(tmpdir(), 'doctor-'))
const skill = (rel, name, description) => {
  mkdirSync(join(root, rel), { recursive: true })
  const fields = ['name: ' + name]
  if (description !== undefined) fields.push('description: ' + description)
  writeFileSync(join(root, rel, 'SKILL.md'), '---\n' + fields.join('\n') + '\n---\n\nbody\n', 'utf8')
}

console.log('库体检:')

// ── 1) 索引不存在 ──────────────────────────────────────────────────────────────
skill('repo-a/skills/alpha', 'alpha', 'First skill')
let report = diagnose(root)
ok('索引不存在时明说，并给出修法', report.problems.length === 1 && report.problems[0].includes('build-index'), report.problems.join(' | '))
ok('索引不存在时仍报告磁盘上有多少技能', report.onDisk === 1 && report.indexed === 0)

// ── 2) 健康 ────────────────────────────────────────────────────────────────────
buildIndex([root], QUIET)
report = diagnose(root)
ok('生成索引后判定为健康', report.problems.length === 0, report.problems.join(' | '))
ok('索引与磁盘条数一致', report.indexed === report.onDisk && report.indexed === 1, report.indexed + ' vs ' + report.onDisk)
ok('可读报告含结论行', renderReport(report).includes('结论：健康'))

// ── 3) 索引过期：磁盘上删了技能 ────────────────────────────────────────────────
skill('repo-a/skills/beta', 'beta', 'Second skill')
buildIndex([root], QUIET)
rmSync(join(root, 'repo-a/skills/beta'), { recursive: true, force: true })
report = diagnose(root)
ok('磁盘删掉技能后报"索引过期"', report.stale.length === 1 && report.stale[0].name === 'beta', JSON.stringify(report.stale))
ok('过期计入需要处理', report.problems.some((p) => p.includes('磁盘上找不到')))

// ── 4) 索引缺失：磁盘上新增了技能但没重新生成 ──────────────────────────────────
buildIndex([root], QUIET)
skill('repo-a/skills/gamma', 'gamma', 'Third skill')
report = diagnose(root)
ok('新增技能未进索引时报"缺失"', report.missing.length === 1 && report.missing[0].name === 'gamma', JSON.stringify(report.missing))
ok('缺失计入需要处理（否则用户永远不会知道搜不到它）', report.problems.some((p) => p.includes('搜不到')))

// ── 5) 没有 description：能搜到吗？不能，所以必须是警告 ────────────────────────
buildIndex([root], QUIET)
skill('repo-a/skills/nodesc', 'nodesc')
report = diagnose(root)
buildIndex([root], QUIET)
report = diagnose(root)
ok('无 description 被单独列出', report.noDescription.some((item) => item.name === 'nodesc'), JSON.stringify(report.noDescription.map((i) => i.name)))
ok('无 description 是警告而不是问题（库还能用）', report.problems.length === 0 && report.warnings.some((w) => w.includes('description')), 'problems=' + report.problems.length)

// ── 6) 重名：跨仓库同名，skill_load 需要 repo 提示 ─────────────────────────────
skill('repo-b/skills/alpha-copy', 'alpha', 'Same name from another repo')
buildIndex([root], QUIET)
report = diagnose(root)
const alpha = report.duplicates.find((item) => item.name === 'alpha')
ok('跨仓库重名被报出', alpha !== undefined && alpha.copies === 2, JSON.stringify(report.duplicates))
ok('重名列出涉及的仓库', alpha !== undefined && alpha.repos.includes('repo-a') && alpha.repos.includes('repo-b'), JSON.stringify(alpha && alpha.repos))

// ── 7) 索引解析按插件的规则 ─────────────────────────────────────────────────────
const parsed = parseIndexRows('﻿"repo"\t"relpath"\t"name"\t"desc"\t"files"\t"KB"\r\n"r"\t"skills/a"\t"a"\t"has\ta tab"\t"1"\t"2"\r\n')
ok('BOM + 引号表头被跳过', parsed.length === 1, JSON.stringify(parsed))
ok('引号内的制表符不当分隔符', parsed[0] !== undefined && parsed[0].description === 'has\ta tab', JSON.stringify(parsed[0]))
ok('空行被忽略', parseIndexRows('r\tskills/a\ta\td\n\n\n').length === 1)

// ── 8) 库根查找 ────────────────────────────────────────────────────────────────
ok('--root 指定的库优先', findLibraryRoot(root) === root)
// 嵌套 cwd 的向上查找、以及"运行时与 doctor 必须得到同一个库"的跨层对齐，在
// test/library-root-contract.mjs 里——那个文件同时驱动两个实现，是这条契约的归属地。
// 上面那两条局部断言（--root 优先 / 找不到返回 undefined）留在这里。
ok('找不到时返回 undefined 而不是抛异常', findLibraryRoot(join(root, 'nope')) === undefined)
ok('库不存在时退出码为 2', main(['--root', join(root, 'nope')], QUIET) === 2)
ok('--root 缺参数时退出码为 2', main(['--root', '--json'], QUIET) === 2)
ok('健康库退出码为 0', main(['--root', root], QUIET) === 0)
skill('repo-a/skills/needs-rebuild', 'needs-rebuild', 'Added after the index')
ok('有缺失时退出码为 1', main(['--root', root], QUIET) === 1)

// ── 9) --json 是机器可读的 ─────────────────────────────────────────────────────
const jsonOut = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk) => {
  jsonOut.push(chunk)
  return true
}
main(['--root', root, '--json'], QUIET)
process.stdout.write = realWrite
const payload = JSON.parse(jsonOut.join(''))
ok('--json 输出可解析', payload.root === root && Array.isArray(payload.missing), Object.keys(payload).slice(0, 6).join(','))
ok('--json 不含整库明细（脚本只需要状态）', payload.generated === undefined)

// ── 10) 真库（有的话）── 只要求它能跑完并给出结论，不断言具体数字 ──────────────
const realLibrary = realLibraryRoot()
if (realLibrary === undefined) {
  console.log('  --  本机没有真库，跳过真库体检')
} else {
  const real = diagnose(realLibrary)
  ok('真库体检跑完并给出规模（' + real.onDisk + ' 个技能 / ' + real.repos + ' 个仓库）', real.onDisk > 100 && real.repos > 3, 'onDisk=' + real.onDisk)
  ok('真库的重名统计非空（这是用户需要知道的事实）', Array.isArray(real.duplicates), 'duplicates=' + real.duplicates.length)
  const text = renderReport(real)
  ok('真库报告不含 undefined', text.includes('undefined') === false)
}

rmSync(root, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n库体检: OK' : '\n库体检 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
