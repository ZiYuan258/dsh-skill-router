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
import { createContext, Script } from 'node:vm'

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
ok('导出 inject 含 slots（服务按插件声明激活，不声明则 ctx.get 拿不到）', /inject:\s*\[[^\]]*'slots'/.test(clientCode))
// The ledger itself is not a service lookup: it arrives through the registration's `inject`,
// which the session-scoped slot calls with the scope's session id.
ok('标签页注册项声明了 inject', /inject:\s*bindUsageSource/.test(clientCode))
ok('没有顶层 return', clientCode.split('\n').every((line) => /^return\b/.test(line) === false))
ok('没有顶层 import/export', /^\s*(import|export)\b/m.test(clientCode) === false)
ok('不引用任何 @deepseek-ai/* 包', clientCode.includes('@deepseek-ai/') === false)
ok('不碰 node: 内建', /node:[a-z/]+/.test(clientCode) === false)

// 标签页会把版本号印在界面上，用来回答"浏览器跑的是哪一版"——bundle 带 immutable 缓存，而这个
// 文件既不能被 Node 测试 import、服务端字节又挡在 Desktop 的能力校验后面，所以"改动到底有没有
// 到页面"曾是无法回答的问题，代价是好几轮"还是卡住"（其实都是旧构建）。
// 标签能漂移就比没有标签更糟，所以这里把两者钉在一起。
const clientVersion = (clientCode.match(/const VERSION\s*=\s*'([^']+)'/) || [])[1]
ok('client.js 里印的版本与 package.json 一致', clientVersion === manifest.version, 'client=' + String(clientVersion) + ' package=' + String(manifest.version))

console.log('')
console.log('=== host.js 的宿主契约 ===')
const hostSource = readFileSync(hostFile, 'utf8')
ok('导出 apply', /export function apply\s*\(/.test(hostSource))
ok('导出 name', /export const name\s*=/.test(hostSource))
ok('导出 inject', /export const inject\s*=/.test(hostSource))

// --- polynomial-backtracking regexes (js/polynomial-redos) ---------------------------
//
// CodeQL found `/\/+$/` in normName and it was right: anchored at `$`, the engine retries from
// every start position, so N slashes not ending in a slash cost O(N²) — measured at ~2,000 ms
// for 64,000 slashes against ~0 ms for the loop that replaced it. The finding was real but it
// arrived by luck, and the same expression sat unnoticed in client.js, where CodeQL does not
// look because a Client bundle is not the analysed entry. Hence this scan.
//
// The rule is narrower than "quantifier before $", because that flags safe patterns too.
// A quantifier applied to a CHARACTER CLASS is unambiguous — `[a-z0-9-]*$` matches each
// character one way only, so there is nothing to backtrack into. What costs O(N²) is a
// quantifier whose repetition can be re-divided over the same input: `/\/+$/` (a bare escaped
// character) and `/(a+)+$/` (a group) both qualify.
//
// So: a regex whose body ends in `+$` or `*$` is reported unless that quantifier follows a
// character class. The suffix check is two characters wide and says exactly which shape it
// allows, rather than trying to parse the pattern.
const regexLiteral = /\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g

for (const [label, source] of [['host.js', hostSource], ['client.js', clientSource]]) {
  const offenders = []
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    // The comments explain this very fix and quote the pattern; counting them would demand
    // deleting the explanation, which is the failure mode this repository keeps hitting.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const match of line.matchAll(regexLiteral)) {
      const body = match[0]
      if (/(?:\+|\*)\$/.test(body) === false) continue
      // The literal ends with `$/` (or `$/flags`), so the shape to allow is `]*$/`: the
      // quantifier sits on a character class. Getting this suffix wrong the first time made
      // the exemption dead code, which the check's own failure reported.
      if (body.endsWith(']*$/') || /\]\*\$\/[gimsuy]*$/.test(body)) continue
      offenders.push('line ' + (index + 1) + ' ' + body)
    }
  })
  ok(label + ' 没有可回溯的量词紧邻行尾锚（多项式回溯）', offenders.length === 0, offenders.join('; '))
}

