// 实验读数脚本的测试。
//
// 这个脚本的价值集中在两件事上，缺一件实验就答不了问题：
//
// **一、不把"未知"当成"0 次"。** 按回合的计数天生右截断——
//
//   回合 10 开始 → 累计调用
//   回合 11 开始 → 才把回合 10 的数落盘
//
// 所以最后一个已完成的回合、以及中止/崩溃的回合**没有** turn-calls 记录。若把"没有记录"当成
// search=0，一个上升的搜索率会被算成没变化。
//
// **二、对照必须是同一类任务。** 曾经把"未注入"当对照——而注入与否由 tier 决定，于是"注入组"与
// "未注入组"在构造上就是不同任务总体（"做 Semgrep 安全审计" vs "今天天气怎么样"）。两组搜索率之
// 差说明不了提示的作用。真正的对照是**同样 HIGH、被随机分到 control** 的那些回合，所以下面大量
// 断言围绕"分臂"而不是"注入与否"。
//
// 另外钉住配对键：**必须是 (会话标签, 回合)**。实测真机日志里 `turn` 1 出现过 3 次、14 个 turn 号
// 被重复——只用 turn 会把不同会话合并。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, pairKey, pairTurns, summarise } from '../tools/discovery-report.mjs'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? '    ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

/** 一条发现记录。`arm` 是随机分配，`injected` 是实际是否注入了提示。 */
const disc = (turn, tier, extra = {}) => {
  const arm = extra.arm !== undefined ? extra.arm : tier === 'HIGH' ? 'treatment' : 'not-eligible'
  const injected = extra.injected !== undefined ? extra.injected : arm === 'treatment'
  // firstEligible 默认 true：夹具里的每个回合都当"该会话的第一个 eligible"，这样主指标分母＝回合数，
  // 断言最直观；需要测"后续回合"时显式传 firstEligible: false。
  const firstEligible = extra.firstEligible !== undefined ? extra.firstEligible : arm !== 'not-eligible'
  return JSON.stringify({ at: '2026-01-01T00:00:00.000Z', turn, step: 1, sessionKey: 'aaaa1111', tier, reason: 'ok', tokenCount: 3, effectiveTokenCount: 2, filteredCommonTokens: 1, ignoredTokenRatios: [1], indexRows: 1025, candidateCount: tier === 'NONE' ? 0 : 5, candidates: [], arm, injected, firstEligible, hintBytes: injected ? 330 : 0, ...extra })
}
/** 一条回合计数记录。 */
const call = (turn, search, load, extra = {}) => {
  const arm = extra.arm !== undefined ? extra.arm : 'treatment'
  return JSON.stringify({ at: '2026-01-01T00:00:00.000Z', kind: 'turn-calls', turn, sessionKey: 'aaaa1111', tier: arm === 'not-eligible' ? 'NONE' : 'HIGH', injected: arm === 'treatment', arm, skillSearchCalls: search, skillLoadCalls: load, skillRefCalls: 0, residentSkillCalls: 0, otherToolCalls: 3, ...extra })
}

console.log('实验读数:')

// ── 1) 配对：有计数才算 paired，没有就是 unpaired（unknown）────────────────────
const text1 = [disc(1, 'HIGH'), call(1, 1, 1), disc(2, 'HIGH'), disc(3, 'NONE'), call(3, 0, 0)].join('\n')
const p1 = pairTurns(text1)
ok('三条发现记录、两条计数记录', p1.discovery.length === 3 && p1.calls.size === 2)
ok('配对成功的是 turn 1 与 turn 3', p1.paired.length === 2 && p1.unpaired.length === 1)
ok('turn 2 无计数 → unpaired（不是 0 次）', p1.unpaired[0].turn === 2)
const s1 = summarise(p1)
ok('分母只算可配对的 eligible 回合（1，不是 3）', s1.experiment.primary.sessions === 1, 'eligible=' + s1.experiment.primary.sessions)
ok('非 HIGH 回合被排除在分臂外', s1.experiment.notEligiblePairedTurns === 1, 'notEligible=' + s1.experiment.notEligiblePairedTurns)
ok('① treatment 搜索率按 paired 算（1/1）', s1.experiment.primary.treatment.rate === 1, String(s1.experiment.primary.treatment.rate))
ok('② treatment 加载率按 paired 算（1/1）', s1.experiment.primary.treatment.load.rate === 1, String(s1.experiment.primary.treatment.load.rate))

