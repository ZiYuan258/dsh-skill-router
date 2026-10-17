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
// 这个仓库零依赖，所以这里不引入 semver：自己实现一个够用的 satisfies（见文件下半段）。
// 已装 harness 的版本问 CLI 自己（\`dsh --version\`）——DSH 0.2 把包放在 asar 与 pnpm 链接
// 后面，磁盘上没有稳定的版本清单文件。
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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
  // 0.2.x 线：0.1.7-rc.2 之后上游进 0.2，本机装着的就是 0.2.1-rc.2。
  '0.2.0-rc.1', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1',
]
// 明确不该被接纳的：下一个 minor（0.3）的预发布与正式版，以及更低的 0.0.x。
// 注意 0.2.2+ 的**预发布**不在范围内（semver 的 tuple 规则要求逐一列举），这是已知边界；
// 一旦它成为真实安装版，下面那条"已装版本在范围内"会报出来。
const rejected = ['0.3.0-0', '0.3.0', '0.0.9']

// ── 结构检查（离线也能跑）────────────────────────────────────────────────────────
// 每条 OR 分支都必须自带预发布标签，否则它覆盖不到那个 tuple 的 rc —— 这正是当初漏掉的点。
const branches = String(range).split('||').map((s) => s.trim()).filter((s) => s !== '')
const bareBranches = branches.filter((b) => /-/.test(b) === false)
ok('每条 OR 分支都带预发布标签（否则覆盖不到该 tuple 的 rc）', bareBranches.length === 0, bareBranches.join(' | '))
const tuples = new Set()
for (const b of branches) {
  for (const m of b.matchAll(/(\d+)\.(\d+)\.(\d+)-/g)) tuples.add(m[1] + '.' + m[2] + '.' + m[3])
}
ok('范围覆盖 0.1.5 / 0.1.6 / 0.1.7 / 0.2.0 / 0.2.1 五个 tuple', ['0.1.5', '0.1.6', '0.1.7', '0.2.0', '0.2.1'].every((t) => tuples.has(t)), [...tuples].join(', '))
ok('范围上界是 0.3（下一个 minor 应被排除）', /<0\.3\.0-0/.test(String(range)) && />=0\.3/.test(String(range)) === false, String(range))

// ── 版本判定：本仓库零依赖，这里实现一个只覆盖本项目范围形状的 satisfies ──────────
//
// 关键仍是 node-semver 的**预发布规则**：带预发布标签的版本，只有在某个比较符的
// major.minor.patch 元组与之完全相同、且该比较符自身也带预发布标签时才被放行。
function compareVersion(a, b) {
  const [coreA, preA] = String(a).split('-')
  const [coreB, preB] = String(b).split('-')
  const na = coreA.split('.').map(Number)
  const nb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1
  }
  if (preA === undefined && preB === undefined) return 0
  if (preA === undefined) return 1   // 正式版 > 预发布版
  if (preB === undefined) return -1
  if (preA === preB) return 0
  return preA < preB ? -1 : 1
}

function satisfies(version, range) {
  const value = String(version)
  const tuple = value.split('-')[0]
  const isPre = value.includes('-')
  for (const branch of String(range).split('||').map((s) => s.trim()).filter((s) => s !== '')) {
    let lower
    let upper
    for (const comparator of branch.split(/\s+/).filter((s) => s !== '')) {
      if (comparator.startsWith('>=')) lower = comparator.slice(2)
      else if (comparator.startsWith('<')) upper = comparator.slice(1)
    }
    if (lower !== undefined && compareVersion(value, lower) < 0) continue
    if (upper !== undefined && compareVersion(value, upper) >= 0) continue
    if (isPre) {
      const sameTuple = [lower, upper].filter((c) => c !== undefined && c.includes('-') && c.split('-')[0] === tuple)
      if (sameTuple.length === 0) continue
    }
    return true
  }
  return false
}

const missing = published.filter((v) => satisfies(v, range) === false)
ok('接纳全部 ' + published.length + ' 个已发布版本', missing.length === 0, '被拒: ' + missing.join(', '))
const admitted = rejected.filter((v) => satisfies(v, range))
ok('拒绝 ' + rejected.length + ' 个不该接纳的版本', admitted.length === 0, '被误纳: ' + admitted.join(', '))

// ── 本机已装的 harness 必须落在范围内 ───────────────────────────────────────────
//
// 这就是"升级后不会变成声明失配"的直接检查。DSH 0.2 把包放在 asar 与 pnpm 链接后面
// （profiles/node_modules/@deepseek-ai/* 是指向 app 目录的链接，更新后可能悬空），
// 磁盘上没有稳定的版本清单文件，所以直接问 CLI 自己。取不到就跳过——CI 里没有 dsh。
// Windows 上 dsh 是 .cmd：不带 shell 的 spawn 启不动它（ENOENT），必须过一层 shell。
const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 20000, shell: true })
const raw = probe.status === 0 && typeof probe.stdout === 'string' ? probe.stdout.trim() : ''
const installedVersion = (raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) ?? [])[0]
if (installedVersion === undefined) {
  console.log('  --  取不到已装的 dsh 版本（dsh --version 不可用），跳过"已装版本在范围内"这一条')
} else {
  ok('本机已装的 harness ' + installedVersion + ' 落在范围内', satisfies(installedVersion, range), 'range=' + String(range))
}

console.log(problems.length === 0 ? '\n引擎范围检查: OK' : '\n引擎范围检查 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
