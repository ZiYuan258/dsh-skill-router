// 库风险审计：给 SECURITY.md 里那些统计数字提供**可重跑**的来源。
//
//   node tools/audit-library-risk.mjs [libraryRoot]
//
// 默认根目录是环境变量 SKILL_LIBRARY_ROOT，否则是当前工作目录。
// 政策里的每条数字都应能由这个脚本重新推导出来；库变了就重跑，而不是凭记忆引用旧结论。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? process.env.SKILL_LIBRARY_ROOT ?? process.cwd()
const indexDir = join(root, '.skill-src')

const files = []
const walk = (dir, depth) => {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'stageout') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, depth + 1)
    else if (entry.name === 'SKILL.md') files.push(path)
  }
}
walk(indexDir, 0)

if (files.length === 0) {
  console.error(`no SKILL.md found under ${indexDir}`)
  console.error('pass a workspace root that contains .skill-src/, or set SKILL_LIBRARY_ROOT')
  process.exit(1)
}

// A hit inside a fenced block is what a model may copy and run; a hit in prose is usually
// a security write-up describing the pattern rather than instructing it. The distinction is
// the whole point of this audit, so the report keeps the two counts apart.
const patterns = {
  'curl … | sh': /curl[^\n]{0,90}\|\s*(sudo\s+)?(ba)?sh/i,
  'rm -rf': /rm\s+-rf\s+\S/i,
  'environment variable read': /(OPENAI|ANTHROPIC|GITHUB|AWS|HF|AMAZON)[A-Z_]*API_KEY|process\.env\.[A-Z_]{3,}/,
  'eval / exec': /\beval\(|child_process\.exec|subprocess\.(run|Popen|call)\(/,
  '"ignore previous instructions"': /ignore (all )?previous instructions|disregard (the )?(above|previous)|you are now/i,
  'zero-width or hidden instruction': /\u200b|\u202e|<!--\s*ignore/i,
}

const report = {}
for (const key of Object.keys(patterns)) report[key] = { inCode: 0, inProse: 0, samples: [] }

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const inCode = (text.match(/```[\s\S]*?```/g) ?? []).join('\n')
  const prose = text.replace(/```[\s\S]*?```/g, '')
  for (const [key, re] of Object.entries(patterns)) {
    const code = re.test(inCode)
    const narrative = re.test(prose)
    if (!code && !narrative) continue
    if (code) report[key].inCode += 1
    if (narrative) report[key].inProse += 1
    if (report[key].samples.length < 3) report[key].samples.push(file.slice(root.length + 1))
  }
}

console.log(`scanned ${files.length} SKILL.md under ${indexDir}\n`)
console.log('pattern'.padEnd(34) + 'in code block'.padStart(14) + 'in prose'.padStart(10))
for (const [key, value] of Object.entries(report)) {
  console.log(key.padEnd(34) + String(value.inCode).padStart(14) + String(value.inProse).padStart(10))
}

console.log('\nexamples of hits inside code blocks (what a model may copy):')
let any = false
for (const [key, value] of Object.entries(report)) {
  for (const sample of value.samples) {
    console.log(`  ${key}\n      ${sample}`)
    any = true
  }
}
if (!any) console.log('  (none)')

console.log('\nnote: this plugin only reads files. It never executes what it reads, so the')
console.log('commands above matter because a model may act on them — that is the boundary')
console.log('your install review has to cover, not the plugin.')
