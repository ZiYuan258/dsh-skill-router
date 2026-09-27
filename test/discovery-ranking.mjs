// 候选生成器的质量护栏：语料频率过滤、按名字去重、以及"有效 token"上的 tier 判定。
//
// 这个文件存在的理由是一次**实测的失败**。v1.12.0 注入的候选长这样：
//
//   turn 69  implement-task, implement-task, implement-task, huggingface-llm-trainer, add-task
//   turn 83  azure-identity-py, entra-agent-id, gke-workload-identity, secure-workflow-guide, academy-guide
//
// 而真机用户看到的那条更直接：`finding-google-skills` 在同一行提示里出现了**两次**。
//
// 两个根因，各自独立：
//
//   1. **零判别力的 token 参与评分。** 实测 1028 行的库里，`skill` 与 `skills` 命中
//      **1028/1028（100%）**。全库都有的词给每一行都加分，等于没加分——但它能赢下排序。
//   2. **同一技能的多份副本占多个名额。** 上游拼起来的库常有同名多份，`implement-task ×3`
//      就是它。`skill_load` 本来就有消歧机制，discovery 不该把同一个名字当成三个候选。
//
// 还有一条被这两个缺陷掩盖的推论：**tier 必须在去重之后、且在有效 token 上计算**。否则同一个
// 技能的三个副本可以互相充当 best/runner-up，而 `skill` 这种 100% 词可以充当"两个独立命中"之一。
import { existsSync, readFileSync } from 'node:fs'
import { dirname as dirnamePath, join as joinPath } from 'node:path'
import { corpusFrequency, discoverRows } from '../host.js'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? '  ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

/** 造一条索引行。 */
const row = (name, description, repo = 'upstream', whenToUse = '') => ({ name, description, repo, relpath: 'skills/' + name, files: '1', KB: '1', whenToUse })

console.log('候选生成器（语料过滤 / 去重 / tier）:')

// ── 1) 语料频率过滤：全库都有的词不得参与评分 ──────────────────────────────────
// 夹具刻意让 `skill` 出现在每一行（就像真库那样），并让一个真词只出现在一行。
const withCommon = [
  row('alpha-widgets', 'A skill about alpha widgets'),
  row('beta-gadgets', 'A skill about beta gadgets'),
  row('gamma-tools', 'A skill about gamma tools'),
  row('delta-utils', 'A skill about delta utils'),
  row('epsilon-lib', 'A skill about epsilon lib'),
]
const freqTask = 'skill alpha'
const before = corpusFrequency(withCommon, ['skill', 'alpha'])
ok('corpusFrequency 报道 100% 的词（skill: ' + (before.get('skill').ratio * 100) + '%）', before.get('skill').ratio === 1)
ok('corpusFrequency 报道只在一行出现的词（alpha: ' + (before.get('alpha').ratio * 100) + '%）', Math.abs(before.get('alpha').ratio - 1 / 5) < 1e-9)

const filtered = discoverRows(withCommon, freqTask, 5)
ok('全库词被丢弃并如实登记', filtered.ignoredTokens.some((x) => x.token === 'skill' && x.ratio === 1), JSON.stringify(filtered.ignoredTokens))
ok('有效 token 里不再有全库词', filtered.effectiveTokens.includes('skill') === false && filtered.effectiveTokens.includes('alpha') === true, JSON.stringify(filtered.effectiveTokens))
ok('候选是真正命中的那一个', filtered.candidates.length === 1 && filtered.candidates[0].name === 'alpha-widgets', JSON.stringify(filtered.candidates.map((c) => c.name)))

// 全部关键词都太常见 → 诚实地说"没有判别力"，而不是拿它们硬排一个榜
const allCommon = discoverRows(withCommon, 'skill', 5)
ok('全部关键词都无判别力时给出 no-discriminating-token', allCommon.reason === 'no-discriminating-token' && allCommon.candidates.length === 0, allCommon.reason)
ok('该情形不是 no-candidate（两者含义不同）', allCommon.reason !== 'no-candidate')

