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
import { fisherExact, main, pairKey, pairTurns, summarise, wilsonInterval } from '../tools/discovery-report.mjs'

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
  const sessionCreatedAt = extra.sessionCreatedAt !== undefined ? extra.sessionCreatedAt : '2026-01-01T00:00:00.000Z'
  return JSON.stringify({ at: '2026-01-01T00:00:00.000Z', turn, step: 1, sessionKey: 'aaaa1111', sessionCreatedAt, tier, reason: 'ok', tokenCount: 3, effectiveTokenCount: 2, filteredCommonTokens: 1, ignoredTokenRatios: [1], indexRows: 1025, candidateCount: tier === 'NONE' ? 0 : 5, candidates: [], arm, injected, firstEligible, hintBytes: injected ? 330 : 0, ...extra })
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

// ── 7b) 准入闸：主指标只收**历史里没有 T0 前提示**的会话 ────────────────────────
//
// 这一条来自一个**协议级**污染：firstEligibleSeen 是插件进程内存，重启即清空，而 session 是持久、
// 可 resume 的。所以"实验前就存在、重启后继续用"的会话，会把它的下一个 HIGH 呈现为"本会话第一个"。
// 污染没消失，只是从跨回合变成了跨进程。
//
// ── 判据改过一次，这里记下为什么 ────────────────────────────────────────────────
//
// 第一版的判据是 `sessionCreatedAt >= T0`——"会话必须是 T0 之后新建的"。它想排除的是**残留**，
// 而出生时间只是残留的**代理**，两个方向都会错：出生在 T0 前但**从未被注入**的会话历史是干净的
// （实测 `e93c0e04`：T0 前 0 次注入，重启后 resume 拿到一个干净的 control 观测，被白白扔掉）；
// 反过来，出生在 T0 后但同进程内已被注入的会话，这条判据根本管不到。
//
// 所以现在判的是污染本身：`carryoverSessions`（T0 前有过 injected:true 的会话）里的会话一律排除，
// 其余的按出生时间分两类，但**都准予进入**主指标。这个集合必须由调用方在按 T0 裁剪日志**之前**算好，
// 否则裁完就问不出来了。
const T0 = '2026-06-01T00:00:00.000Z'
const aged = (turn, createdAt, extra = {}) => disc(turn, 'HIGH', { sessionCreatedAt: createdAt, ...extra })
const gatePairs = pairTurns([
  aged(1, '2026-07-01T00:00:00.000Z'), call(1, 1, 0),                        // T0 之后新建 → 合格
  aged(2, '2026-01-01T00:00:00.000Z', { sessionKey: 'old11111' }), call(2, 1, 0, { sessionKey: 'old11111' }),  // T0 前创建但从未注入 → 合格（历史干净）
  aged(3, null, { sessionKey: 'unk11111' }), call(3, 1, 0, { sessionKey: 'unk11111' }),                        // 时间未知 → 排除
].join('\n'))
const sGated = summarise(gatePairs, { since: T0 })
ok('T0 之后新建的会话进入主指标', sGated.experiment.primary.sessions === 2, 'sessions=' + sGated.experiment.primary.sessions)
ok('干净的旧会话被准入（不是按出生时间一刀切）', sGated.experiment.primary.cleanOld === 1, 'cleanOld=' + sGated.experiment.primary.cleanOld)
ok('T0 之后新建的观测单独计数', sGated.experiment.primary.bornAfterT0 === 1, 'bornAfterT0=' + sGated.experiment.primary.bornAfterT0)
ok('创建时间未知的会话被排除（不放行）', sGated.experiment.excludedBirthUnknown === 1, 'unknown=' + sGated.experiment.excludedBirthUnknown)
ok('闸门标记为开', sGated.experiment.birthGate === 'on')
// **残留**：同一个会话，出生时间再早、只要 T0 前被注入过，就不准进——这才是这道闸的本体。
const residue = summarise(gatePairs, { since: T0, carryoverSessions: new Set(['old11111']) })
ok('T0 前被注入过的会话被排除（残留判据生效）', residue.experiment.excludedCarryover === 1, 'carryover=' + residue.experiment.excludedCarryover)
ok('排除后主指标只剩 T0 之后新建的那个', residue.experiment.primary.sessions === 1 && residue.experiment.primary.cleanOld === 0, JSON.stringify({ sessions: residue.experiment.primary.sessions, cleanOld: residue.experiment.primary.cleanOld }))
// 回归：不传 carryoverSessions 时不能崩，且行为等同"没有残留"（老调用方的兼容路径）。
const noCarry = summarise(gatePairs, { since: T0 })
ok('不传 carryoverSessions 时按"无残留"处理，不抛异常', noCarry.experiment.primary.sessions === sGated.experiment.primary.sessions, 'sessions=' + noCarry.experiment.primary.sessions)
// 不给 T0 时闸门关闭，且**明确标记为 off**（报告会为此报警）
const sOpen = summarise(gatePairs)
ok('未给 T0 时闸门标记为关', sOpen.experiment.birthGate === 'off')
ok('未给 T0 时三个会话都进主指标（闸门确实关着）', sOpen.experiment.primary.sessions === 3, 'sessions=' + sOpen.experiment.primary.sessions)
// 排除只作用于**主指标**，探索性/全量仍可见（不该把数据藏起来）
ok('被排除的会话仍出现在全量里', sGated.experiment.pooled.turns === 3, 'pooled=' + sGated.experiment.pooled.turns)

