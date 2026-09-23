// The two READMEs carry equal authority, so they must not drift. This checks that the
// Chinese side still covers every section of the English side and that both are linked to
// each other. It does not compare prose — only the structure that readers navigate by.
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const en = read('README.md')
const zh = read('README.zh.md')
const problems = []

// 1. Cross-links in both directions.
if (!en.includes('[中文](README.zh.md)')) problems.push('README.md does not link to README.zh.md')
if (!zh.includes('[English](README.md)')) problems.push('README.zh.md does not link to README.md')

// 2. Same heading skeleton, in the same order (heading text differs by language).
const headings = (text) => [...text.matchAll(/^(#{1,3}) (.+)$/gm)].map((match) => match[1].length)
const enHeads = headings(en)
const zhHeads = headings(zh)
if (enHeads.length !== zhHeads.length) {
  problems.push(`heading count differs: en=${enHeads.length} zh=${zhHeads.length}`)
} else if (enHeads.join() !== zhHeads.join()) {
  problems.push(`heading levels differ: en=[${enHeads}] zh=[${zhHeads}]`)
}

// 3. The same number of fenced code blocks and table rows, so no example or parameter was dropped.
const fences = (text) => (text.match(/^```/gm) ?? []).length
if (fences(en) !== fences(zh)) problems.push(`fenced block markers differ: en=${fences(en)} zh=${fences(zh)}`)
const tableRows = (text) => (text.match(/^\|/gm) ?? []).length
if (tableRows(en) !== tableRows(zh)) problems.push(`table rows differ: en=${tableRows(en)} zh=${tableRows(zh)}`)

// 4. Facts that must appear verbatim in both: tool names, limits, the index header, install specs.
const shared = [
  'skill_search',
  'skill_load',
  'dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router',
  'private: true',
  'skill-index.tsv',
  'additionalProperties',
  'boot-safety.mjs',
  'SKILL_LIBRARY_ROOT',
  'npm test',
  'dsl',
]
for (const fact of shared) {
  if (fact === 'dsl') continue // placeholder guard, not a real fact
  if (!en.includes(fact)) problems.push(`README.md is missing ${JSON.stringify(fact)}`)
  if (!zh.includes(fact)) problems.push(`README.zh.md is missing ${JSON.stringify(fact)}`)
}

console.log(`README.md: ${en.split('\n').length} lines, ${enHeads.length} headings, ${fences(en) / 2} fenced blocks, ${tableRows(en)} table rows`)
console.log(`README.zh.md: ${zh.split('\n').length} lines, ${zhHeads.length} headings, ${fences(zh) / 2} fenced blocks, ${tableRows(zh)} table rows`)
console.log(problems.length === 0 ? 'docs parity: OK' : 'docs parity FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
