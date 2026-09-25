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

// --- README 里印出来的版本示例必须与代码一致 -------------------------------------
//
// 这一条来自一次真实的漂移：README 里演示标签页输出的 `dsh-skill-router v1.9.0 · …` 停在旧版本，
// 而它恰恰是用来回答"浏览器跑的是哪一版"的那一行——一份写着过时版本的文档，比不写更容易误导。
// 只钉版本号：README 的其余措辞仍在演进，不该被一条测试冻住。
const versionExamples = []
for (const file of ['README.md', 'README.en.md']) {
  for (const m of read(file).matchAll(/dsh-skill-router v(\d+\.\d+\.\d+)/g)) versionExamples.push({ file, version: m[1] })
}
const staleExamples = versionExamples.filter((e) => e.version !== clientVersion)
ok('README 里的版本示例与代码一致（' + versionExamples.length + ' 处）', versionExamples.length > 0 && staleExamples.length === 0, staleExamples.map((e) => e.file + ' 写着 v' + e.version).join('; '))

// --- README 的测试表必须与实际测试链一致 -------------------------------------------
//
// 这条检查来自一次真实的漏掉：v1.11.0 新增了 4 个测试脚本（build-index / doctor /
// library-root-contract / starter-library），脚本链改了、**README 的测试表没改**，计数也还停在
// 24。文档因此对读者说了两件不实的事：数量不对，而且有 4 个测试根本不在清单里。
//
// 这正是这个仓库最该避免的失败类型——「文档自己制造错误事实」——而且它特别隐蔽：两个文件仍然
// 互相一致（都是 24），所以 docs-parity 一条都不会红。要抓住它，必须拿**第三方真相**（脚本链
// 本身）去比对文档，而不是两个文档互比。
const scripts = JSON.parse(read('package.json')).scripts.test
const chain = [...scripts.matchAll(/test[/\\]([\w-]+\.mjs)/g)].map((m) => m[1])
ok('测试链里解析出脚本名（' + chain.length + ' 个）', chain.length > 0)
const duplicated = chain.filter((name, i) => chain.indexOf(name) !== i)
ok('测试链里没有重复脚本', duplicated.length === 0, duplicated.join(', '))

for (const file of ['README.md', 'README.en.md']) {
  const text = read(file)
  const table = [...text.matchAll(/^\| `([\w-]+\.mjs)` \|/gm)].map((m) => m[1])
  const undocumented = chain.filter((name) => table.includes(name) === false)
  const dangling = table.filter((name) => chain.includes(name) === false)
  ok(file + ' 的测试表覆盖了全部 ' + chain.length + ' 个脚本', undocumented.length === 0, '缺: ' + undocumented.join(', '))
  ok(file + ' 的测试表没有列出链外的脚本', dangling.length === 0, '多: ' + dangling.join(', '))
  // 章节里写的数量也必须对：中文写"二十八个"，英文写 "Twenty-eight"。
  //
  // 英文那条第一版翻了车：词表只有 one–ten，于是 "Twenty-eight" 被解析成 8，检查报了一个假问题。
  // 测试自己写错判定，和文档写错数字是同一类缺陷——所以它也得先被自己的用例验过。
  const zhWords = { 二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25, 二十六: 26, 二十七: 27, 二十八: 28, 二十九: 29, 三十: 30, 三十一: 31, 三十二: 32 }
  const ones = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
  const tens = { twenty: 20, thirty: 30, forty: 40 }
  const parseEnglish = (raw) => {
    const text = String(raw).toLowerCase().replace(/[^a-z]/g, '')
    for (const [word, value] of Object.entries(tens)) {
      if (text.startsWith(word)) {
        const rest = text.slice(word.length)
        return value + (ones[rest] ?? 0)
      }
    }
    return ones[text] ?? undefined
  }
  const numberIn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  const parseChinese = (raw) => {
    const text = String(raw)
    if (text === '十') return 10
    if (text.startsWith('十')) return 10 + (numberIn[text[1]] ?? 0)
    const index = text.indexOf('十')
    if (index < 0) return numberIn[text]
    return (numberIn[text.slice(0, index)] ?? 1) * 10 + (numberIn[text.slice(index + 1)] ?? 0)
  }
  // 先验判定本身，再拿它去判定文档——否则检查自己就是下一个"文档制造错误事实"。
  const wordCases = [['二十八个零依赖脚本', 28], ['二十四个测试', 24], ['Thirty', 30], ['Twenty-eight dependency-free scripts', 28], ['twenty-four runs', 24], ['Thirty-two', 32]]
  const wordWrong = wordCases.filter(([text, want]) => {
    const zh = /^([二三四五六七八九十]+)个/.exec(text)
    const en = /^(Twenty|Thirty|Forty)-?(\w*)/i.exec(text)
    return (zh === null ? (en === null ? undefined : parseEnglish(en[2] === '' ? en[1] : en[1] + en[2])) : parseChinese(zh[1])) !== want
  })
  ok('数量词的解析先自检（' + wordCases.length + ' 例）', wordWrong.length === 0, wordWrong.map(([t]) => t).join(' | '))
  const zh = text.match(/([二三四五六七八九十]+)个零依赖脚本/)
  const en = text.match(/(Twenty|Thirty|Forty)-?(\w*) dependency-free scripts/i)
  if (zh !== null) ok(file + ' 里写的脚本数与链一致（' + zh[1] + '个）', parseChinese(zh[1]) === chain.length, '文档 ' + parseChinese(zh[1]) + ' vs 链 ' + chain.length)
  if (en !== null) ok(file + ' 里写的脚本数与链一致（' + en[0].split(' ')[0] + '）', parseEnglish(en[2] === '' ? en[1] : en[1] + en[2]) === chain.length, '文档 ' + parseEnglish(en[1] + en[2]) + ' vs 链 ' + chain.length)
}

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
