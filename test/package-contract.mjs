// 发布前契约核对。
//
// 这个检查存在的原因很直接：这个插件让 DSH **启动失败过两次**（v1.6.0 顶层 return、
// v1.6.1 不注册），两次都不是业务逻辑错，而是**包元数据/入口形状**错。这类错误 CI 里
// 十八项测试全都抓不到，因为它们测的是 host.js 的行为，而失败发生在加载器读 package.json
// 和拼接客户端半的时候。
//
// 所以这里核对的是"加载器会读的每一样东西"：
//   1. package.json 里的 exports / main / dsh.client / dsh.bundle / files
//   2. client.js 是否满足拼接经典脚本的契约（可编译、自己调用 load、factory 内 require、声明 inject）
//   3. host.js 的导出形状
//   4. cordis 组合行
//
// 只读本仓库，不读别人的包，所以它可以进 npm test。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const pkgDir = fileURLToPath(new URL('../', import.meta.url))
const problems = []
const ok = (label, pass, detail) => {
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + ' ' + label + (pass || detail === undefined ? '' : ' — ' + detail))
  if (!pass) problems.push(label)
}

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

console.log('=== package.json ===')
ok('exports["."] 指向 ./host.js', manifest.exports['.'] === './host.js', String(manifest.exports['.']))
ok('exports["./client"] 指向 ./client.js', manifest.exports['./client'] === './client.js', String(manifest.exports['./client']))
ok('main 指向 ./host.js', manifest.main === './host.js', String(manifest.main))
ok('dsh.bundle.patch 已声明', manifest.dsh.bundle.patch !== undefined)
ok('dsh.client.platform 为 "web"', manifest.dsh.client !== undefined && manifest.dsh.client.platform === 'web', JSON.stringify(manifest.dsh.client))
ok('files 列出 host.js 与 client.js（否则不会随包发布）', manifest.files.includes('host.js') && manifest.files.includes('client.js'), JSON.stringify(manifest.files))
ok('private: true（本插件从 GitHub 发布，不上 npm）', manifest.private === true)
ok('没有运行时依赖', manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, JSON.stringify(manifest.dependencies || {}))

console.log('')
console.log('=== exports 解析到的文件存在 ===')
const clientFile = join(pkgDir, manifest.exports['./client'])
const hostFile = join(pkgDir, manifest.exports['.'])
ok('client.js 存在', existsSync(clientFile), clientFile)
ok('host.js 存在', existsSync(hostFile), hostFile)

console.log('')
console.log('=== client.js 的打包契约 ===')
const clientSource = readFileSync(clientFile, 'utf8')
// 注释里会引用这些序列（本文件顶部就在解释两次失败），所以计数必须在**剥掉注释的代码**上做。
// 会报告文档的检查器，人们会靠删文档来满足它。
const clientCode = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

let compileError
try {
  new Script(clientSource)
} catch (error) {
  compileError = error
}
ok('作为拼接经典脚本可编译（顶层 return 会让整个 bundle 崩）', compileError === undefined, compileError === undefined ? undefined : String(compileError.message).slice(0, 80))

const loadCalls = (clientCode.match(/window\.__ModuleLoader__\.load\(/g) || []).length
ok('代码里恰有一次 window.__ModuleLoader__.load( 调用', loadCalls === 1, '出现 ' + loadCalls + ' 次')
ok('注册 id 与包名一致', clientCode.includes("id: '" + manifest.name + "'"))
ok('factory 接收 require 并在内部取 react（此处没有 React 全局）', /factory:\s*\(require\)\s*=>/.test(clientCode) && clientCode.includes("require('react')"))
ok('导出 inject 含 slots（服务按插件声明激活，不声明则 ctx.get 拿不到）', /inject:\s*\[\s*'slots'\s*\]/.test(clientCode))
ok('没有顶层 return', clientCode.split('\n').every((line) => /^return\b/.test(line) === false))
ok('没有顶层 import/export', /^\s*(import|export)\b/m.test(clientCode) === false)
ok('不引用任何 @deepseek-ai/* 包', clientCode.includes('@deepseek-ai/') === false)
ok('不碰 node: 内建', /node:[a-z/]+/.test(clientCode) === false)

console.log('')
console.log('=== host.js 的宿主契约 ===')
const hostSource = readFileSync(hostFile, 'utf8')
ok('导出 apply', /export function apply\s*\(/.test(hostSource))
ok('导出 name', /export const name\s*=/.test(hostSource))
ok('导出 inject', /export const inject\s*=/.test(hostSource))

console.log('')
console.log('=== cordis 组合行 ===')
const patch = readFileSync(join(pkgDir, manifest.dsh.bundle.patch), 'utf8')
ok('patch 含 insert', /insert:/.test(patch))
ok('patch 的行 name 是包名', patch.includes('name: ' + manifest.name))

console.log('')
console.log(problems.length === 0 ? 'package contract: OK' : 'package contract FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
