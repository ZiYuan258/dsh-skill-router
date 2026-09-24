// 为某个版本创建 GitHub Release —— 发版流程的第 5 步，也是最容易漏的一步。
//
// 为什么需要这个脚本：`git push origin vX.Y.Z` 只推送 **tag 对象**，而 GitHub 的 **Release**
// 是另一个独立对象，必须在 `/releases` 上单独创建。两者在本地看起来毫无区别（tag 都在、
// push 都成功），所以"只推了 tag 没建 Release"可以静默存在很久——本仓库就这样连续 14 个版本
// tag 页有、Release 页没有，直到有人翻发行版页面才发现。
//
// 把最后一步做成一条命令，是这类静默不一致唯一可靠的防法。
//
//   node tools/publish-release.mjs            # 当前 package.json 版本
//   node tools/publish-release.mjs --check    # 只报告状态，不创建（退出码 1 = 缺）
//   node tools/publish-release.mjs --all      # 回填所有缺 Release 的版本
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const read = (file) => readFileSync(new URL(file, root), 'utf8')

const repo = (() => {
  const pkg = JSON.parse(read('package.json'))
  const url = String(pkg.repository && pkg.repository.url ? pkg.repository.url : '')
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  if (m === null) throw new Error('tools/publish-release.mjs: package.json 里没有可解析的 GitHub 仓库地址')
  return { owner: m[1], name: m[2], url: m[1] + '/' + m[2] }
})()

/** `gh` 登录凭据；也接受 GH_TOKEN，方便在没有 gh 的环境里跑。 */
function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('需要 gh 已登录，或设置 GH_TOKEN 环境变量')
  }
}

const headers = (t) => ({ authorization: 'Bearer ' + t, accept: 'application/vnd.github+json', 'user-agent': 'publish-release', 'content-type': 'application/json' })

async function notesFor(version) {
  const file = 'docs/release-notes-v' + version + '.md'
  if (existsSync(new URL(file, root)) === false) throw new Error('缺少发布说明：' + file + '（发版流程第 2 步）')
  const text = read(file).trimEnd()
  const first = text.split('\n')[0]
  if (first.startsWith('# ') === false) throw new Error(file + ' 的第一行必须是 `# 标题`（docs parity 也要求中文标题）')
  return { title: first.replace(/^#\s*/, ''), body: text, file }
}

async function findRelease(t, version) {
  const res = await fetch(`https://api.github.com/repos/${repo.url}/releases/tags/v${version}`, { headers: headers(t) })
  if (res.status === 404) return undefined
  if (res.ok === false) throw new Error('查询 Release 失败：' + res.status + ' ' + (await res.text()).slice(0, 200))
  return res.json()
}

async function create(t, version, notes) {
  const res = await fetch(`https://api.github.com/repos/${repo.url}/releases`, {
    method: 'POST',
    headers: headers(t),
    body: JSON.stringify({ tag_name: 'v' + version, name: notes.title, body: notes.body, draft: false, prerelease: false }),
  })
  const json = await res.json()
  if (res.status !== 201) throw new Error('创建 Release 失败：' + res.status + ' ' + JSON.stringify(json).slice(0, 300))
  return json
}

/** 仓库里出现过的每个版本（以发布说明为准），从旧到新。 */
function allVersions() {
  return readdirSync(new URL('docs/', root))
    .map((n) => n.match(/^release-notes-v(.+)\.md$/))
    .filter((m) => m !== null)
    .map((m) => m[1])
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i]
      return 0
    })
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const all = args.includes('--all')
const version = JSON.parse(read('package.json')).version
const targets = all ? allVersions() : [version]

const t = token()
let missing = 0
for (const v of targets) {
  const existing = await findRelease(t, v)
  if (existing !== undefined) {
    console.log('ok    v' + v + '  Release 已存在（' + existing.published_at.slice(0, 10) + '）')
    continue
  }
  missing += 1
  if (checkOnly) {
    console.log('缺    v' + v + '  有 tag 但没有 Release —— 跑 `node tools/publish-release.mjs --all` 回填')
    continue
  }
  const notes = await notesFor(v)
  const created = await create(t, v, notes)
  console.log('新建  v' + v + '  ' + created.html_url)
}
if (checkOnly && missing > 0) {
  console.log('\n共 ' + missing + ' 个版本缺 Release。')
  process.exitCode = 1
}