// ── 7c) 计数与不确定性：Δ 算得出来不等于证据够 ────────────────────────────────
//
// 用户的要求：读完 50 个以后要同时看每组的 n、yes/no 与一个**简单**的不确定性区间，因为
// "8/25 vs 5/25" 和 "20/25 vs 4/25" 虽然都能算出 Δ，证据强度差一个量级。
ok('Wilson：0/25 的上界是 13.3% 而不是 0（朴素正态会给 [0,0]）', (() => { const i = wilsonInterval(0, 25); return Math.abs(i.high - 0.133) < 0.005 && i.low === 0 })())
ok('Wilson：1/25 的下界不为负（朴素正态会给负数）', wilsonInterval(1, 25).low > 0, String(wilsonInterval(1, 25).low))
ok('Wilson：25/25 的上界封在 1，下界 < 1', (() => { const i = wilsonInterval(25, 25); return i.high === 1 && i.low > 0.8 })())
ok('Wilson：n=0 返回 null 而不是 NaN', wilsonInterval(0, 0) === null)
ok('Wilson：区间包含点估计', (() => { const i = wilsonInterval(8, 25); return i.low < 8 / 25 && 8 / 25 < i.high })())
ok('Wilson：n 越大区间越窄', (() => { const a = wilsonInterval(4, 25), b = wilsonInterval(40, 250); return (b.high - b.low) < (a.high - a.low) })())
// 计数：yes/no 都要显式给出，读者不必自己减
const counts = summarise(pairTurns([disc(1, 'HIGH'), call(1, 1, 1), disc(2, 'HIGH'), call(2, 0, 0)].join('\n'))).experiment.primary.treatment
ok('rate() 给出 misses（未命中数），不是让读者自己减', counts.turns === 2 && counts.calls === 1 && counts.misses === 1, JSON.stringify(counts))
ok('rate() 带上区间', counts.interval !== null && counts.interval.low < 0.5 && counts.interval.high > 0.5, JSON.stringify(counts.interval))
// 条件加载率：分母必须是"搜过的"，不是全部首观测
const cond = summarise(pairTurns([
  disc(1, 'HIGH'), call(1, 1, 1),   // 搜了也加载了
  disc(2, 'HIGH'), call(2, 1, 0),   // 搜了没加载
  disc(3, 'HIGH'), call(3, 0, 0),   // 没搜
].join('\n'))).experiment.primary.treatment
ok('条件加载率分母＝搜过的（2），不是全部（3）', cond.loadGivenSearch.turns === 2, 'n=' + cond.loadGivenSearch.turns)
ok('条件加载率＝1/2（搜了但没用会被算成未加载）', cond.loadGivenSearch.calls === 1 && cond.loadGivenSearch.rate === 0.5, JSON.stringify(cond.loadGivenSearch))
ok('全漏斗分母＝全部首观测（3）', cond.load.turns === 3 && cond.load.calls === 1, JSON.stringify(cond.load))
ok('两个分母不同，所以两个数都报', cond.loadGivenSearch.rate !== cond.load.rate)
// 一条都没搜时条件率的分母为 0，不能崩也不能报成 0%
const none = summarise(pairTurns([disc(1, 'HIGH'), call(1, 0, 0)].join('\n'))).experiment.primary.treatment
ok('无人搜索时条件率 n=0 且 rate 为 null（不是 0%）', none.loadGivenSearch.turns === 0 && none.loadGivenSearch.rate === null, JSON.stringify(none.loadGivenSearch))

// CLI 夹具（7d 与 8 都要用，所以先定义）
const dir = mkdtempSync(join(tmpdir(), 'report-'))
const logPath = join(dir, 'discovery.jsonl')
const QUIET = { log() {}, error() {} }
/**
 * 跑一次 CLI 并收集输出。
 *
 * **两条路都要抓**，这是第一版漏掉的：`--json` 直写 `process.stdout`，而**文本模式走 `io.log`**。
 * 第一版只 mock 了 stdout，于是文本模式的断言全部拿到空字符串——一个"表没出现"的假失败。
 */
