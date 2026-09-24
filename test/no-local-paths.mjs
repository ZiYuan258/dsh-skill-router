// 全仓扫描：可执行文件与配置里还有没有本机绝对路径。
//
// 只查代码与配置，不查 Markdown：README 里出现 Windows 路径是**示范**
// （"把库放在这里"），不是本机耦合。这条区分是有意的——早期版本连文档一起扫，
// 结果 16 条报告里没有一条是真问题，检查器反而成了噪音。
//
// 这个检查存在的原因很直接：同一类错误已经发生四次（schema-forms、release-notes、
// index-format 的夹具、workflow-config），每次都靠 CI 才抓到。
//
// 判据刻意从宽：**任何盘符路径都算**，而不是只匹配作者那台机器的目录名。
// 前一版写死了 `Users|DSH Desktop|Vibe coding`，于是同一类错误换个用户名或换台
// CI 机器（`D:/ci/work/...`）就会静默漏过——一个只能抓住已经发生过的那个具体实例的
// 检查器，抓不住下一个。唯一放行的是**已写进文档的示例路径**，见 ALLOWED。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const skipDirs = new Set(['.git', 'node_modules'])
// This file is its own counter-example: its regexes and ALLOWED list are drive-letter
// shapes by construction. Scanning it would report the scanner, every run.
const skipFiles = new Set(['test/no-local-paths.mjs'])
// Markdown 故意排除；docs/ 下的发布说明也是文档。
const codeExtensions = ['.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.ps1', '.sh']

// 唯一允许存在的绝对路径：README 与报错提示里作为示例给出的占位写法。
// 每一条都要能对上文档里的说明，否则它就只是被白名单掩盖的本机耦合。
const ALLOWED = [
  /^D:\/work(\/|$)/i, // README 的 junction / 索引核对示例
  /^\/home\/me\/work(\/|$)/, // README 的 POSIX 对应示例
  /^\/path\/to(\/|$)/, // 文档与工具帮助文本里的通用占位
  /^X:\/$/i, // host.js 的 resolvePath 注释：描述盘符根，不是真实路径
  /^C:\/$/i, // test/verify.mjs 拿文件系统根当"走到顶也没有库"的测试点
  /^Q:\/lib(\/|$)/i, // test/skill-ref.mjs 的 resolvePath 夹具（Q: 是不存在的盘符）
  /^Q:\/etc(\/|$)/i, // 同上，`..` 逃逸用例的期望值
]

// 比对前把反向斜杠归一成 `/`，并把连续斜杠压成一个：JS 源码里的 `Q:\\lib\\…` 在
// 文本里是两个字符，源代码拼写与值本身都要能匹配同一条规则。
const isAllowed = (value) => {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return ALLOWED.some((re) => re.test(normalized))
}

const patterns = [
  // 盘符路径，排除 URL 的 scheme（https:// 里的 "s://" 会被这条正则误伤）。
  { label: 'Windows 盘符绝对路径', re: /(?<![A-Za-z0-9+])([A-Za-z]:[\\/][^\s'"`)\]}]*)/g },
  // POSIX 家目录。不匹配 /Users/<name>：那个形状在 macOS 上是家目录，但也是
  // DSH 自己的路径词汇，误报率高；Windows 与 Linux 已覆盖作者机器的两类写法。
  { label: 'POSIX 家目录绝对路径', re: /(\/home\/[a-z0-9_-]+\/[^\s'"`)\]}]*)/g },
]

const hits = []
const walk = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!codeExtensions.some((ext) => entry.name.endsWith(ext))) continue
    const rel = path.slice(root.length).replace(/\\/g, '/')
    if (skipFiles.has(rel)) continue
    const text = readFileSync(path, 'utf8')
    for (const { label, re } of patterns) {
      for (const match of text.matchAll(re)) {
        const value = match[1]
        if (isAllowed(value)) continue
        const line = text.slice(0, match.index).split('\n').length
        hits.push({ file: path.slice(root.length), line, label, value: value.slice(0, 70) })
      }
    }
  }
}
walk(root)

if (hits.length === 0) {
  console.log('no machine-specific absolute paths in code or config')
} else {
  console.log('machine-specific absolute paths found (' + hits.length + '):')
  for (const hit of hits) console.log(`  ${hit.file}:${hit.line}  [${hit.label}]  ${hit.value}`)
  console.log('\nIf a hit is a legitimate documented example, add it to ALLOWED in this file.')
}
if (hits.length > 0) process.exitCode = 1
