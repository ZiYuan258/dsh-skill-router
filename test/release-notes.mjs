// 更新日志的语言约定：每份都是双语，且**中文在前**（英文挂在 `## English` 之下）。
// 靠自觉守不住，所以固化成断言。README 的结构一致性由 docs-parity.mjs 负责，这个文件只管
// 发布说明。
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../docs/', import.meta.url)
const problems = []
const notes = readdirSync(dir).filter((name) => /^release-notes-v.+\.md$/.test(name)).sort()

if (notes.length === 0) problems.push('docs/ holds no release-notes-v*.md files')

const hasCjk = (text) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text)

for (const name of notes) {
  const text = readFileSync(new URL(name, dir), 'utf8')
  const lines = text.split('\n')
  const title = lines[0]
  const switcher = lines[2]
  const englishAt = lines.findIndex((line) => line.trim() === '## English')

  if (!title.startsWith('# v')) problems.push(`${name}: first line must be the version heading`)
  if (!hasCjk(title)) problems.push(`${name}: the heading must be Chinese (Chinese is the default language)`)
  if (switcher !== '[English](#english) | 中文') problems.push(`${name}: line 3 must be the switcher "[English](#english) | 中文", got ${JSON.stringify(switcher)}`)
  if (englishAt < 0) problems.push(`${name}: no "## English" section`)
  if (englishAt >= 0 && englishAt < lines.length / 3) problems.push(`${name}: the English section starts too early — Chinese must come first`)

  // 英文段必须真的有内容，不能是个空壳。
  if (englishAt >= 0 && lines.slice(englishAt).join('\n').trim().length < 200) {
    problems.push(`${name}: the English section looks empty`)
  }
  const chineseBody = englishAt >= 0 ? lines.slice(0, englishAt).join('\n') : text
  if (chineseBody.trim().length < 200) problems.push(`${name}: the Chinese section looks empty`)
}

console.log(`release notes checked: ${notes.length} (${notes.join(', ')})`)
console.log(problems.length === 0 ? 'release notes are bilingual, Chinese first: OK' : 'release notes FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
