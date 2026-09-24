// `dsh.engines.dsh` 的范围检查。
//
// 这个文件来自一次真实的事故形状：范围写着 `>=0.1.5-rc.1`，看起来"从那以后都支持"，但 node-semver
// 的预发布规则**静默拒绝**了之后每一个 patch 的 rc：
//
//   satisfies('>=0.1.5-rc.1', '0.1.5-rc.2') = true
//   satisfies('>=0.1.5-rc.1', '0.1.7-rc.1') = false   ← 上游升级后就会变成这样
//
// 规则（读 `semver/classes/range.js` 得到的）：一个带预发布标签的版本，只有在**某个比较符的
// major.minor.patch 元组与之完全相同、且该比较符自身也带预发布标签**时才被放行。所以"覆盖所有
// 0.1.x 的 rc"必须为每个 tuple 显式写一个带预发布的分支，没有捷径。
//
// 这个仓库零依赖，所以这里不引入 semver：用一个够用的判定 + 从 DSH 安装处取真实的 semver 来交叉验证。
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = new URL('../', import.meta.url)
const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const range = manifest.dsh && manifest.dsh.engines ? manifest.dsh.engines.dsh : undefined
console.log('引擎范围检查:')
ok('声明了 dsh.engines.dsh', typeof range === 'string' && range !== '', String(range))

// 上游发布过的版本（写死，因为这里要能在离线 CI 里跑）。每一个都必须被接纳。
const published = [
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
]
// 明确不该被接纳的：下一个 minor 的预发布与正式版。
const rejected = ['0.2.0-0', '0.2.0', '0.3.0-0', '0.0.9']

/** 找 DSH 安装里的真实 semver（只读，用来交叉验证）。 */
function findSemver() {
  const candidates = []
  // 从 DSH_HOME / 用户主目录推导，而不是写死某台机器的路径：这个仓库有一条测试专门禁止
  // 本机绝对路径进代码，而"为了测试方便"绕过它等于把那条规则废掉。
  const homes = [process.env.DSH_HOME, process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, '.dsh'), process.env.HOME === undefined ? undefined : join(process.env.HOME, '.dsh')]
  for (const home of homes) {
    if (home === undefined || home === '') continue
    candidates.push(join(home, 'profiles', 'node_modules', 'semver'))
    candidates.push(join(home, 'profiles', 'desktop', 'node_modules', 'semver'))
  }
  // 打包安装：从本仓库往上找不到，所以只探父目录里的 node_modules（不写死盘符）。
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (let i = 0; i < 4 && dir !== ''; i += 1) {
    candidates.push(join(dir, 'node_modules', 'semver'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.js'))) return candidate
  }
  return undefined
}

// ── 结构检查（离线也能跑）────────────────────────────────────────────────────────
// 每条 OR 分支都必须自带预发布标签，否则它覆盖不到那个 tuple 的 rc —— 这正是当初漏掉的点。
const branches = String(range).split('||').map((s) => s.trim()).filter((s) => s !== '')
const bareBranches = branches.filter((b) => /-/.test(b) === false)
ok('每条 OR 分支都带预发布标签（否则覆盖不到该 tuple 的 rc）', bareBranches.length === 0, bareBranches.join(' | '))
const tuples = new Set()
for (const b of branches) {
  for (const m of b.matchAll(/(\d+)\.(\d+)\.(\d+)-/g)) tuples.add(m[1] + '.' + m[2] + '.' + m[3])
}
ok('范围覆盖 0.1.5 / 0.1.6 / 0.1.7 三个 tuple', ['0.1.5', '0.1.6', '0.1.7'].every((t) => tuples.has(t)), [...tuples].join(', '))
ok('范围上界不含 0.2（下一个 minor 应被排除）', /<0\.2\.0-0/.test(String(range)) && />=0\.2/.test(String(range)) === false, String(range))

// ── 用真实 semver 交叉验证（机器上有 DSH 时装）────────────────────────────────────
const semverPath = findSemver()
if (semverPath === undefined) {
  console.log('  --  没找到 DSH 安装里的 semver，跳过实测（结构检查已通过）')
} else {
  const require = createRequire(pathToFileURL(semverPath))
  const semver = require(semverPath)
  const missing = published.filter((v) => semver.satisfies(v, range) === false)
  ok('接纳全部 ' + published.length + ' 个已发布版本', missing.length === 0, '被拒: ' + missing.join(', '))
  const admitted = rejected.filter((v) => semver.satisfies(v, range))
  ok('拒绝 ' + rejected.length + ' 个不该接纳的版本', admitted.length === 0, '被误纳: ' + admitted.join(', '))
  // 安装里的 harness 版本必须落在范围内 —— 这就是"升级后不会变成声明失配"的直接检查。
  // 从 semver 的位置逐级向上找 @deepseek-ai/dsh-tools：pnpm 会把依赖放在不同深度，
  // 写死层数会在换包管理器时静默跳过这条断言（第一版就是这么漏掉的）。
  let probe = semverPath
  let installed
  for (let i = 0; i < 6 && installed === undefined; i += 1) {
    const candidate = join(probe, '..', '@deepseek-ai', 'dsh-tools', 'package.json')
    if (existsSync(candidate)) installed = candidate
    const parent = dirname(dirname(probe))
    if (parent === probe || parent === '') break
    probe = parent
  }
  if (installed === undefined) {
    console.log('  --  没定位到已装的 @deepseek-ai/dsh-tools，跳过"已装版本在范围内"这一条')
  } else {
    const version = JSON.parse(readFileSync(installed, 'utf8')).version
    ok('本机已装的 harness ' + version + ' 落在范围内', semver.satisfies(version, range), 'range=' + String(range))
  }
}

console.log(problems.length === 0 ? '\n引擎范围检查: OK' : '\n引擎范围检查 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
