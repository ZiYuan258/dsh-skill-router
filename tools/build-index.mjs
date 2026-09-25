// 把一棵技能库扫成 `skill-index.tsv`——插件读的那份索引。
//
// 为什么要有这个文件：README 原来只给一段"参考实现"PowerShell，用户得自己复制、自己改 `$root`、
// 自己理解那 7 列是什么。索引格式本来是这个插件的**内部数据模型**，不该是安装流程的一部分。
//
//   node tools/build-index.mjs <技能库根>            # 生成/覆盖 <根>/skill-index.tsv
//   node tools/build-index.mjs <技能库根> --check    # 只报告是否与磁盘一致，不写文件（过期则退出码 1）
//   node tools/build-index.mjs <技能库根> --stdout   # 写到标准输出，不落地
//
// 零依赖：只用 node: 内置模块，和插件本身一样。生成的 TSV 用真正的转义规则写（字段含制表符、
// 引号或换行时加引号），因为描述里出现制表符就会把那一行拆错列——参考实现当初踩过这个坑。
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 索引列顺序，与 host.js 的 parseIndex 一致。`whenToUse` 可选，只有真的有值才写第 7 列。 */
const COLUMNS = ['repo', 'relpath', 'name', 'description', 'files', 'KB', 'whenToUse']

/** 一层目录一个"仓库"。库根下每个目录名就是 `repo` 列的值。 */
function topLevelRepos(root) {
  return readdirSync(root)
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

/** 递归找 SKILL.md，返回相对库根的 POSIX 风格路径。 */
function findSkillFiles(dir, root, out) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const full = join(dir, name)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      // 跳过版本控制与依赖目录：它们里面不会有技能，扫进去只会拖慢并可能误报。
      if (name === '.git' || name === 'node_modules' || name === '.svn') continue
      findSkillFiles(full, root, out)
      continue
    }
    if (name === 'SKILL.md') out.push(relative(root, full).split(sep).join('/'))
  }
  return out
}

/** 技能目录下的文件数与总字节数（用于 `files` 与 `KB` 两列）。 */
function measure(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    let names
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(current, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (name === '.git' || name === 'node_modules') continue
        walk(full)
        continue
      }
      files += 1
      bytes += info.size
    }
  }
  walk(dir)
  return { files, KB: Math.max(1, Math.round(bytes / 1024)) }
}

/**
 * 取 YAML frontmatter 的正文（`---` 之间的部分）。
 *
 * 只处理这一个形状，因为只有它是契约：**一个开头的 `---` 行，一个结束的 `---` 行**。缩进过的
 * frontmatter、或文档里后面出现的 `---` 分隔线，都不该被当元数据。BOM 与 CRLF 都容忍——两者在
 * Windows 上是常态，而这个仓库已经因为 BOM 出过一次表头变数据的 bug。
 */
function frontmatter(text) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (/^---[ \t]*\r?\n/.test(normalized) === false) return ''
  const after = normalized.slice(normalized.indexOf('\n') + 1)
  const end = after.search(/^---[ \t]*\r?\n?/m)
  return end < 0 ? '' : after.slice(0, end)
}

/**
 * YAML 标量 → 干净的一行文本，按 YAML 的规则反转义。
 *
 * 这个函数是"描述该怎么写进索引"的唯一定义处，因为插件的 `cleanDescription` 只做一层轻清理
 * （压空白、去块标量标记、去外层引号），**不做反转义**——索引里的描述必须是已经反转义好的句子。
 * 第一版这里只去外层引号，于是 `"Has a \"quote\" inside"` 原样带着反斜杠进了索引：
 *
 *   双引号 + 反斜杠转义  `"a \"q\" b"`   → 应为 a "q" b     （第一版给了 a \"q\" b）
 *   单引号 + 双写        `'a ''q'' b'`   → 应为 a 'q' b     （第一版给了 a ''q'' b）
 *
 * 两种都是 YAML 的合法写法，也都出现在真实技能库里。
 */
