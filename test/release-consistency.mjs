// 发版一致性的**离线**检查：每个版本都要有 tag、有发布说明、有标题。
//
// 为什么需要它：`git push origin vX.Y.Z` 只推送 tag，而 GitHub 的 Release 是另一个独立对象，
// 必须在 /releases 上单独创建。两者在本地看起来毫无区别，所以"只推 tag 没建 Release"会静默
// 存在——本仓库就这样连续 14 个版本 tag 页有、Release 页没有，直到有人翻发行版页面才发现。
//
// Release **本身**的存在与否要联网查，不适合放进 `npm test`（CI 只有 contents: read 且应能离线
// 跑）。所以这里查的是本地可判定的部分，联网那半由 `node tools/publish-release.mjs --check` 负责
// （见 RELEASING.md 的检查清单）。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(root + file, 'utf8')
const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

console.log('发版一致性:')

// --- 版本号两处一致（package.json 与 client.js 印在界面上的那个）-------------------
const pkg = JSON.parse(read('package.json'))
const clientVersion = (read('client.js').match(/const VERSION\s*=\s*'([^']+)'/) || [])[1]
ok('package.json 与 client.js 的版本号一致', clientVersion === pkg.version, 'client=' + String(clientVersion) + ' package=' + String(pkg.version))

// --- 当前版本必须有发布说明 ------------------------------------------------------
const currentNotes = 'docs/release-notes-v' + pkg.version + '.md'
ok('当前版本有发布说明文件', existsSync(root + currentNotes), currentNotes)

// --- 每个发布说明的 H1 必须以自己的版本号开头（Release 标题直接取它）---------------
const notes = readdirSync(root + 'docs').filter((n) => /^release-notes-v.+\.md$/.test(n))
const badHeading = []
for (const name of notes) {
  const version = name.replace(/^release-notes-v/, '').replace(/\.md$/, '')
  const first = read('docs/' + name).split('\n')[0]
  if (first.startsWith('# v' + version + ' ') === false) badHeading.push(name + ' → ' + first.slice(0, 50))
}
ok('每份发布说明的标题都以自己的版本号开头（Release 标题取自此）', badHeading.length === 0, badHeading.join('; '))

// --- 每个发布说明都必须是双语的（中文在前 + ## English）--------------------------
const notBilingual = notes.filter((name) => {
  const text = read('docs/' + name)
  return /[\u4e00-\u9fff]/.test(text.split('\n')[0]) === false || text.includes('## English') === false
})
ok('每份发布说明都双语（中文标题 + ## English）', notBilingual.length === 0, notBilingual.join(', '))

// --- 发版流程文档与脚本都必须存在 ------------------------------------------------
ok('RELEASING.md 存在（记录 tag 与 Release 是两步）', existsSync(root + 'RELEASING.md'))
ok('tools/publish-release.mjs 存在（第 5 步做成一条命令）', existsSync(root + 'tools/publish-release.mjs'))

// --- 有 tag 的版本不该缺发布说明 -------------------------------------------------
// 只读本地 tag：CI 检出时不带 tag，所以取不到就跳过，不把"取不到"当成失败。
let tags = []
try {
  tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter((s) => s !== '')
} catch {
  console.log('  --  本地没有 git（或未取到 tag），跳过 tag↔发布说明的对照')
}
if (tags.length > 0) {
  const tagged = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  const missing = tagged.filter((t) => notes.includes('release-notes-' + t + '.md') === false)
  ok('每个版本 tag 都有对应的发布说明（' + tagged.length + ' 个 tag）', missing.length === 0, missing.join(', '))
}

console.log(problems.length === 0 ? '\n发版一致性: OK' : '\n发版一致性 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