// ── 1b) 同一回合多条记录：必须去重成**一个回合** ───────────────────────────────
//
// 这条是漏掉的覆盖，也正是它让一个真 bug 活了下来：第一版对每条发现记录都 push 一次，于是
// paired.length 是**记录数**而不是**回合数**，而注释却写着"取最后一条"。后果不是显示问题——
// eligiblePairedTurns / 各臂比率全部被重复计数，同一回合在分子分母里各算两次，足以把真实差异抹平。
const dupTurn = [disc(7, 'HIGH'), disc(7, 'HIGH'), call(7, 1, 0)].join('\n')
const pDup = pairTurns(dupTurn)
ok('同回合两条发现记录 → paired 只有 1（不是 2）', pDup.paired.length === 1, 'paired=' + pDup.paired.length)
ok('unpaired 也不会重复计数', pDup.unpaired.length === 0, 'unpaired=' + pDup.unpaired.length)
ok('分母是回合数（1），所以比率不被稀释', summarise(pDup).experiment.primary.treatment.rate === 1)
const lastWins = [disc(8, 'HIGH'), disc(8, 'NONE', { injected: false }), call(8, 1, 0, { injected: false, tier: 'NONE' })].join('\n')
ok('同回合取**最后一条**发现记录（tier 由它裁定）', pairTurns(lastWins).paired[0].tier === 'NONE')
const pFlush = pairTurns([disc(9, 'HIGH'), call(9, 2, 1), call(9, 1, 0)].join('\n'))
ok('同回合多条计数记录 → 逐项求和（search=3, load=1）', pFlush.paired[0].calls.skillSearchCalls === 3 && pFlush.paired[0].calls.skillLoadCalls === 1, JSON.stringify(pFlush.paired[0].calls))
ok('无计数的重复回合 → unpaired 只有 1', pairTurns([disc(10, 'HIGH'), disc(10, 'HIGH')].join('\n')).unpaired.length === 1)
ok('不同回合不受去重影响', pairTurns([disc(1, 'HIGH'), call(1, 1, 0), disc(2, 'HIGH'), call(2, 0, 1)].join('\n')).paired.length === 2)

// ── 2) 反例：错误地把 unpaired 当成 0，比率会被拉低 ────────────────────────────
// 3 个 treatment 回合，1 个有计数且搜了、2 个无计数。正确 = 1/1 = 100%；错误 = 1/3 = 33%。
const s2 = summarise(pairTurns([disc(1, 'HIGH'), call(1, 1, 0), disc(2, 'HIGH'), disc(3, 'HIGH')].join('\n')))
ok('未配对的回合被排除在分母外（正确算成 100%）', s2.experiment.primary.treatment.turns === 1 && s2.experiment.primary.treatment.rate === 1, JSON.stringify(s2.experiment.primary.treatment))
ok('未配对的回合仍被如实计数（2 个）', s2.records.unpaired === 2)

// ── 3) 分臂：这是实验的核心，也是修复"错误对照"的地方 ─────────────────────────
const arms = [disc(1, 'HIGH', { arm: 'treatment' }), call(1, 1, 1, { arm: 'treatment' }), disc(2, 'HIGH', { arm: 'control', injected: false }), call(2, 0, 0, { arm: 'control', injected: false })].join('\n')
const s3 = summarise(pairTurns(arms))
ok('treatment 与 control 分别统计', s3.experiment.primary.treatment.turns === 1 && s3.experiment.primary.control.turns === 1, JSON.stringify({ t: s3.experiment.primary.treatment.turns, c: s3.experiment.primary.control.turns }))
ok('treatment 搜了、control 没搜 → 差值可见', s3.experiment.primary.treatment.rate === 1 && s3.experiment.primary.control.rate === 0, JSON.stringify({ t: s3.experiment.primary.treatment.rate, c: s3.experiment.primary.control.rate }))
ok('两臂都进 eligible 门槛', s3.experiment.primary.sessions === 2, 'eligible=' + s3.experiment.primary.sessions)
ok('control 是合格对照，不与 not-eligible 混', s3.experiment.notEligiblePairedTurns === 0, 'notEligible=' + s3.experiment.notEligiblePairedTurns)
// 分配与实际注入冲突要被抓出来——否则"control"可能悄悄带着提示，整批数据作废
ok('control 却带了提示 → 记为冲突', summarise(pairTurns([disc(3, 'HIGH', { arm: 'control', injected: true }), call(3, 0, 0, { arm: 'control', injected: true })].join('\n'))).experiment.armViolations === 1)
ok('treatment 却没带提示 → 记为冲突', summarise(pairTurns([disc(4, 'HIGH', { arm: 'treatment', injected: false }), call(4, 0, 0, { arm: 'treatment', injected: false })].join('\n'))).experiment.armViolations === 1)
ok('正常数据 0 冲突', s3.experiment.armViolations === 0)
// 非 HIGH 一律不进分臂——这正是"用未注入当对照"的错误来源
const sMixed = summarise(pairTurns([disc(1, 'NONE', { injected: false }), call(1, 1, 0, { tier: 'NONE', arm: 'not-eligible', injected: false })].join('\n')))
ok('NONE 回合的搜索不计入任何一臂', sMixed.experiment.primary.treatment.turns === 0 && sMixed.experiment.primary.control.turns === 0, JSON.stringify(sMixed.experiment.primary.treatment))
ok('NONE 回合只进 not-eligible 计数', sMixed.experiment.notEligiblePairedTurns === 1)