function scalar(raw) {
  const value = String(raw).trim()
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\/bfnrt])/g, (_, code) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[code])
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'").replace(/\s+/g, ' ').trim()
  }
  // 无引号（含块标量正文）：YAML 里没有转义，压平空白即可。
  return value.replace(/\s+/g, ' ').trim()
}

/** 从 frontmatter 取一个字段，支持同一行的标量，也支持其后的缩进续行（块标量）。 */
function field(block, key) {
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp('^' + key + ':[ \t]*').test(line))
  if (start < 0) return ''
  const first = lines[start].replace(new RegExp('^' + key + ':[ \t]*'), '')
  // 块标量（`>-`、`|` 等）：标记本身不是内容，正文是后面的缩进行，拼成一行。
  // 这个分支必须在 scalar() 之前：标记与内容要分开处理，不能一起丢给反转义。
  if (/^[>|][+-]?\s*$/.test(first.trim())) {
    const rest = []
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s+\S/.test(lines[i])) {
        rest.push(lines[i].trim())
        continue
      }
      break
    }
    return scalar(rest.join(' '))
  }
  // 首行有值就是简单标量，即使后面还有缩进行（那种情况属于畸形 frontmatter）。
  if (first.trim() !== '') return scalar(first)
  const rest = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s+\S/.test(lines[i])) {
      rest.push(lines[i].trim())
      continue
    }
    break
  }
  return rest.length === 0 ? scalar(first) : scalar(rest.join(' '))
}

/**
 * 扫一棵库，返回索引行（不含表头）。
 *
 * **`relpath` 相对仓库根，不相对库根。** 契约是"`repo` 列命名某一层目录、其下路径等于 `relpath`
 * 列"，插件按 `<库>/<repo>/<relpath>/SKILL.md` 拼路径。第一版这里传了库根进去，于是每一行都多套了
 * 一层 `repo/`——1028 行全部拼不出真实文件，而**行数完全正确**，所以计数类的检查一条都不会红。
 * 教训与这个仓库里出现过多次的相同：解析得到的东西要拿"能不能真的打开文件"去验，不是拿条数。
 *
 * @param root - 技能库根目录：其下每个目录是一个"仓库"。
 * @returns `{ rows, warnings, skills, repos }`；`warnings` 是必须让人看见的问题。
 */
export function buildIndexRows(root) {
  const rows = []
  const warnings = []
  const repos = topLevelRepos(root)
  for (const repo of repos) {
    const repoDir = join(root, repo)
    // 相对 repoDir 而不是 root —— 这是上面那段注释的全部要点。
    for (const relpath of findSkillFiles(repoDir, repoDir, [])) {
      const relDir = relpath.slice(0, Math.max(0, relpath.length - 'SKILL.md'.length)).replace(/\/$/, '')
      const dir = join(repoDir, relDir.split('/').join(sep))
      let text = ''
      try {
        text = readFileSync(join(root, repo, relpath.split('/').join(sep)), 'utf8')
      } catch (error) {
        warnings.push(repo + '/' + relpath + '：读不了（' + error.message + '）')
        continue
      }
      const block = frontmatter(text)
      const rawName = field(block, 'name')
      const description = field(block, 'description')
      const whenToUse = field(block, 'whenToUse')
      // 没有 name 就用目录名兜底：`skill_load` 的键必须是名字，而目录名在实践中总是对的。
      const name = rawName === '' ? (relDir.split('/').pop() ?? '') : rawName
      if (rawName === '') warnings.push(repo + '/' + relpath + '：frontmatter 里没有 name，已用目录名「' + name + '」')
      if (description === '') warnings.push(repo + '/' + relpath + '：没有 description（检索语料为空，搜不到它）')
      const { files, KB } = measure(dir)
      rows.push({ repo, relpath: relDir, name, description, files, KB, whenToUse })
    }
  }
  return { rows, warnings, skills: rows.length, repos: repos.length }
}