const capture = (argv) => {
  const chunks = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    chunks.push(chunk)
    return true
  }
  const code = main(argv, { log: (m) => chunks.push(String(m) + '\n'), error: (m) => chunks.push(String(m) + '\n') })
  process.stdout.write = realWrite
  return { code, text: chunks.join('') }
}
writeFileSync(logPath, [disc(1, 'HIGH'), call(1, 2, 1)].join('\n'), 'utf8')

// ── 7d) Fisher exact：工具在手，但**默认不出现**在输出里 ────────────────────────
//
// 用户的要求：不要改插件去做检验，正式分析时用 2×2 表跑 Fisher exact，因为样本小时它比正态近似
// 稳妥。所以这里钉两件事：实现是对的，以及它**不会**混进默认读数（一个每次读数都出现的 p 值很容易
// 被当成结论）。
ok('Fisher：教科书例子 3/3 vs 0/3 → p=0.1', (() => { const p = fisherExact(3, 0, 0, 3); return Math.abs(p - 0.1) < 1e-9 })(), String(fisherExact(3, 0, 0, 3)))
ok('Fisher：无差异时 p=1（5/25 vs 5/25）', Math.abs(fisherExact(5, 20, 5, 20) - 1) < 1e-9, String(fisherExact(5, 20, 5, 20)))
ok('Fisher：两臂全零时 p=1（不是 NaN）', fisherExact(0, 25, 0, 25) === 1, String(fisherExact(0, 25, 0, 25)))
ok('Fisher：20/25 vs 4/25 给出极小 p', fisherExact(20, 5, 4, 21) < 1e-4, String(fisherExact(20, 5, 4, 21)))
ok('Fisher：8/25 vs 5/25 给出"看不出来"的 p（>0.05）', fisherExact(8, 17, 5, 20) > 0.05, String(fisherExact(8, 17, 5, 20)))
ok('Fisher：p 永远 <= 1', [fisherExact(1, 1, 1, 1), fisherExact(25, 0, 0, 25)].every((p) => p <= 1))
ok('Fisher：非法输入返回 null 而不是 NaN', fisherExact(-1, 2, 3, 4) === null && fisherExact(1.5, 2, 3, 4) === null)
ok('Fisher：空表返回 null', fisherExact(0, 0, 0, 0) === null)
// 默认读数里不能有 p 值。**用独立夹具**，两臂各一个合格观测——共享夹具只有一个会话，
// 两臂不会都有样本，2×2 表就只会显示一行（第一版因此误判"表没出现"）。
const twoArmLog = join(dir, 'two-arm.jsonl')
writeFileSync(twoArmLog, [
  disc(1, 'HIGH', { arm: 'treatment' }), call(1, 2, 1, { arm: 'treatment' }),
  disc(2, 'HIGH', { arm: 'control', injected: false, sessionKey: 'bbbb2222' }), call(2, 0, 0, { arm: 'control', injected: false, sessionKey: 'bbbb2222' }),
].join('\n'), 'utf8')
const noFisher = capture(['--log', twoArmLog]).text
ok('默认读数含原始 2×2 表', /原始 2×2 表/.test(noFisher) && /a=2 b=1/.test(noFisher) === false ? /原始 2×2 表/.test(noFisher) : false, '')
ok('默认读数不含 p 值（检验不在产品输出里）', /Fisher exact|p = /.test(noFisher) === false, '')
const withFisher = capture(['--log', twoArmLog, '--fisher']).text
ok('显式 --fisher 才出现 p 值', /Fisher exact/.test(withFisher) && /p = /.test(withFisher))
// 表里的四个整数必须与读数里 2×2 表那一行一致：夹具是每臂各一个会话（treatment 搜了 2 次、
// control 没搜），所以是 a=1 b=0 c=0 d=1。第一版我按"搜了 2 次"误写成 a=2——**计数是会话数，
// 不是调用次数**，这正是主指标的定义。
ok('--fisher 的表与读数里的 2×2 行一致', /a=1 b=0 c=0 d=1/.test(withFisher), (withFisher.match(/a=\d+ b=\d+ c=\d+ d=\d+/) || [''])[0])
ok('--fisher 的 p 值可读（1 次 vs 0 次看不出差异）', /p = 1\.000e\+0/.test(withFisher), (withFisher.match(/p = [\d.e+-]+/) || [''])[0])
// 条件加载率那一侧的 p 只在两臂都真的搜过时才给——control 没搜过就不该硬算
ok('某臂没搜过时不给条件加载率的 p（不硬算）', /Fisher exact（两尾，条件加载率）/.test(withFisher) === false)