// 阈值边界：>= 80% 丢，< 80% 留。判据是 ratio <= 0.8 保留。
//
// 夹具要小心：凡是出现在**每一行**的词都是 100%，会被一并丢弃——第一版每个描述都写了 'skill z'，
// 于是两个词都是 100%，effectiveTokens 空，测的是"全丢"而不是"边界"。
const boundary = [
  row('b-one', 'widget alpha'),
  row('b-two', 'widget beta'),
  row('b-three', 'widget gamma'),
  row('b-four', 'widget delta'),   // widget = 4/5 = 80% → 丢弃
  row('b-five', 'gadget epsilon'), // alpha 只在这一行 → 保留
]
const atBoundary = discoverRows(boundary, 'widget alpha', 5)
// 语义先定清楚：**丢弃条件是"出现率 > 0.8"**，所以恰好 80% 保留。
// 我第一版把断言写成"恰好 80% 丢弃"——先写断言再核语义，顺序错了。出现率 80% 意味着仍有 20%
// 的判别力，保留它是可辩护的；翻过来（>= 0.8 丢）会让 80% 与 100% 一样被当成零信号。
ok('恰好 80%（4/5）保留（丢弃条件是严格大于 0.8）', atBoundary.effectiveTokens.includes('widget') === true, JSON.stringify(atBoundary.effectiveTokens))
ok('低于 80% 的词保留', atBoundary.effectiveTokens.includes('alpha') === true, JSON.stringify(atBoundary.effectiveTokens))
// 真正超过 80% 的：6 行里 5 行有（83%）
const overThreshold = [
  row('o-one', 'widget alpha'), row('o-two', 'widget beta'), row('o-three', 'widget gamma'),
  row('o-four', 'widget delta'), row('o-five', 'widget epsilon'), row('o-six', 'gadget zeta'),
]
const over = discoverRows(overThreshold, 'widget alpha', 5)
ok('超过 80%（5/6 = 83%）的词被丢弃', over.effectiveTokens.includes('widget') === false, JSON.stringify(over.effectiveTokens) + ' ' + JSON.stringify(over.ignoredTokens))
const belowBoundary = [
  row('b-one', 'widget alpha'),
  row('b-two', 'widget beta'),
  row('b-three', 'gadget gamma'),
  row('b-four', 'gadget delta'),   // widget = 2/4 = 50% → 保留
]
const kept = discoverRows(belowBoundary, 'widget alpha', 5)
ok('50%（2/4）的词保留', kept.effectiveTokens.includes('widget') === true, JSON.stringify(kept.effectiveTokens))

// ── 2) 按技能名去重：同一名字只占一个名额 ─────────────────────────────────────
const duplicated = [
  row('implement-task', 'implement a task quickly', 'repo-a'),
  row('implement-task', 'implement a task quickly', 'repo-b'),
  row('implement-task', 'implement a task quickly', 'repo-c'),
  row('huggingface-llm-trainer', 'train a model on huggingface'),
  row('add-task', 'add a task to the list'),
]
const deduped = discoverRows(duplicated, 'implement task', 5)
const names = deduped.candidates.map((c) => c.name)
ok('同名技能在候选里只出现一次', new Set(names).size === names.length, JSON.stringify(names))
ok('implement-task 只占一个名额（不是三个）', names.filter((n) => n === 'implement-task').length === 1, JSON.stringify(names))
ok('去重保留的是最高分那一份', deduped.candidates[0].name === 'implement-task')
ok('去重后其余名额留给别的技能', names.length >= 2, JSON.stringify(names))

// ── 3) tier 在去重之后计算：副本不能互相充当 best/runner-up ────────────────────
// 只有三份同一个技能。去重前 best 与 runner-up 分数相同 → 会被判成 NONE；
// 去重后只剩一个候选 → 也判 NONE。两种都不该是 HIGH，关键是"同分副本"没有把别的技能挤掉。
const onlyCopies = [
  row('same-skill', 'distinctive widget thing', 'repo-a'),
  row('same-skill', 'distinctive widget thing', 'repo-b'),
  row('other-skill', 'entirely different subject', 'repo-c'),
]
const copies = discoverRows(onlyCopies, 'distinctive widget', 5)
ok('唯一名字的候选数等于去重后的名字数', copies.candidates.length === new Set(copies.candidates.map((c) => c.name)).size)

// ── 4) tier 必须在**有效 token** 上计算（这是 100% 词能伪造 HIGH 的路径）────────
// 一个真词 + 一个全库词：旧逻辑会把"两个 token 命中"当作强信号，于是 HIGH。
// 新逻辑里全库词已被丢弃，只剩一个有效 token → 不该是 HIGH。
const forged = [
  row('real-target', 'alpha distinctive content', 'upstream'),
  row('noise-one', 'skill unrelated noise', 'upstream'),
  row('noise-two', 'skill more noise', 'upstream'),
  row('noise-three', 'skill yet more', 'upstream'),
  row('noise-four', 'skill and more', 'upstream'),
  row('noise-five', 'skill final', 'upstream'),
]
const forgedResult = discoverRows(forged, 'skill alpha', 5)
ok('全库词被丢弃后，伪 HIGH 不再成立', forgedResult.tier !== 'HIGH', 'tier=' + forgedResult.tier + ' effective=' + JSON.stringify(forgedResult.effectiveTokens))
ok('但真词仍然选出正确候选', forgedResult.candidates.some((c) => c.name === 'real-target'), JSON.stringify(forgedResult.candidates.map((c) => c.name)))