/** 一个 TSV 字段：含制表符、换行或引号时按 CSV 规则加引号（内部引号翻倍）。 */
function tsvField(value) {
  const text = String(value ?? '')
  if (/[\t\r\n"]/.test(text) === false) return text
  return '"' + text.replace(/"/g, '""') + '"'
}

/**
 * 渲染成 TSV 文本。
 *
 * `whenToUse` 只在**至少有一行**带值时写入，而且那时补齐所有行（缺的写空）。理由：列数是契约的
 * 一部分，一半有值一半没有的文件会让 CSV 解析器对不齐；而全库都没有这个字段时（实测参考库
 * 1025 个 SKILL.md 里 0 个有），少一列比多一列空列更干净。
 *
 * @param rows - `buildIndexRows` 的行。
 * @returns 以 LF 结尾的 TSV 文本（LF 是有意的：CRLF 会让某些解析器把 `\r` 留在最后一个字段里）。
 */
export function renderIndex(rows) {
  const useWhenToUse = rows.some((row) => String(row.whenToUse ?? '') !== '')
  const columns = useWhenToUse ? COLUMNS : COLUMNS.slice(0, 6)
  const lines = [columns.join('\t')]
  for (const row of rows) {
    lines.push(columns.map((column) => tsvField(row[column] ?? '')).join('\t'))
  }
  return lines.join('\n') + '\n'
}

/**
 * 命令行入口。返回进程退出码，便于测试直接调用。
 *
 * `io` 可注入：测试要在同一个进程里反复调用它，而这些输出不是被测对象——让它们混进测试日志会
 * 把真正该看的断言淹掉。默认仍是 console。
 */
export function main(argv, io) {
  const log = (io && io.log) || console.log
  const err = (io && io.error) || console.error
  const args = argv.filter((arg) => arg.startsWith('--') === false)
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
  const target = args[0]
  if (target === undefined) {
    err('用法: node tools/build-index.mjs <技能库根> [--check] [--stdout]')
    err('  技能库根 = 其下每个目录是一个上游仓库的目录（惯例是 <工作区>/.skill-src）')
    return 2
  }
  const root = resolve(target)
  if (existsSync(root) === false) {
    err('找不到目录: ' + root)
    return 2
  }
  const built = buildIndexRows(root)
  const text = renderIndex(built.rows)
  const indexFile = join(root, 'skill-index.tsv')
  for (const warning of built.warnings) err('警告: ' + warning)

  if (flags.has('--stdout')) {
    process.stdout.write(text)
    return 0
  }
  const previous = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : undefined
  // 只比较规范化后的内容：CRLF 与末尾空白不该被算成"有变化"，否则 --check 会在 Windows 上恒报过期。
  const same = previous !== undefined && previous.replace(/\r\n/g, '\n').trimEnd() === text.trimEnd()
  if (flags.has('--check')) {
    if (same) {
      log('索引与磁盘一致：' + built.skills + ' 个技能 / ' + built.repos + ' 个仓库')
      return 0
    }
    log(previous === undefined ? '索引不存在：' + indexFile : '索引已过期：' + indexFile)
    log('跑 `node tools/build-index.mjs ' + target + '` 重新生成。')
    return 1
  }
  if (same) {
    log('索引已是最新，未改动：' + built.skills + ' 个技能 / ' + built.repos + ' 个仓库')
    return 0
  }
  writeFileSync(indexFile, text, 'utf8')
  log('已写入 ' + indexFile)
  log('  ' + built.skills + ' 个技能 / ' + built.repos + ' 个仓库' + (previous === undefined ? '（新建）' : '（已更新）'))
  return 0
}

// 只有直接执行时才跑 main：被 import 时（测试）不能有副作用。
// 用 pathToFileURL 而不是手拼 `file://` + 反斜杠替换——Windows 盘符与空格都会被它正确处理。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
