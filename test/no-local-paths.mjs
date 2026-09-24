// 全仓扫描：可执行文件与配置里还有没有本机绝对路径。
//
// 只查代码与配置，不查 Markdown：README 里出现 Windows 路径是**示范**
// （"把库放在这里"），不是本机耦合。这条区分是有意的——早期版本连文档一起查，
// 结果 16 条报告里没有一条是真问题，检查器反而成了噪音。
//
// 这个检查存在的原因很直接：同一类错误已经发生四次（schema-forms、release-notes、
// index-format 的夹具、workflow-config），每次都靠 CI 才抓到。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const skipDirs = new Set(['.git', 'node_modules'])
// Markdown 故意排除；docs/ 下的发布说明也是文档。
const codeExtensions = ['.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.ps1', '.sh']
const patterns = [
  { label: 'Windows 本机绝对路径', re: /[A-Za-z]:[\\/](?:Users|DSH Desktop|Vibe coding)[^\s'"`)]*/g },
  { label: 'POSIX 家目录绝对路径', re: /\/home\/[a-z0-9_-]+\/[^\s'"`)]*/g },
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
    const text = readFileSync(path, 'utf8')
    for (const { label, re } of patterns) {
      for (const match of text.matchAll(re)) {
        const line = text.slice(0, match.index).split('\n').length
        hits.push({ file: path.slice(root.length), line, label, value: match[0].slice(0, 70) })
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
}
if (hits.length > 0) process.exitCode = 1
