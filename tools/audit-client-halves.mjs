// 诊断本机所有客户端半是否符合 DSH 的真实加载契约。
//
//   node tools/audit-client-halves.mjs [profileNodeModules]
//
// 默认扫桌面 profile 的 node_modules。这个工具存在的原因：本插件让 DSH 启动失败过两次，
// 两次都是客户端半的打包契约错，而报错只点名"HMR 没注册"——真正坏掉的那一份在列表中间，
// 需要逐一核对才看得出来。把全部客户端半并排列出，差异一眼可见。
//
// 三项契约（打包器只做拼接，没有 per-file 包装，所以每项都得由文件自己满足）：
//   1. 作为**经典脚本**可编译 —— 顶层 return 是 SyntaxError，会让整个 bundle 崩
//   2. 顶层调用 window.__ModuleLoader__.load({ id, factory }) —— 否则"能跑但不注册"
//   3. factory(require) 内部取依赖，插件对象导出 inject —— 服务按插件声明激活
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const root = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
if (existsSync(root) === false) {
  console.error('no such directory: ' + root)
  console.error('pass the profile node_modules path that holds the composed plugins')
  process.exit(1)
}

// 不要用 isDirectory() 过滤。profile 把插件以 junction 链接进来，而在 Windows 上
// junction 的 isDirectory() 为 false（它是 reparse point），于是这个过滤器会**静默跳过
// 恰好是链接的那些包**——包括本插件自己。跳过目标的检查比没有检查更糟，因为它会报告"全部通过"。
// 只问一件事：这里有没有可读的 package.json。
const entries = readdirSync(root, { withFileTypes: true })
  .map((entry) => entry.name)
  .filter((name) => name.startsWith('@') === false)

const rows = []
for (const name of entries) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const declared = manifest.exports === undefined ? undefined : manifest.exports['./client']
  const entry = typeof declared === 'string' ? declared : declared === undefined ? undefined : declared.default
  if (typeof entry !== 'string') continue

  const path = join(root, name, entry)
  const row = { name: manifest.name, exists: existsSync(path) }
  if (row.exists) {
    const source = readFileSync(path, 'utf8')
    try {
      new Script(source)
      row.compiles = true
    } catch (error) {
      row.compiles = false
      row.compileError = String(error.message).slice(0, 44)
    }
    // 注释里会引用注册序列，所以计数在剥掉注释的代码上做。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    row.loads = (code.match(/window\.__ModuleLoader__\.load\(/g) || []).length
    const idMatch = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*["']([^"']+)["']/s)
    row.id = idMatch === null ? '(未内联 id)' : idMatch[1]
    row.requires = [...new Set([...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))].filter((r) => r.includes('${') === false)
    const injectMatch = code.match(/inject:\s*\[([^\]]*)\]/)
    row.inject = injectMatch === null ? '(未声明)' : injectMatch[1].replace(/\s+/g, ' ').trim()
  }
  rows.push(row)
}

const pad = (value, width) => String(value).padEnd(width)
console.log('scanning ' + root)
console.log('')
console.log(pad('包', 28) + pad('经典脚本', 11) + pad('load()', 8) + pad('inject', 20) + 'require')
console.log('-'.repeat(96))
for (const row of rows) {
  if (row.exists === false) {
    console.log(pad(row.name, 28) + '入口文件不存在')
    continue
  }
  console.log(
    pad(row.name, 28) +
      pad(row.compiles ? 'ok' : 'FAIL ' + row.compileError, 11) +
      pad(row.loads, 8) +
      pad(row.inject, 20) +
      (row.requires.length === 0 ? '(无)' : row.requires.join(',')),
  )
}

console.log('')
console.log('注册 id:')
for (const row of rows) if (row.exists !== false) console.log('  ' + pad(row.name, 28) + ' -> ' + row.id)

const broken = rows.filter((row) => row.exists === false || row.compiles === false || row.loads === 0)
console.log('')
if (broken.length === 0) {
  console.log('全部 ' + rows.length + ' 个客户端半满足三项契约')
} else {
  console.log('有问题: ' + broken.map((row) => row.name).join(', '))
  console.log('没有 load() 调用的那份，在 bundle 里"能跑但不注册"——正是启动失败时报的')
  console.log('"loaded without registering <id>"，而被点名的那一份通常不是坏掉的那一份。')
  process.exitCode = 1
}
