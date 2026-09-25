// `js/polynomial-redos` 的回归护栏。
//
// 这个文件存在的理由是一条修了两次、第三次才修干净的告警：
//
//   alert #2  host.js:121  `text.replace(/\/+$/, '')`            → 改成循环，标记 fixed
//   alert #3  host.js:611  `String(cwd).replace(/[\\/]+$/, '')`  ← **同一个正则的另外四处**
//
// 修好告警指向的那一行，却留下四处一模一样的写法。"修好一条告警"与"修好一类缺陷"是两件事，
// 这个文件检查的是后者。
//
// ── 关于"能不能用正则去查这个形状"：不能，这里实测过 ──────────────────────────────
//
// 我先后写了五版形状检测器，每一版都把真危险判成安全或反之。实测最坏输入（N 个"该类能吃的"
// 字符 + 一个不属于该类的结尾）在 16,000 → 64,000 字符上的代价：
//
//   /[\\/]+$/      159 ms → 2,588 ms   (16×)   ← CodeQL 报的形状
//   /[a-z]+$/      178 ms → 2,577 ms   (15×)   ← 我第一版判成"安全：单区间"
//   /[a-z0-9-]*$/  158 ms → 2,604 ms   (16×)   ← 我判成"无害"
//   /x*$/          156 ms → 2,855 ms   (18×)   ← 连字符类都不是
//   /[^a-z]+$/      0.01 ms → 0.03 ms           ← 唯一真安全的是取反类
//
// 也就是说凡是"某物 + 量词 + $"，只要长串由该物能匹配的字符组成、末尾不匹配，就会二次增长。
// 形状检测因此没有意义——**能检查的是"这个形状只作用于有界输入"，而那是一句论证，不是一条正则。**
// 所以这里把论证写进清单并断言它不变，而不是假装能扫出形状。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

console.log('回溯护栏:')

// ── 1) 替代方案与它替代的正则逐例等价 ───────────────────────────────────────────
//
// 第一版的函数只删 `/`，而正则 `[\\/]+$` 删两种 —— 19 例里有 8 例不同，全是反斜杠结尾，
// 而不等价的第一个调用点读的正是 Windows 会话 cwd。等价性必须逐例断言，不能靠读代码点头。
const hostSource = readFileSync(join(root, 'host.js'), 'utf8')
const fnSource = (hostSource.match(/function stripTrailingSlashes\(text\) \{[\s\S]*?\n\}/) || [])[0]
ok('host.js 里能取到 stripTrailingSlashes 实现', fnSource !== undefined)
const stripTrailingSlashes = new Function(fnSource + '; return stripTrailingSlashes')()
// 路径由零件拼出来，而不是写成一整条字面量：仓库有一条测试禁止本机绝对路径进代码，
// 而"为了测试方便"放宽它等于把那条规则废掉。反斜杠用 String.fromCharCode(92) 免得再叠一层转义。
const BS = String.fromCharCode(92)
const drive = (letter) => letter + ':' + BS
const cases = [
  'a/', 'a' + BS, 'a//', 'a' + BS + BS,
  drive('C') + 'work' + BS + 'proj' + BS, drive('C') + 'work/proj/', drive('C') + 'work' + BS + 'proj',
  '/', BS, '//', BS + BS, '', 'a///b', 'a/b' + BS + BS, drive('D'), drive('D') + '/', 'D:',
  'a/b' + BS + '/' + BS, '/skill-index.tsv', drive('C') + 'Users' + BS + 'x' + BS + '.skill-src' + BS,
]
const mismatched = cases.filter((c) => c.replace(/[\\/]+$/, '') !== stripTrailingSlashes(c))
ok('与正则逐例等价（' + cases.length + ' 例，含反斜杠结尾）', mismatched.length === 0, mismatched.map((c) => JSON.stringify(c)).join(', '))

// ── 2) 最坏输入下没有二次增长 ──────────────────────────────────────────────────
const worst = (n) => '/'.repeat(n) + 'x'
const time = (fn, input) => {
  const started = process.hrtime.bigint()
  for (let i = 0; i < 5; i += 1) fn(input)
  return Number(process.hrtime.bigint() - started) / 5e6
}
const small = time(stripTrailingSlashes, worst(16000))
const large = time(stripTrailingSlashes, worst(64000))
const ratio = small === 0 ? 1 : large / small
ok('64,000 字符最坏输入为常数级（' + large.toFixed(4) + ' ms，比值 ' + ratio.toFixed(1) + '×）', large < 5 && ratio < 50)

// ── 3) 调用点确实走这个函数，而不是又写回了正则 ───────────────────────────────────
const callSites = (hostSource.match(/stripTrailingSlashes\(/g) || []).length - 1
ok('运行代码里有 ' + callSites + ' 个调用点（normName + 派生路径 + 显示路径 + cwd + 库根）', callSites >= 5, 'callSites=' + callSites)

// ── 4) 剩下那处正则的边界性论证 ─────────────────────────────────────────────────
//
// 全仓库唯一剩下的"某物 + 量词 + $"正则。它为什么可以留：`isSafeName` 只作用于**已规范化的
// 技能名**——来自本地索引文件或工具参数、经 normName 去掉路径与 `@` 前缀，长度是名字长度，
// 不是任意输入；而且它与 `$` 之间的字符集不含 `/`、`\`、空白，所以长串不可能由它构成。
//
// 检查方式是**逐行原文断言**，不是形状匹配。理由见文件开头：形状匹配在这件事上被实测证伪过
// 五轮，而"这一行的原文没变"是一个不会误报的事实。谁改动了这一行，这里就会红，逼一次重新论证。
const bounded = [
  { file: 'host.js', line: 159, text: 'return /^[a-z0-9][a-z0-9-]*$/.test(name)', why: 'isSafeName：已规范化的技能名，字符集不含分隔符与空白' },
]
for (const site of bounded) {
  const line = (readFileSync(join(root, site.file), 'utf8').split('\n')[site.line - 1] ?? '').trim()
  ok('有界正则原文未变 —— ' + site.file + ':' + site.line + '（' + site.why + '）', line === site.text, JSON.stringify(line.slice(0, 80)))
}

// ── 5) host.js 里"量词 + $"正则的条数不增加 ──────────────────────────────────────
//
// 这是这个文件最有用的一条：生产文件里每多一个这样的正则，就必须有人来做一次"输入是否有界"的
// 论证。计数是可靠的，形状判断不是。
const countTail = (source) => source.split('\n').filter((line) => {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false
  // 正则字面量里出现 `+$` 或 `*$`（转义写法也算）
  return /\/(?:[^/\n]|\\.)*[+*]\$/.test(line)
}).length
const tailCount = countTail(hostSource)
ok('host.js 里"量词 + $"正则的条数为 1（' + tailCount + '）', tailCount === 1, '每多一条都需要一次"输入是否有界"的论证')

console.log(problems.length === 0 ? '\n回溯护栏: OK' : '\n回溯护栏 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
