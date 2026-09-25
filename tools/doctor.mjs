// 技能库体检：把"为什么搜不到 / 加载不了"变成一条命令的输出。
//
// 为什么要有它：装完插件之后，用户的失败体验全是**沉默的**——索引在但路径不对、索引过期、
// 技能没有 description（于是永远搜不到它）、名字撞车（`skill_load` 需要 `repo` 提示）。
// 这些都能从库里算出来，但它们原先只藏在工具返回值里，要用户自己想出该问 agent 什么。
//
//   node tools/doctor.mjs                  # 从 DSH_HOME / 主目录推导，或 --root 指定
//   node tools/doctor.mjs --root <库根>
//   node tools/doctor.mjs --json           # 机器可读
//
// 退出码：0 = 健康（可以有警告），1 = 有需要处理的问题，2 = 用法错误。
//
// 零依赖。它复用 `build-index.mjs` 的扫描器而不是自己再走一遍目录——两套扫描逻辑就会漂移，
// 而"索引与磁盘是否一致"正是这个工具存在的理由。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildIndexRows } from './build-index.mjs'

/** 索引里的一行拆成字段：BOM、外层引号、CSV 引号与制表符都要按插件的规则处理。 */
export function parseIndexRows(text) {
  const rows = []
  const strip = (value) => String(value ?? '').replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim()
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim() === '') continue
    const fields = splitFields(raw)
    const repo = strip(fields[0])
    const name = strip(fields[2])
    if (repo === 'repo' && name === 'name') continue
    const relpath = strip(fields[1]).replace(/\\/g, '/')
    if (name === '' || relpath === '') continue
    rows.push({ repo, relpath, name, description: strip(fields[3]) })
  }
  return rows
}

/** 与 host.js 的 splitFields 同一套规则：引号内的制表符不是分隔符，`""` 是一个引号。 */
function splitFields(line) {
  const fields = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === '\t') {
      fields.push(current)
      current = ''
      continue
    }
    current += ch
  }
  fields.push(current)
  return fields
}

/** 找一个库根：显式 --root > $DSH_HOME/.skill-src > 主目录/.skill-src > 当前目录下。 */
export function findLibraryRoot(explicit) {
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(resolve(explicit))
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : undefined
  const userHome = process.env.USERPROFILE !== undefined && process.env.USERPROFILE !== '' ? process.env.USERPROFILE : process.env.HOME
  if (home !== undefined) candidates.push(join(home, '.skill-src'))
  if (userHome !== undefined && userHome !== '') candidates.push(join(userHome, '.skill-src'))
  candidates.push(join(process.cwd(), '.skill-src'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'skill-index.tsv'))) return candidate
  }
  return undefined
}

/**
 * 体检。
 *
 * @param root - 库根目录。
 * @returns 一份可读的报告对象；`problems` 非空即应让退出码为 1。
 */
export function diagnose(root) {
  const indexFile = join(root, 'skill-index.tsv')
  const report = { root, indexFile, indexExists: existsSync(indexFile), onDisk: 0, repos: 0, indexed: 0, stale: [], missing: [], duplicates: [], noDescription: [], generated: undefined, indexBytes: 0, problems: [], warnings: [] }

  // 磁盘上有什么（复用生成器的扫描器，索引器的判断才可能与生成器一致）
  const built = buildIndexRows(root)
  report.onDisk = built.rows.length
  report.repos = built.repos
  report.generated = built.rows
  report.warnings = built.warnings

  if (report.indexExists === false) {
    report.problems.push('索引不存在，插件会报"找不到技能库"。跑 `node tools/build-index.mjs ' + root + '` 生成。')
    return report
  }
  report.indexBytes = statSync(indexFile).size
  const indexed = parseIndexRows(readFileSync(indexFile, 'utf8'))
  report.indexed = indexed.length

  // 过期 / 缺失：按"能不能解析到真实文件"判断，而不是只比条数——条数相同也可能全错。
  const onDiskKeys = new Set(built.rows.map((row) => row.repo + '|' + row.relpath))
  for (const row of indexed) {
    const key = row.repo + '|' + row.relpath
    const skillFile = join(root, row.repo, row.relpath, 'SKILL.md')
    if (existsSync(skillFile) === false) {
      report.stale.push({ name: row.name, path: row.repo + '/' + row.relpath, why: '索引里有，磁盘上没有' })
      continue
    }
    if (onDiskKeys.has(key) === false) report.stale.push({ name: row.name, path: row.repo + '/' + row.relpath, why: '扫描器找不到它（可能是索引手写或路径写错）' })
  }
  const indexedKeys = new Set(indexed.map((row) => row.repo + '|' + row.relpath))
  for (const row of built.rows) {
    if (indexedKeys.has(row.repo + '|' + row.relpath) === false) report.missing.push({ name: row.name, path: row.repo + '/' + row.relpath })
  }

  // 重名：`skill_load` 需要 `repo` 才能消歧，所以这个数字对用户是可操作的
  const byName = new Map()
  for (const row of built.rows) {
    const list = byName.get(row.name) ?? []
    list.push(row.repo)
    byName.set(row.name, list)
  }
  for (const [name, repos] of byName) {
    if (repos.length > 1) report.duplicates.push({ name, copies: repos.length, repos: [...new Set(repos)] })
  }

  // 没有 description 的技能永远搜不到：这不是警告，是功能性缺陷
  for (const row of built.rows) {
    if (String(row.description ?? '') === '') report.noDescription.push({ name: row.name, path: row.repo + '/' + row.relpath })
  }

  if (report.stale.length > 0) report.problems.push(report.stale.length + ' 条索引记录在磁盘上找不到（索引过期或路径写错）')
  if (report.missing.length > 0) report.problems.push(report.missing.length + ' 个技能在磁盘上但不在索引里（搜不到它们）')
  if (report.indexed === 0) report.problems.push('索引里一条记录都没有')
  if (report.noDescription.length > 0) report.warnings.push(report.noDescription.length + ' 个技能没有 description（检索语料为空，搜不到它）')
  if (report.duplicates.length > 0) report.warnings.push(report.duplicates.length + ' 个名字有多份（skill_load 需要 repo 消歧）')
  return report
}