// ── 5) 真 HIGH 仍然成立（修复不能把所有东西都压成 NONE）──────────────────────
// 两个有判别力的词、其中一个命中 name、且明显领先第二名。
const genuine = [
  row('semgrep', 'static analysis security review for source code'),
  row('unrelated-one', 'cooking recipes for pasta'),
  row('unrelated-two', 'gardening in small spaces'),
  row('security-audit', 'security audit checklist'),
]
const genuineResult = discoverRows(genuine, 'semgrep security audit', 5)
ok('真正的高判别力候选仍是 HIGH（' + genuineResult.tier + '）', genuineResult.tier === 'HIGH', JSON.stringify({ tier: genuineResult.tier, c: genuineResult.candidates.map((c) => c.name + ':' + c.score) }))
// 这里不断言"semgrep 必须第一"：夹具里的 security-audit 两个词都命中**名字**（nameHits=2，权重 100/个），
// 比 semgrep 的 nameHits=1 分更高。两个候选都相关，排序合理——断言"必须第一"是我的判据错了，
// 不是代码错了。（真库上 semgrep 确实第一，那条断言在下面。）
ok('两个相关候选都在结果里', genuineResult.candidates.length === 2 && genuineResult.candidates.every((c) => ['semgrep', 'security-audit'].includes(c.name)), JSON.stringify(genuineResult.candidates.map((c) => c.name)))
ok('分数由 nameHits 主导：两个词都命中名字的排前', genuineResult.candidates[0].name === 'security-audit' && genuineResult.candidates[0].nameHits === 2, JSON.stringify(genuineResult.candidates.map((c) => c.name + ':' + c.nameHits)))

// ── 6) 与真库的一致性抽样（有真库时）─────────────────────────────────────────
// 真库路径从仓库位置推导，不写死——这个仓库有一条测试专门禁止本机绝对路径进代码，
// 而"为测试方便"放宽它等于把那条规则废掉（这个坑我自己踩了三次）。
const realIndex = (() => {
  const explicit = process.env.SKILL_LIBRARY_ROOT
  if (explicit !== undefined && explicit !== '') return joinPath(explicit, '.skill-src', 'skill-index.tsv')
  let dir = dirnamePath(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (let i = 0; i < 6; i += 1) {
    const candidate = joinPath(dir, '.skill-src', 'skill-index.tsv')
    if (existsSync(candidate)) return candidate
    const parent = dirnamePath(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
})()
let real = undefined
try {
  if (realIndex === undefined) throw new Error('no library')
  const text = readFileSync(realIndex, 'utf8').replace(/^\uFEFF/, '')
  real = text.split('\n').filter((l) => l.trim() !== '').slice(1).map((l) => {
    const f = l.split('\t').map((s) => s.replace(/^"|"$/g, ''))
    return { repo: f[0], relpath: f[1], name: f[2], description: f[3], files: f[4], KB: f[5], whenToUse: f[6] }
  })
} catch {
  real = undefined
}
if (real === undefined) {
  console.log('  --  本机没有真库，跳过真库抽样')
} else {
  // 这两个词在真库里的频率就是当初发现问题的证据
  const stats = corpusFrequency(real, ['skill', 'skills', 'task', 'agent'])
  ok('真库：skill 是 100% 词（' + (stats.get('skill').ratio * 100).toFixed(0) + '%）', stats.get('skill').ratio === 1)
  ok('真库：skills 是 100% 词（' + (stats.get('skills').ratio * 100).toFixed(0) + '%）', stats.get('skills').ratio === 1)

  // 修复后的真库行为：技术任务应当选出真的相关的技能
  const audit = discoverRows(real, 'Run a semgrep security audit on this repo and summarise the findings', 5)
  ok('真库：安全审计任务把 semgrep 排第一', audit.candidates[0] !== undefined && audit.candidates[0].name === 'semgrep', JSON.stringify(audit.candidates.map((c) => c.name).slice(0, 3)))
  const review = discoverRows(real, 'review my code before merging this PR', 5)
  ok('真库：代码审查任务把 code-review 类排前', review.candidates[0] !== undefined && /code-review/.test(review.candidates[0].name), JSON.stringify(review.candidates.map((c) => c.name).slice(0, 3)))
  ok('真库：任何任务的候选名都不重复', [audit, review].every((r) => { const n = r.candidates.map((c) => c.name); return new Set(n).size === n.length }))
  const zh = discoverRows(real, '帮我修这个失败的测试', 5)
  ok('真库：中文任务仍是 no-searchable-token', zh.reason === 'no-searchable-token', zh.reason)
}

console.log(problems.length === 0 ? '\n候选生成器: OK' : '\n候选生成器 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
