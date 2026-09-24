// 校验 workflow 的令牌权限与 action 固定版本。
//
// 路径必须相对本文件解析。写死绝对路径曾让这个脚本在作者机器上"恰好"通过
// （工作目录正好是那个包），却在 CI 的 /home/runner 上第一步就 ENOENT 崩掉。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
if (!existsSync(dir)) {
  console.error('workflow directory not found: ' + dir)
  process.exit(1)
}

const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
const problems = []

if (files.length === 0) problems.push('no workflow files found under ' + dir)

for (const name of files) {
  const text = readFileSync(join(dir, name), 'utf8')
  const lines = text.split('\n')
  console.log('=== ' + name + '  (' + lines.length + ' lines)')

  // 顶层键必须顶格，缩进不得用 tab
  if (/\t/.test(text)) problems.push(`${name}: contains a tab character (YAML forbids tabs for indentation)`)
  const topLevel = lines.filter((l) => /^[a-zA-Z]/.test(l)).map((l) => l.split(':')[0])
  console.log('  top-level keys: ' + topLevel.join(', '))
  for (const key of ['name', 'on', 'jobs', 'permissions']) {
    if (!topLevel.includes(key)) problems.push(`${name}: missing top-level "${key}"`)
  }
  if (topLevel.filter((k) => k === 'permissions').length !== 1) problems.push(`${name}: "permissions" must appear exactly once`)

  // permissions 必须是显式的最小集合，且不能是 write-all / read-all。
  // 只取紧跟其后的更深缩进块——朴素地"取之后所有缩进行"会把同样缩进的 jobs: 一起吞掉。
  const permIndex = lines.findIndex((l) => l.startsWith('permissions:'))
  const permBlock = []
  for (let i = permIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^\s+\S/.test(line)) break // 回到顶层键，permissions 块结束
    permBlock.push(line)
  }
  const granted = permBlock.map((l) => l.trim().split(':')[0])
  console.log('  permissions: ' + (permBlock.length === 0 ? '(none) → 非法' : permBlock.map((l) => l.trim()).join(', ')))
  if (permBlock.length === 0) problems.push(`${name}: permissions block declares nothing`)
  if (granted.includes('write-all')) problems.push(`${name}: permissions grants write-all`)
  for (const line of permBlock) {
    const [scope, value] = line.trim().split(':').map((part) => part.trim())
    if (value !== 'read') problems.push(`${name}: ${scope} is "${value}" — this workflow only reads`)
  }

  // job 必须用固定版本（或用 SHA），不能是浮动的 @main
  for (const m of text.matchAll(/uses:\s*(\S+)/g)) {
    const spec = m[1]
    if (!/@v\d+(\.\d+)*$/.test(spec) && !/@[0-9a-f]{40}$/.test(spec)) {
      problems.push(`${name}: action "${spec}" is not pinned to a version tag or SHA`)
    }
  }
}

console.log(problems.length === 0 ? '\nworkflow config: OK' : '\nworkflow config FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