// The two halves must agree on how a name normalises, because the Host decides what loads and
// the Client only reports it: a divergence would show the tab naming a skill the loader never
// resolved. Both were changed in this release, so the equivalence is pinned by RUNNING both
// rather than by comparing their source text — a text diff is brittle against a `??` versus an
// explicit null check, which is exactly how the two copies already differ.
//
// The two are named differently on purpose: the Host's `normName` takes an already-narrowed
// value, while the Client's `normalizeSkillName` also has to survive whatever the ledger hands
// it. The behaviour is what has to match, and that is what is compared here.
const fnSourceOf = (source, names) => {
  for (const name of names) {
    const match = source.match(new RegExp('function ' + name + '\\(value\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}'))
    if (match !== null) return match[0]
  }
  return undefined
}
const hostNormSource = fnSourceOf(hostSource, ['normName'])
const clientNormSource = fnSourceOf(clientSource, ['normalizeSkillName', 'normName'])
ok('两半都还有名字规范化函数（重复实现，改动必须同时落两处）', hostNormSource !== undefined && clientNormSource !== undefined, 'host=' + (hostNormSource !== undefined) + ' client=' + (clientNormSource !== undefined))

if (hostNormSource !== undefined && clientNormSource !== undefined) {
  // Each needs its own helpers; run each in its own sandbox with just what it references.
  const runNorm = (fnSource, extra) => {
    const sandbox = { console }
    sandbox.globalThis = sandbox
    const script = new Script('(function () {\n' + extra + '\n' + fnSource + '\nreturn ' + fnSource.match(/function (\w+)/)[1] + '\n})()')
    return script.runInContext(createContext(sandbox))
  }
  const stripHelper = 'function stripTrailingSlashes(t) { let e = t.length; while (e > 0 && t.charCodeAt(e - 1) === 47) e -= 1; return e === t.length ? t : t.slice(0, e) }'
  // `Q:` throughout: the fictional drive the other fixtures use, so a normalising test never
  // reads as a real machine path to this repository's own no-local-paths scanner.
  const cases = ['gh-cli', '@scope/name/', 'dir/skill/SKILL.md', 'a///', 'semver/', '', '/', '//', 'Q:/lib/skills/gh-cli/SKILL.md', 'nested/deep/name/skill.md', 'no-extension']
  let hostFn
  let clientFn
  try {
    hostFn = runNorm(hostNormSource, stripHelper)
    // The Client copy calls `stripTrailingSlashes` too, so it needs the same stand-in helper.
    clientFn = runNorm(clientNormSource, stripHelper)
  } catch (error) {
    ok('两半的规范化函数都能被求值', false, String(error.message).slice(0, 80))
  }
  if (hostFn !== undefined && clientFn !== undefined) {
    const differences = []
    for (const input of cases) {
      const a = hostFn(input)
      const b = clientFn(input)
      if (a !== b) differences.push(JSON.stringify(input) + ' host=' + JSON.stringify(a) + ' client=' + JSON.stringify(b))
    }
    ok('两半的规范化在 ' + cases.length + ' 个用例上结果一致', differences.length === 0, differences.join('; '))
    ok('规范化仍能取出纯技能名', hostFn('Q:/lib/skills/gh-cli/SKILL.md') === 'gh-cli', JSON.stringify(hostFn('Q:/lib/skills/gh-cli/SKILL.md')))
  }
}

console.log('')
console.log('=== cordis 组合行 ===')
const patch = readFileSync(join(pkgDir, manifest.dsh.bundle.patch), 'utf8')
ok('patch 含 insert', /insert:/.test(patch))
ok('patch 的行 name 是包名', patch.includes('name: ' + manifest.name))

console.log('')
console.log(problems.length === 0 ? 'package contract: OK' : 'package contract FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
