// 两份 README 承载同等权威，所以不能让它们漂移。这个脚本检查中文侧（默认 README.md）
// 与英文侧（README.en.md）仍然覆盖同一套结构，并且互相链接。
// 不比较行文——两种语言本来就该读起来不同；只比较读者用来导航的结构与事实。
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const zh = read('README.md') // 中文是默认语言
const en = read('README.en.md')
const problems = []

// 1. 双向互链，且中文侧的语言切换行必须是第一行内容（中文在前）。
if (!zh.includes('[English](README.en.md)')) problems.push('README.md does not link to README.en.md')
if (!en.includes('[中文](README.md)')) problems.push('README.en.md does not link to README.md')
if (zh.split('\n')[2] !== '[English](README.en.md) | 中文') {
  problems.push('README.md must open with the language switcher, Chinese first')
}

// 2. 相同的标题骨架与顺序（标题文字随语言不同）。
const headings = (text) => [...text.matchAll(/^(#{1,3}) (.+)$/gm)].map((match) => match[1].length)
const zhHeads = headings(zh)
const enHeads = headings(en)
if (zhHeads.length !== enHeads.length) {
  problems.push(`heading count differs: zh=${zhHeads.length} en=${enHeads.length}`)
} else if (zhHeads.join() !== enHeads.join()) {
  problems.push(`heading levels differ: zh=[${zhHeads}] en=[${enHeads}]`)
}

// 3. 相同数量的代码块与表格行，确保没有实例或参数被漏掉。
const fences = (text) => (text.match(/^```/gm) ?? []).length
if (fences(zh) !== fences(en)) problems.push(`fenced block markers differ: zh=${fences(zh)} en=${fences(en)}`)
const tableRows = (text) => (text.match(/^\|/gm) ?? []).length
if (tableRows(zh) !== tableRows(en)) problems.push(`table rows differ: zh=${tableRows(zh)} en=${tableRows(en)}`)

// 4. 必须在两份里逐字出现的事实：工具名、安装 spec、索引文件名、限额、环境变量、返回字段。
const shared = [
  'skill_search',
  'skill_load',
  'skill_ref',
  'dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router',
  'private: true',
  'skill-index.tsv',
  'additionalProperties',
  'boot-safety.mjs',
  'SKILL_LIBRARY_ROOT',
  'npm test',
  'fallback',
  'matchCount',
  'truncated',
  'copies',
]
for (const fact of shared) {
  if (!zh.includes(fact)) problems.push(`README.md is missing ${JSON.stringify(fact)}`)
  if (!en.includes(fact)) problems.push(`README.en.md is missing ${JSON.stringify(fact)}`)
}

console.log(`README.md (zh): ${zh.split('\n').length} lines, ${zhHeads.length} headings, ${fences(zh) / 2} fenced blocks, ${tableRows(zh)} table rows`)
console.log(`README.en.md:   ${en.split('\n').length} lines, ${enHeads.length} headings, ${fences(en) / 2} fenced blocks, ${tableRows(en)} table rows`)
console.log(problems.length === 0 ? 'docs parity: OK' : 'docs parity FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
