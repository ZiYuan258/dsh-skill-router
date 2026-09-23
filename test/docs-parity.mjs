// 双语是仓库的约定（中文为默认语言），而约定靠自觉守不住。
//
// 检查三组文档对：
//   1. README.md          ↔ README.en.md
//   2. SECURITY.md        ↔ SECURITY.zh.md
//   3. docs/release-notes-v*.md（单文件内双语，中文在前）
//
// 只比较读者用来导航的结构与必须逐字一致的事实，不比较行文——两种语言本来就该读起来不同。
import { readdirSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (file) => readFileSync(new URL(file, root), 'utf8')
const problems = []
const hasCjk = (text) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text)

const headings = (text) => [...text.matchAll(/^(#{1,3}) (.+)$/gm)].map((m) => m[1].length)
const fences = (text) => (text.match(/^```/gm) ?? []).length
const tableRows = (text) => (text.match(/^\|/gm) ?? []).length

/** 两份文件：相同的标题骨架、代码块数、表格行数，以及一组逐字相同的事实。 */
function checkPair(label, defaultFile, alternateFile, facts) {
  let a
  let b
  try {
    a = read(defaultFile)
    b = read(alternateFile)
  } catch (error) {
    problems.push(`${label}: cannot read a side (${error.message})`)
    return
  }

  const ha = headings(a)
  const hb = headings(b)
  if (ha.length !== hb.length) problems.push(`${label}: heading count differs (${ha.length} vs ${hb.length})`)
  else if (ha.join() !== hb.join()) problems.push(`${label}: heading levels differ ([${ha}] vs [${hb}])`)
  if (fences(a) !== fences(b)) problems.push(`${label}: fenced blocks differ (${fences(a)} vs ${fences(b)})`)
  if (tableRows(a) !== tableRows(b)) problems.push(`${label}: table rows differ (${tableRows(a)} vs ${tableRows(b)})`)

  for (const fact of facts) {
    if (!a.includes(fact)) problems.push(`${label}: ${defaultFile} is missing ${JSON.stringify(fact)}`)
    if (!b.includes(fact)) problems.push(`${label}: ${alternateFile} is missing ${JSON.stringify(fact)}`)
  }

  console.log(`  ${label}: ${ha.length} headings, ${fences(a) / 2} fenced blocks, ${tableRows(a)} table rows`)
}

console.log('bilingual pairs:')
checkPair('README', 'README.md', 'README.en.md', [
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
  'whenToUse',
  'explain',
  // 定位主张：两份都必须说清"只有大型库才需要它"，以及成本那组实测数字。
  '~30',
  '150k',
  '3,603 B',
  '1,001',
  '1,541',
  'agent/pre-step',
  'ctx.skills.list()',
])

checkPair('SECURITY', 'SECURITY.md', 'SECURITY.zh.md', [
  'eval',
  'ctx.fs',
  'resolvePath',
  'skill-ref.mjs',
  'boot-safety.mjs',
  '@deepseek-ai/*',
  'private: true',
  'curl',
  'rm -rf',
  '1025',
])

// 默认语言是中文：切换行必须是第一行内容，且链到对面。
if (!read('README.md').includes('[English](README.en.md)')) problems.push('README.md does not link to README.en.md')
if (!read('README.en.md').includes('[中文](README.md)')) problems.push('README.en.md does not link to README.md')
if (read('README.md').split('\n')[2] !== '[English](README.en.md) | 中文') {
  problems.push('README.md must open with the language switcher, Chinese first')
}

// 安全政策的中文侧是第一语言：中文标题、中文在前的切换行。
const zhSecurity = read('SECURITY.zh.md')
if (!hasCjk(zhSecurity.split('\n')[0])) problems.push('SECURITY.zh.md: the title must be Chinese')
if (zhSecurity.split('\n')[2] !== '[English](SECURITY.md) | 中文') {
  problems.push('SECURITY.zh.md: line 3 must be the switcher "[English](SECURITY.md) | 中文"')
}
if (!read('SECURITY.md').split('\n')[2].includes('SECURITY.zh.md')) {
  problems.push('SECURITY.md: the switcher on line 3 must link to SECURITY.zh.md')
}

// --- 发布说明：单文件双语，中文在前 -----------------------------------------
const notes = readdirSync(new URL('docs/', root)).filter((n) => /^release-notes-v.+\.md$/.test(n)).sort()
console.log('  release notes: ' + notes.length)
for (const name of notes) {
  const lines = read('docs/' + name).split('\n')
  const englishAt = lines.findIndex((line) => line.trim() === '## English')
  if (!hasCjk(lines[0])) problems.push(`${name}: the heading must be Chinese`)
  if (lines[2] !== '[English](#english) | 中文') problems.push(`${name}: line 3 must be the Chinese-first switcher`)
  if (englishAt < 0) problems.push(`${name}: no "## English" section`)
  else {
    if (englishAt < lines.length / 3) problems.push(`${name}: the English section starts too early`)
    if (lines.slice(englishAt).join('\n').trim().length < 200) problems.push(`${name}: the English section looks empty`)
    if (lines.slice(0, englishAt).join('\n').trim().length < 200) problems.push(`${name}: the Chinese section looks empty`)
  }
}

console.log(problems.length === 0 ? 'docs parity: OK' : 'docs parity FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
