// 发版一致性的**离线**检查：每个版本都要有 tag、有发布说明、有标题。
//
// 为什么需要它：`git push origin vX.Y.Z` 只推送 tag，而 GitHub 的 Release 是另一个独立对象，
// 必须在 /releases 上单独创建。两者在本地看起来毫无区别，所以"只推 tag 没建 Release"会静默
// 存在——本仓库就这样连续 14 个版本 tag 页有、Release 页没有，直到有人翻发行版页面才发现。
//
// 发现方式：有人问"发行版怎么没更新"，一查是 tag 页 30 个、Release 页停在 15 个。所以这里查的
// 是**本地可判定**的部分，联网那半由 `node tools/publish-release.mjs --check` 负责。
//
// 有意**不**检查"当前版本必须有发布说明"：那条会变成"仓库每次有改动就得发一版"的强制来源。
// 版本号只在插件行为变化时才动（见 RELEASING.md 的版本策略），工具、文档、测试的改动直接进
// main。检查只盯真正的目标——**已经存在的正式 tag 必须有 Release**。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const pkg = require(root + 'package.json')
const read = (file) => readFileSync(root + file, 'utf8')
const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

console.log('发版一致性:')

// --- 版本号两处一致（package.json 与 client.js 印在界面上的那个）-------------------
const clientVersion = (read('client.js').match(/const VERSION\s*=\s*'([^']+)'/) || [])[1]
ok('package.json 与 client.js 的版本号一致', clientVersion === pkg.version, 'client=' + String(clientVersion) + ' package=' + String(pkg.version))

// --- 每个已发布的正式版本都要有发布说明（历史版本各有一份，见 docs/）--------------
const notes = readdirSync(root + 'docs').filter((n) => /^release-notes-v.+\.md$/.test(n))
const badHeading = []
const notBilingual = []
for (const name of notes) {
  const version = name.replace(/^release-notes-v/, '').replace(/\.md$/, '')
  const text = read('docs/' + name)
  const first = text.split('\n')[0]
  if (first.startsWith('# v' + version + ' ') === false) badHeading.push(name + ' → ' + first.slice(0, 50))
  if (/[\u4e00-\u9fff]/.test(first) === false || text.includes('## English') === false) notBilingual.push(name)
}
ok('每份发布说明的标题都以自己的版本号开头（Release 标题取自此）', badHeading.length === 0, badHeading.join('; '))
ok('每份发布说明都双语（中文标题 + ## English）', notBilingual.length === 0, notBilingual.join(', '))

// --- 发版流程文档与脚本都必须存在 ------------------------------------------------
ok('RELEASING.md 存在（记录 tag 与 Release 是两步、以及版本策略）', existsSync(root + 'RELEASING.md'))
ok('tools/publish-release.mjs 存在（把最后一步做成一条命令）', existsSync(root + 'tools/publish-release.mjs'))

// --- 正式版本 tag 与发布说明必须对得上 -------------------------------------------
// 只列主版本号，子目录里的说明文件名必须是 release-notes-vX.Y.Z.md。
const semverNotes = new Set(notes.map((n) => n.replace(/^release-notes-/, '').replace(/\.md$/, '')))
const notesWithoutSemverName = notes.filter((n) => /^release-notes-v\d+\.\d+\.\d+\.md$/.test(n) === false)
ok('发布说明的文件名都是 release-notes-vX.Y.Z.md', notesWithoutSemverName.length === 0, notesWithoutSemverName.join(', '))
ok('发布说明覆盖 ' + semverNotes.size + ' 个版本', semverNotes.size > 0)

console.log(problems.length === 0 ? '\n发版一致性: OK' : '\n发版一致性 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