// ── 4) 配对键必须是 (sessionKey, turn) ────────────────────────────────────────
const twoSessions = [disc(40, 'HIGH', { sessionKey: 'aaaa1111' }), call(40, 2, 0, { sessionKey: 'aaaa1111' }), disc(40, 'HIGH', { sessionKey: 'bbbb2222' }), call(40, 0, 1, { sessionKey: 'bbbb2222' })].join('\n')
const s4 = summarise(pairTurns(twoSessions))
ok('两个会话的同号回合各自配对（不合并）', s4.records.paired === 2, 'paired=' + s4.records.paired)
ok('同号回合的计数没有互相污染', s4.experiment.primary.treatment.turns === 2 && s4.experiment.primary.treatment.calls === 1 && s4.experiment.primary.treatment.load.calls === 1, JSON.stringify(s4.experiment.primary.treatment))
ok('pairKey 对缺会话标签的记录给出 (none) 而不是崩溃', pairKey({ turn: 40 }) === '(none)#40', pairKey({ turn: 40 }))

// ── 5) 旧记录（无会话标签）被单独计数，且能配对的仍然配对 ──────────────────────
// 裸 JSON 夹具：必须自己带 firstEligible，否则主指标（只收独立观测）不会收它。
const legacyDisc = (turn) => JSON.stringify({ at: '2025-12-01T00:00:00.000Z', turn, step: 1, tier: 'HIGH', reason: 'ok', injected: true, arm: 'treatment', firstEligible: true })
const p5 = pairTurns([legacyDisc(5), call(5, 1, 1, { sessionKey: undefined }), legacyDisc(99)].join('\n'))
ok('无会话标签的旧发现记录被单独报出', p5.legacy.length === 2, 'legacy=' + p5.legacy.length)
const s5 = summarise(p5)
ok('旧记录里能配对的仍然被配对', s5.experiment.primary.treatment.turns === 1 && s5.records.unpaired === 1, JSON.stringify({ paired: s5.experiment.primary.treatment.turns, unpaired: s5.records.unpaired }))

// ── 6) 坏行不让整份读数失败，但也不被吞掉 ─────────────────────────────────────
const p6 = pairTurns([disc(1, 'HIGH'), call(1, 1, 1), '{ 这不是 JSON', ''].join('\n'))
ok('坏行被计数而不是抛出', p6.malformed === 1, 'malformed=' + p6.malformed)
ok('坏行不影响其余记录', p6.paired.length === 1)

// ── 7) indexRows 多个取值要报警（语料换过，跨它对比不可靠）────────────────────
const s7 = summarise(pairTurns([disc(1, 'HIGH', { indexRows: 1025 }), call(1, 1, 1), disc(2, 'HIGH', { indexRows: 1028 }), call(2, 1, 1)].join('\n')))
ok('多个 indexRows 取值被收集起来', s7.indexRows.length === 2 && s7.indexRows.includes(1025) && s7.indexRows.includes(1028), JSON.stringify(s7.indexRows))

// ── 8) CLI ────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'report-'))
const logPath = join(dir, 'discovery.jsonl')
const QUIET = { log() {}, error() {} }
ok('日志不存在时退出码 2', main(['--log', join(dir, 'nope.jsonl')], QUIET) === 2)
writeFileSync(logPath, [disc(1, 'HIGH'), call(1, 2, 1)].join('\n'), 'utf8')
const capture = (argv) => {
  const chunks = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    chunks.push(chunk)
    return true
  }
  const code = main(argv, QUIET)
  process.stdout.write = realWrite
  return { code, text: chunks.join('') }
}
const run = capture(['--log', logPath, '--json'])
ok('--json 退出码 0', run.code === 0)
const payload = JSON.parse(run.text)
ok('--json 含 experiment 主指标结构', payload.experiment !== undefined && payload.experiment.primary !== undefined && payload.experiment.primary.treatment !== undefined && payload.experiment.primary.control !== undefined, Object.keys(payload).slice(0, 6).join(','))
ok('--json 已无旧的 injected/notInjected 读数', payload.injected === undefined && payload.notInjected === undefined)
ok('--json 不含 token 文本（隐私默认）', run.text.includes('ignoredTokens') === false)
// --since 是实验窗口的开关：T0 之前的记录必须落在窗口外
const future = capture(['--log', logPath, '--json', '--since', '2030-01-01T00:00:00.000Z'])
ok('--since 之后的未来时间 → 窗口内为空（旧数据被排除）', JSON.parse(future.text).experiment.primary.sessions === 0)
const past = capture(['--log', logPath, '--json', '--since', '2000-01-01T00:00:00.000Z'])
ok('--since 过去时间 → 记录被包含', JSON.parse(past.text).experiment.primary.sessions === 1, 'eligible=' + JSON.parse(past.text).experiment.primary.sessions)

rmSync(dir, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n实验读数: OK' : '\n实验读数 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