// ── 8) CLI ────────────────────────────────────────────────────────────────────
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

// ── 8b) 残留判定必须在**裁剪之前**算 ──────────────────────────────────────────
//
// 这一条只有走 CLI 才测得到：`summarise` 的 `carryoverSessions` 是调用方传进来的，而 CLI 的执行
// 顺序才是对错所在——它先把 T0 之前的记录**删掉**，而"这个会话 T0 前有没有被注入过"这个问题，
// 删完就**再也问不出来**了。第一版正是因此把判据退化成了出生时间。
//
// 夹具刻意让两种会话的记录形状完全一样（都是"T0 后一个 HIGH 首观测"），唯一的差别在**被裁掉的
// 那部分日志**里：`res11111` 有一条 T0 前的注入，`fresh111` 没有。所以如果顺序写错，两者都会被
// 准入，主指标会变成 2——而它应该是 1。
const carryLog = join(dir, 'carryover.jsonl')
writeFileSync(carryLog, [
  // 老会话：T0 前注入过一次（这条会被裁掉，但判定必须看得见它）
  disc(1, 'HIGH', { at: '2026-01-01T00:00:00.000Z', sessionKey: 'res11111', sessionCreatedAt: '2026-01-01T00:00:00.000Z' }),
  call(1, 0, 0, { at: '2026-01-01T00:00:00.000Z', sessionKey: 'res11111' }),
  // 同一个会话在 T0 之后被 resume，拿到一个看起来像"本会话第一个"的 HIGH
  disc(9, 'HIGH', { at: '2026-07-01T00:00:00.000Z', sessionKey: 'res11111', sessionCreatedAt: '2026-01-01T00:00:00.000Z' }),
  call(9, 0, 0, { at: '2026-07-01T00:00:00.000Z', sessionKey: 'res11111' }),
  // 干净的新会话说：T0 之后新建
  disc(2, 'HIGH', { at: '2026-07-01T00:00:00.000Z', sessionKey: 'fresh111', sessionCreatedAt: '2026-06-15T00:00:00.000Z' }),
  call(2, 0, 0, { at: '2026-07-01T00:00:00.000Z', sessionKey: 'fresh111' }),
].join('\n'), 'utf8')
const carryJson = JSON.parse(capture(['--log', carryLog, '--json', '--since', '2026-06-01T00:00:00.000Z']).text)
ok('残留会话被排除（判定看见了被裁掉的那条注入）', carryJson.experiment.excludedCarryover === 1, 'carryover=' + carryJson.experiment.excludedCarryover)
ok('主指标只留干净的那一个会话', carryJson.experiment.primary.sessions === 1, 'sessions=' + carryJson.experiment.primary.sessions)
ok('被准入的是 T0 之后新建的那个', carryJson.experiment.primary.bornAfterT0 === 1, 'bornAfterT0=' + carryJson.experiment.primary.bornAfterT0)
// 反向对照：**同一个夹具**去掉那条 T0 前的注入记录，就该放行——证明差别确实来自"残留"而不是出生时间。
const cleanLog = join(dir, 'no-carryover.jsonl')
writeFileSync(cleanLog, [
  disc(9, 'HIGH', { at: '2026-07-01T00:00:00.000Z', sessionKey: 'res11111', sessionCreatedAt: '2026-01-01T00:00:00.000Z' }),
  call(9, 0, 0, { at: '2026-07-01T00:00:00.000Z', sessionKey: 'res11111' }),
  disc(2, 'HIGH', { at: '2026-07-01T00:00:00.000Z', sessionKey: 'fresh111', sessionCreatedAt: '2026-06-15T00:00:00.000Z' }),
  call(2, 0, 0, { at: '2026-07-01T00:00:00.000Z', sessionKey: 'fresh111' }),
].join('\n'), 'utf8')
const cleanJson = JSON.parse(capture(['--log', cleanLog, '--json', '--since', '2026-06-01T00:00:00.000Z']).text)
ok('同一会话没有残留时被准入（不是按出生时间一刀切）', cleanJson.experiment.excludedCarryover === 0 && cleanJson.experiment.primary.sessions === 2, JSON.stringify({ carryover: cleanJson.experiment.excludedCarryover, sessions: cleanJson.experiment.primary.sessions }))
ok('干净的旧会话被单独标出来', cleanJson.experiment.primary.cleanOld === 1, 'cleanOld=' + cleanJson.experiment.primary.cleanOld)

rmSync(dir, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n实验读数: OK' : '\n实验读数 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