/** 人读的报告。 */
export function renderReport(report) {
  const lines = []
  const pad = (label) => (label + ' ').padEnd(14, ' ')
  lines.push('技能库体检')
  lines.push('')
  lines.push(pad('库：') + report.root)
  lines.push(pad('索引：') + (report.indexExists ? report.indexFile + '（' + report.indexBytes + ' 字节）' : '不存在'))
  lines.push(pad('技能：') + report.onDisk + ' 个，来自 ' + report.repos + ' 个仓库')
  lines.push(pad('已索引：') + report.indexed + ' 条' + (report.indexExists === false ? '' : report.indexed === report.onDisk ? '（与磁盘一致）' : '（磁盘上有 ' + report.onDisk + ' 个）'))
  if (report.stale.length > 0) lines.push(pad('过期：') + report.stale.length + ' 条')
  if (report.missing.length > 0) lines.push(pad('缺失：') + report.missing.length + ' 个')
  if (report.duplicates.length > 0) lines.push(pad('重名：') + report.duplicates.length + ' 个名字')
  lines.push(pad('无描述：') + report.noDescription.length + ' 个')
  lines.push('')

  const section = (title, items, format) => {
    if (items.length === 0) return
    lines.push(title)
    for (const item of items.slice(0, 8)) lines.push('  ' + format(item))
    if (items.length > 8) lines.push('  …还有 ' + (items.length - 8) + ' 项')
    lines.push('')
  }
  section('索引过期（磁盘上找不到）：', report.stale, (item) => item.name + '  ' + item.path + '  — ' + item.why)
  section('磁盘上有但索引里没有（搜不到）：', report.missing, (item) => item.name + '  ' + item.path)
  section('重名（skill_load 需要 repo 提示）：', report.duplicates, (item) => item.name + ' × ' + item.copies + '  ' + item.repos.join(', '))
  section('没有 description（永远搜不到）：', report.noDescription, (item) => item.name + '  ' + item.path)

  if (report.problems.length === 0) {
    lines.push('结论：健康' + (report.warnings.length > 0 ? '（有 ' + report.warnings.length + ' 项提醒，见上）' : ''))
    if (report.indexed !== report.onDisk) lines.push('提示：索引与磁盘条数不同，跑 `node tools/build-index.mjs ' + report.root + '` 重新生成。')
  } else {
    lines.push('结论：有 ' + report.problems.length + ' 项需要处理')
    for (const problem of report.problems) lines.push('  · ' + problem)
    lines.push('')
    lines.push('修索引：node tools/build-index.mjs ' + report.root)
  }
  return lines.join('\n')
}

/**
 * 命令行入口。返回退出码。
 *
 * `io` 可注入，理由同 `build-index.mjs`：测试要反复调用它，输出不该混进测试日志。
 */
export function main(argv, io) {
  const log = (io && io.log) || console.log
  const err = (io && io.error) || console.error
  const rootIndex = argv.indexOf('--root')
  const explicit = rootIndex >= 0 ? argv[rootIndex + 1] : undefined
  if (rootIndex >= 0 && (explicit === undefined || explicit.startsWith('--'))) {
    err('用法: node tools/doctor.mjs [--root <技能库根>] [--json]')
    return 2
  }
  const root = findLibraryRoot(explicit)
  if (root === undefined) {
    err('找不到技能库（在 <DSH_HOME>/.skill-src、<主目录>/.skill-src、<当前目录>/.skill-src 里都没有 skill-index.tsv）')
    err('用 --root <技能库根> 指定，或先跑 `node tools/build-index.mjs <技能库根>` 建一个。')
    return 2
  }
  const report = diagnose(root)
  if (argv.includes('--json')) {
    // 不带 generated：那是整棵库的明细，`--json` 是给脚本读状态用的。
    const { generated, ...rest } = report
    process.stdout.write(JSON.stringify({ ...rest, generated: undefined }, null, 2) + '\n')
  } else {
    process.stdout.write(renderReport(report) + '\n')
  }
  return report.problems.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
