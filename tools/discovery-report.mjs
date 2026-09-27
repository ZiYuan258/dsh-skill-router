// 实验读数：把 discovery 遥测汇总成三张表，并把"未知"与"0 次"严格分开。
//
//   node tools/discovery-report.mjs [--log <路径>] [--json] [--since <ISO 日期>]
//
// ── 为什么单独有个脚本，而不是临时写几行 ──────────────────────────────────────────
//
// 因为这里有一个**会把结论算反**的陷阱：按回合的 tool-call 计数天生是**右截断**的。
//
//   回合 10 开始 → 累计调用
//   回合 11 开始 → 才把回合 10 的数落盘
//
// 所以最后一个已完成的回合、以及中止/崩溃的回合，**没有** turn-calls 记录。如果分析时把
// "没有记录"当成 search=0，就会得出"这些回合没搜过"——而真相是**不知道**。5 个未配对的回合
// 混进 50 个样本里，足以把一个上升的搜索率算成没变化。
//
// 所以本脚本只统计 **paired**（既有发现记录、又有 turn-calls 记录）的回合，并把 unpaired 明确
// 报成 unknown。
//
// ── 隐私 ────────────────────────────────────────────────────────────────────────
//
// 默认**不读** token 文本（`ignoredTokens` / `tokensUsed`）——它们只在 debug 开关打开时才存在于
// 日志里，而即使存在，这个脚本也不需要它们：比例就够了。`--show-tokens` 才会打印，用于人工排查。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认日志位置：与 `discovery.js` 的 `defaultDiscoveryLogPath()` 同一处。 */
export function defaultLogPath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'skill-router', 'discovery.jsonl')
}

/**
 * 配对键：会话标签 + 回合号。
 *
 * 只用 \`turn\` 会把不同会话的同号回合合并成一条——实测日志里 \`turn\` 1 出现过 3 次、14 个
 * turn 号被重复。旧记录没有会话标签，用 \`(none)\` 兜底并单独计数，不假装能配对。
 */
export function pairKey(record) {
  const label = record === null || record === undefined || record.sessionKey === undefined || record.sessionKey === null ? '(none)' : String(record.sessionKey)
  return label + '#' + String(record.turn)
}

/**
 * 读日志并按**回合**配对。
 *
 * ── 为什么必须真的去重，而不是"生产上应该不会重复"────────────────────────────────
 *
 * 一个回合可能写下**多条发现记录**（重复的 pre-step：框架重试、测试夹具、将来的分叉）。第一版
 * 对每条发现记录都 push 一次，于是 `paired` 的长度是**记录数**而不是**回合数**。后果不是显示问题：
 * `injected.pairedTurns`、`searchRate`、`loadRate` 全部被重复计数——同一回合在分子和分母里各算
 * 两次，足以把一个真实差异抹平。而它最危险的地方在于**读数看起来很合理**：没有报错、没有异常值，
 * 只是一个悄悄变大的分母。
 *
 * 所以配对单元是 `(sessionKey, turn)`：
 *
 *   * 多条发现记录 → **取最后一条**（同一回合的 tier 不会变；晚写的那条是最终裁定）
 *   * 多条计数记录 → **逐项求和**（单条记录已经是"该回合的累计值"，多条意味着该回合被结算过两次，
 *     相加才是这一回合真实发生的调用总数）
 *
 * `paired.length` 因此**等于唯一回合数**，这也正是实验门槛"50 个回合"该数的东西。
 *
 * @param text - JSONL 文本。
 * @returns `{ discovery, calls, paired, unpaired, malformed, legacy }`。`paired` 与 `unpaired`
 *   都按 `(sessionKey, turn)` 去重，每回合各一条。
 */
export function pairTurns(text) {
  const discovery = []
  const calls = new Map()
  let malformed = 0
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // 一行坏掉不该让整份读数失败——但也不能悄悄吞掉，计数并报出来。
      malformed += 1
      continue
    }
    // **配对键是 (sessionKey, turn)，不是 turn。**
    //
    // 曾经只用 turn：遥测里没有会话标识，于是两个会话各自的 turn 12 是同一条记录。实测到 14 个
    // turn 号被重复。按 turn 配对会把不同会话合并——足以把结论算反。
    if (record.kind === 'turn-calls') {
      const key = pairKey(record)
      const seen = calls.get(key)
      // 求和而不是覆盖：每条计数记录是"该回合的累计值"，多条意味着该回合被结算过多次。
      calls.set(key, seen === undefined ? { ...record } : {
        ...record,
        skillSearchCalls: (seen.skillSearchCalls ?? 0) + (record.skillSearchCalls ?? 0),
        skillLoadCalls: (seen.skillLoadCalls ?? 0) + (record.skillLoadCalls ?? 0),
        skillRefCalls: (seen.skillRefCalls ?? 0) + (record.skillRefCalls ?? 0),
        residentSkillCalls: (seen.residentSkillCalls ?? 0) + (record.residentSkillCalls ?? 0),
        otherToolCalls: (seen.otherToolCalls ?? 0) + (record.otherToolCalls ?? 0),
      })
    } else {
      discovery.push(record)
    }
  }
  // 一回合一条：后写的覆盖先写的。保持插入顺序，所以报告里仍是时间顺序。
  const lastPerTurn = new Map()
  for (const found of discovery) lastPerTurn.set(pairKey(found), found)
  const paired = []
  const unpaired = []
  for (const [key, found] of lastPerTurn) {
    const counted = calls.get(key)
    if (counted === undefined) unpaired.push(found)
    else paired.push({ ...found, calls: counted })
  }
  // 没有会话标签的旧记录（v1.12.1 之前写的）无法安全配对，单独计数并报出来。
  const legacy = discovery.filter((r) => r.sessionKey === undefined || r.sessionKey === null)
  return { discovery, calls, paired, unpaired, malformed, legacy }
}

/** 一次调用都没有的回合数（paired 里才算）。 */
const calledSomething = (t) => (t.calls.skillSearchCalls ?? 0) + (t.calls.skillLoadCalls ?? 0) + (t.calls.skillRefCalls ?? 0) + (t.calls.residentSkillCalls ?? 0) > 0

/** 汇总成报告对象。 */
export function summarise(pairs, options) {
  const since = options === null || options === undefined ? undefined : options.since
  const tier = {}
  const reason = {}
  for (const t of pairs.discovery) {
    tier[t.tier] = (tier[t.tier] ?? 0) + 1
    reason[t.reason] = (reason[t.reason] ?? 0) + 1
  }
  // ── 分臂统计：这是实验的核心读数 ──────────────────────────────────────────────
  //
  // **为什么不能拿"未注入"当对照。** 注入与否由 tier 决定，所以"注入组"与"未注入组"在构造上就是
  // 不同的任务总体（"做 Semgrep 安全审计" vs "今天天气怎么样"）。两组搜索率之差说明不了提示的作用。
  //
  // **为什么主要指标只算每个会话的第一个 HIGH。** 干预是**持久的**：注入的提示会以 `user/message`
  // 追加到会话 surface（`surfaceOp: 'append'`），之后每一步的历史都由它派生。所以同一会话里
  // "treatment 之后又出现 control"时，那个 control **仍然看得见前面的提示**——污染是单向的
  // （treatment 污染后续 control，反之不成立），汇总起来会朝一个已知方向偏。
  //
  // 因此：
  //   * 分臂按**会话**（不是按回合）；
  //   * **主要指标**只统计每个会话的**第一个** eligible opportunity —— 它是唯一可证明"先于本实验
  //     任何提示"的观测，因为那时还没有任何东西被注入；
  //   * 同一会话的后续 opportunity 会一并报告，但标为**探索性**：Agent 已经搜过、学过，之后的回合
  //     天然不独立。
  const byArm = (arm) => pairs.paired.filter((t) => t.arm === arm)
  const rate = (list, field) => {
    if (list.length === 0) return { turns: 0, calls: 0, misses: 0, rate: null, interval: null }
    const hits = list.filter((t) => (t.calls[field] ?? 0) > 0).length
    // 计数与区间一起给：单看一个比例会让人忘记 n 有多小。"未命中"是显式字段而不是减法，
    // 这样报告里能直接印出 \`8 yes / 17 no\`，读者不必自己减。
    return { turns: list.length, calls: hits, misses: list.length - hits, rate: hits / list.length, interval: wilsonInterval(hits, list.length) }
  }
  // 每个会话的第一个 eligible opportunity：整个读数的主指标就建立在这上面。
  //
  // **但"第一个"还不够，会话本身必须是 T0 之后新建的。** `firstEligibleSeen` 是插件进程内存，
  // 重启后清空；而 session 是持久、可 resume 的。所以一个**实验前就存在、重启后继续用**的会话，
  // 可以把它的下一个 HIGH 呈现为"本会话第一个"——污染没有消失，只是从跨回合变成了跨进程。
  //
  // 这条闸只在给了 T0 时才生效（没有 T0 就没有可比的时刻），且**无法确认创建时间的会话一律排除**：
  // 这道闸存在的意义就是排除它，凭一个猜出来的时间放行等于没有闸。
  const createdAtOf = (t) => (typeof t.sessionCreatedAt === 'string' ? t.sessionCreatedAt : null)
  const birthKnown = (t) => (createdAtOf(t) === null ? 'unknown' : createdAtOf(t) >= since ? 'ok' : 'pre-T0')
  const firstCandidates = pairs.paired.filter((t) => t.firstEligible === true && (t.arm === 'treatment' || t.arm === 'control'))
  const firstPerSession = since === undefined ? firstCandidates : firstCandidates.filter((t) => birthKnown(t) === 'ok')
  const excludedByBirth = since === undefined ? [] : firstCandidates.filter((t) => birthKnown(t) !== 'ok')
  const laterPerSession = pairs.paired.filter((t) => t.firstEligible !== true && (t.arm === 'treatment' || t.arm === 'control'))
  const notEligible = pairs.paired.filter((t) => t.arm === 'not-eligible' || t.arm === null || t.arm === undefined)
  // 分配与执行是否一致：control 会话不该有 hint，treatment 会话不该没有。
  const armViolations = pairs.paired.filter((t) => (t.arm === 'control' && t.injected === true) || (t.arm === 'treatment' && t.injected !== true))
  // 同一会话能不能既被记成 firstEligible 又不是第一个？重复会破坏"每会话一个观测"。
  const sessionFirstCount = new Map()
  for (const t of pairs.paired) {
    if (t.firstEligible !== true) continue
    sessionFirstCount.set(t.sessionKey, (sessionFirstCount.get(t.sessionKey) ?? 0) + 1)
  }
  const duplicateFirsts = [...sessionFirstCount.values()].filter((n) => n > 1).length
  return {
    records: { discovery: pairs.discovery.length, turnCalls: pairs.calls.size, paired: pairs.paired.length, unpaired: pairs.unpaired.length, malformed: pairs.malformed, legacy: pairs.legacy === undefined ? 0 : pairs.legacy.length },
    tier,
    reason,
    experiment: {
      // **主指标**：每会话一个独立观测。
      primary: {
        treatment: { ...rate(firstPerSession.filter((t) => t.arm === 'treatment'), 'skillSearchCalls'), load: rate(firstPerSession.filter((t) => t.arm === 'treatment'), 'skillLoadCalls'), loadGivenSearch: rate(firstPerSession.filter((t) => t.arm === 'treatment' && (t.calls.skillSearchCalls ?? 0) > 0), 'skillLoadCalls') },
        control: { ...rate(firstPerSession.filter((t) => t.arm === 'control'), 'skillSearchCalls'), load: rate(firstPerSession.filter((t) => t.arm === 'control'), 'skillLoadCalls'), loadGivenSearch: rate(firstPerSession.filter((t) => t.arm === 'control' && (t.calls.skillSearchCalls ?? 0) > 0), 'skillLoadCalls') },
        sessions: firstPerSession.length,
      },
      // **探索性**：同一会话的后续 opportunity，不独立，只作参考。
      exploratory: {
        treatment: rate(laterPerSession.filter((t) => t.arm === 'treatment'), 'skillSearchCalls'),
        control: rate(laterPerSession.filter((t) => t.arm === 'control'), 'skillSearchCalls'),
        turns: laterPerSession.length,
      },
      // 全量汇总（含非首观测）——保留，但**不能**用它下因果结论。
      pooled: {
        treatment: rate(byArm('treatment'), 'skillSearchCalls'),
        control: rate(byArm('control'), 'skillSearchCalls'),
        turns: byArm('treatment').length + byArm('control').length,
      },
      notEligiblePairedTurns: notEligible.length,
      // 非零即为 bug：说明分配与实际注入不一致，这批数据不能用来判断效果。
      armViolations: armViolations.length,
      // 非零即为 bug：同一会话被记了两次 firstEligible，主指标的分母不可信。
      duplicateFirsts,
      // 被"会话必须是 T0 之后新建"这道闸排除掉的首观测：分"实验前就存在"与"创建时间无法确认"。
      birthGate: since === undefined ? 'off' : 'on',
      excludedPreT0: excludedByBirth.filter((t) => birthKnown(t) === 'pre-T0').length,
      excludedBirthUnknown: excludedByBirth.filter((t) => birthKnown(t) === 'unknown').length,
    },
    anyCall: pairs.paired.filter(calledSomething).length,
    hintBytes: pairs.paired.filter((t) => t.injected === true).map((t) => t.hintBytes ?? 0),
    indexRows: [...new Set(pairs.discovery.map((t) => t.indexRows).filter((n) => typeof n === 'number'))],
  }
}

/**
 * Fisher's exact test, two-tailed, for a 2x2 table.
 *
 * **为什么这个函数在工具里、而 p 值不在默认输出里。** 样本小时 Fisher exact 比正态近似稳妥，所以
 * 最终分析需要它；但它**不是产品行为**——插件不该把某个检验绑进自己的输出，读者也不该在每一次
 * 读数里看到一个会被误当成结论的 p 值。所以它默认不显示，只在显式 \`--fisher\` 时计算。
 *
 * 用对数阶乘避免大数溢出，并按"概率不高于观测表"累加（这是两尾的定义，不是把单尾乘二）。
 *
 * @returns p 值；任一格为负或行列为零时返回 null。
 */
export function fisherExact(a, b, c, d) {
  const cells = [a, b, c, d]
  if (cells.some((v) => typeof v !== 'number' || Number.isInteger(v) === false || v < 0)) return null
  const r1 = a + b
  const r2 = c + d
  const c1 = a + c
  const n = a + b + c + d
  // 退化输入只有 n=0，以及"某一行或某一列全空"——那样概率算不出来（0/0）。
  //
  // **注意 c1===0（两臂都 0 次命中）不是退化输入。** 它是有效的观测结果，答案是 p=1：
  // 观测到 0 vs 0 时没有证据反对"同一分布"。第一版把它当退化返回 null，那会让"两臂都没搜"
  // 这个真实且可能出现的读数无法判断。对称的另一端（命中数拉满）本来就会给出极小 p。
  if (n === 0 || r1 === 0 || r2 === 0) return null
  const lnFact = (k) => {
    let s = 0
    for (let i = 2; i <= k; i += 1) s += Math.log(i)
    return s
  }
  const lnChoose = (nn, kk) => lnFact(nn) - lnFact(kk) - lnFact(nn - kk)
  const prob = (x) => Math.exp(lnChoose(r1, x) + lnChoose(n - r1, c1 - x) - lnChoose(n, c1))
  const observed = prob(a)
  let total = 0
  const lo = Math.max(0, c1 - r2)
  const hi = Math.min(r1, c1)
  for (let x = lo; x <= hi; x += 1) {
    const p = prob(x)
    // 容差：浮点累加会让"与观测等概率"的表差出 1e-16 而被漏掉。
    if (p <= observed * (1 + 1e-9)) total += p
  }
  return Math.min(1, total)
}

/**
 * Wilson score interval for a binomial proportion, at 95%.
 *
 * **为什么不用朴素正态近似**（\`p ± 1.96·sqrt(p(1-p)/n)\`）：在实验真正会遇到的取值上它会坏掉。
 * 50 个会话、control 组 0 次搜索时，正态近似给出 [0, 0]——一个把"没观测到"说成"不可能发生"的区间；
 * 而 25 个样本里的 1 次搜索会给出下界为负的区间。Wilson 在这些位置仍然给出可解释的结果，实现也
 * 只多两行，所以没有理由用会撒谎的那个。
 *
 * 这不是"统计模型"——它只是把"n 这么小时，这个比例有多不确定"变成一个数字。用户明确要的是
 * 一个简单的不确定性区间，而不是把项目变成统计练习。
 *
 * @param successes - 命中数。
 * @param total - 分母。
 * @returns \`{ low, high }\`，0..1；total 为 0 时返回 null。
 */
export function wilsonInterval(successes, total, z = 1.96) {
  if (typeof total !== 'number' || total <= 0) return null
  const n = total
  const p = successes / n
  const z2 = z * z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) }
}

const pct = (value) => (value === null || value === undefined ? 'n/a' : (value * 100).toFixed(1) + '%')
const pad = (label, width = 24) => (label + ' ').padEnd(width, ' ')

/** 人读的报告。 */
export function renderReport(summary) {
  const lines = []
  lines.push('发现层实验读数')
  lines.push('')
  lines.push(pad('记录：') + summary.records.discovery + ' 条发现 + ' + summary.records.turnCalls + ' 条回合计数')
  lines.push(pad('可配对：') + summary.records.paired + ' 个回合（**下面所有比率的分母**）')
  lines.push(pad('不可配对：') + summary.records.unpaired + ' 个回合 → **unknown，不是 0**')
  if (summary.records.malformed > 0) lines.push(pad('坏行：') + summary.records.malformed + ' 行无法解析（已跳过）')
  if (summary.records.legacy > 0) lines.push(pad('无会话标签：') + summary.records.legacy + ' 条旧记录（v1.12.1 之前写的，配对不可靠，已排除）')
  lines.push('')
  lines.push(pad('索引行数：') + (summary.indexRows.length === 0 ? '（未记录）' : summary.indexRows.join(' / ')))
  if (summary.indexRows.length > 1) lines.push('  ⚠️ 出现过多个取值 → 语料换过，跨这些回合的对比不可靠')
  lines.push('')
  lines.push('tier 分布（全部发现记录）：')
  for (const [k, n] of Object.entries(summary.tier).sort((a, b) => b[1] - a[1])) lines.push('  ' + pad(k, 10) + n)
  lines.push('')
  lines.push('reason 分布：')
  for (const [k, n] of Object.entries(summary.reason).sort((a, b) => b[1] - a[1])) lines.push('  ' + pad(k, 26) + n)
  lines.push('')
  lines.push('── 实验：按会话随机分臂，主指标只用每会话的第一个 HIGH ──')
  lines.push('')
  const e = summary.experiment
  const delta = (a, b) => (a === null || b === null ? null : (a - b) * 100)
  lines.push('① 提示 → Agent 是否开始 skill_search（**主指标**）')
  lines.push('  每会话取第一个 eligible opportunity，一 session 一个独立观测：')
  // 每组都印 n、命中数、**未命中数**（显式给出，读者不必自己减）与 95% 区间。
  // 比例单看会让人忘记 n 有多小：8/25 与 20/25 的 Δ 都算得出来，但证据强度差一个量级。
  const armLine = (label, arm) => {
    const r = arm
    const iv = r.interval === null ? '（无样本）' : '95% 区间 [' + pct(r.interval.low) + ', ' + pct(r.interval.high) + ']'
    return '  ' + pad(label, 26) + 'n=' + r.turns + '  搜了 ' + r.calls + ' / 没搜 ' + r.misses + ' → ' + pct(r.rate) + '  ' + iv
  }
  lines.push(armLine('treatment（有提示）：', e.primary.treatment))
  lines.push(armLine('control（无提示）：', e.primary.control))
  const primaryDelta = delta(e.primary.treatment.rate, e.primary.control.rate)
  if (primaryDelta !== null) {
    lines.push('  ' + pad('Δ（差值）：', 26) + (primaryDelta >= 0 ? '+' : '') + primaryDelta.toFixed(1) + ' 个百分点')
    // 粗略判读：两个区间不重叠时，差值通常也是可信的；重叠则"还看不出来"。
    const ti = e.primary.treatment.interval
    const ci = e.primary.control.interval
    if (ti !== null && ci !== null) {
      const overlap = ti.low <= ci.high && ci.low <= ti.high
      // 措辞要小心：区间重叠与否是**描述**，不是检验。上一版写成"差异方向可信"容易被当成
      // 显著性结论，所以这里明确说它替代不了检验，并指向下面的 2×2 表。
      lines.push('  ' + pad('区间是否重叠：', 26) + (overlap ? '重叠 → 这个样本量还分不出差异，别急着下结论' : '不重叠（**描述性**：不是显著性检验，正式判断请用下面的 2×2 表做 Fisher exact）'))
    }
    if (e.primary.treatment.turns < 20 || e.primary.control.turns < 20) {
      lines.push('  ' + pad('', 26) + '⚠️ 某一臂 n<20，区间会很宽——这是"信息不足"，不是"没有效果"')
    }
  }
  lines.push('')
  lines.push('② search → skill_load（**给定搜过**的加载率——这才是"搜了会不会用"）')
  // 两个分母都要给，因为它们回答不同的问题：
  //   * 条件率（分母＝该臂**搜过**的会话）回答"搜了之后会不会真的用"；
  //   * 全漏斗（分母＝该臂全部首观测）回答"一个机会最终有多大比例真的加载了"。
  // 只给后者会把"根本没搜"混进来，读起来像"搜了却不用"——那正是我第一版的错误。
  const condLine = (label, arm) => {
    const c = arm.loadGivenSearch
    return '  ' + pad(label, 26) + 'n=' + c.turns + '（搜过的）  加载 ' + c.calls + ' / 没加载 ' + c.misses + ' → ' + pct(c.rate) + (c.interval === null ? '' : '  95% 区间 [' + pct(c.interval.low) + ', ' + pct(c.interval.high) + ']')
  }
  lines.push(condLine('treatment：', e.primary.treatment))
  lines.push(condLine('control：', e.primary.control))
  lines.push('  ' + pad('全漏斗（分母＝全部首观测）：', 30) + 'treatment ' + pct(e.primary.treatment.load.rate) + '，control ' + pct(e.primary.control.load.rate))
  lines.push('')
  lines.push('③ 原始 2×2 表（最终分析用这些整数，不要在插件里做检验）')
  // 只印原始计数。**不在这里算 p 值**：检验属于分析阶段，工具该做的是把原始整数如实交出来，
  // 而不是把某个检验绑进产品代码。样本小时 Fisher exact 比正态近似稳妥，它由分析者自行运行。
  const cell = (arm, field) => arm
  const t2 = e.primary.treatment
  const c2 = e.primary.control
  lines.push('  ' + pad('', 20) + 'search'.padEnd(10) + 'no search'.padEnd(12) + 'total')
  lines.push('  ' + pad('treatment', 20) + String(t2.calls).padEnd(10) + String(t2.misses).padEnd(12) + t2.turns)
  lines.push('  ' + pad('control', 20) + String(c2.calls).padEnd(10) + String(c2.misses).padEnd(12) + c2.turns)
  if (t2.turns > 0 && c2.turns > 0) {
    lines.push('  ' + pad('（一行可复制：', 20) + 'a=' + t2.calls + ' b=' + t2.misses + ' c=' + c2.calls + ' d=' + c2.misses + '）')
  } else {
    lines.push('  （两臂都有样本后才给出可复制的四个整数。）')
  }
  const lt = t2.loadGivenSearch
  const lc = c2.loadGivenSearch
  lines.push('  ' + pad('', 20) + 'load'.padEnd(10) + 'no load'.padEnd(12) + 'total')
  lines.push('  ' + pad('treatment|search', 20) + String(lt.calls).padEnd(10) + String(lt.misses).padEnd(12) + lt.turns)
  lines.push('  ' + pad('control|search', 20) + String(lc.calls).padEnd(10) + String(lc.misses).padEnd(12) + lc.turns)
  lines.push('  ' + pad('（条件在"搜过"上；分母为 0 时不给表。）', 20))
  lines.push('')
  lines.push('④ 候选相关性（HIGH 的 top-5 里至少一个明显相关）—— 人工抽样')
  lines.push('  **这个脚本算不出来，必须人工抽样。** 且它是前置门槛：相关性不过关时，①② 的差值没有解释力。')
  lines.push('')
  lines.push('── 参考：不独立、不能用来下结论的数字 ──')
  lines.push('  同一会话的后续 opportunity 不独立（Agent 已经搜过、学过），且提示持久存在会让后续 control')
  lines.push('  仍然看得见前面的提示，所以下面两行只作参考：')
  lines.push('  ' + pad('探索性（后续回合）：', 26) + 'treatment ' + e.exploratory.treatment.turns + ' 回合 → ' + pct(e.exploratory.treatment.rate) + '，control ' + e.exploratory.control.turns + ' 回合 → ' + pct(e.exploratory.control.rate))
  lines.push('  ' + pad('全量汇总（含非首）：', 26) + 'treatment ' + e.pooled.treatment.turns + ' → ' + pct(e.pooled.treatment.rate) + '，control ' + e.pooled.control.turns + ' → ' + pct(e.pooled.control.rate))
  const pooledDelta = delta(e.pooled.treatment.rate, e.pooled.control.rate)
  if (pooledDelta !== null && primaryDelta !== null && Math.abs(pooledDelta - primaryDelta) > 5) {
    lines.push('  ⚠️ 全量差值与主指标差值相差 ' + Math.abs(pooledDelta - primaryDelta).toFixed(1) + ' 个百分点 → 与 carryover 的预期方向一致，以主指标为准')
  }
  lines.push('')
  lines.push(pad('非合格回合（不进分臂）：', 26) + e.notEligiblePairedTurns + '（NONE/MEDIUM 或旧记录）')
  if (e.armViolations > 0) lines.push('  ⚠️ 分配与实际注入不一致：' + e.armViolations + ' 处 —— 这批数据不能用来判断效果')
  else lines.push('  ' + pad('分配与实际注入一致：', 26) + '是（0 处冲突）')
  if (e.duplicateFirsts > 0) lines.push('  ⚠️ 有 ' + e.duplicateFirsts + ' 个会话被记了多次 firstEligible → 主指标分母不可信')
  if (e.birthGate === 'off') {
    lines.push('  ⚠️ **未给 --since：会话创建时间这道闸是关的。** 实验前就存在、重启后 resume 的会话')
    lines.push('     可能把它的下一个 HIGH 当成"本会话第一个"。正式读数必须带 --since <T0>。')
  } else {
    lines.push('  ' + pad('会话创建于 T0 之后：', 26) + '是主指标的准入条件')
    if (e.excludedPreT0 > 0) lines.push('  ' + pad('被排除（T0 前创建）：', 26) + e.excludedPreT0 + ' 个首观测')
    if (e.excludedBirthUnknown > 0) lines.push('  ' + pad('被排除（创建时间未知）：', 26) + e.excludedBirthUnknown + ' 个首观测')
  }
  lines.push('')
  if (e.primary.sessions < 50) {
    lines.push('结论：主指标只有 ' + e.primary.sessions + ' 个会话（需要 ≥50 个会话，各一个合格观测）。继续收集。')
  } else if (e.primary.treatment.turns < 20 || e.primary.control.turns < 20) {
    lines.push('结论：会话数过了 50，但某一臂不足 20 → 分臂随机性存疑，再看几天。')
  } else {
    lines.push('结论：样本量已够。按"相关性 → 差值 → load"三档读，并对 HIGH top-5 做人工相关性抽样。')
  }
  return lines.join('\n')
}

/** 命令行入口。`io` 可注入，测试要反复调用它。 */
export function main(argv, io) {
  const log = (io && io.log) || console.log
  const err = (io && io.error) || console.error
  const at = argv.indexOf('--log')
  const path = at >= 0 ? argv[at + 1] : defaultLogPath()
  const sinceAt = argv.indexOf('--since')
  const since = sinceAt >= 0 ? argv[sinceAt + 1] : undefined
  if (existsSync(path) === false) {
    err('找不到遥测日志：' + path)
    err('（插件还没写过任何记录，或用 --log <路径> 指定。）')
    return 2
  }
  const pairs = pairTurns(readFileSync(path, 'utf8'))
  if (since !== undefined) {
    for (const key of ['discovery', 'paired', 'unpaired']) {
      if (key === 'discovery') continue
      pairs[key] = pairs[key].filter((t) => String(t.at ?? '') >= since)
    }
    pairs.discovery = pairs.discovery.filter((t) => String(t.at ?? '') >= since)
  }
  const summary = summarise(pairs, { since })
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    return 0
  }
  log(renderReport(summary))
  if (argv.includes('--fisher')) {
    const t2 = summary.experiment.primary.treatment
    const c2 = summary.experiment.primary.control
    if (t2.turns === 0 || c2.turns === 0) {
      log('')
      log('Fisher exact：两臂都还没有样本，无法计算。')
    } else {
      const p = fisherExact(t2.calls, t2.misses, c2.calls, c2.misses)
      log('')
      log('Fisher exact（两尾，搜索率，仅在你显式要求时计算）：')
      log('  表 a=' + t2.calls + ' b=' + t2.misses + ' c=' + c2.calls + ' d=' + c2.misses)
      log('  p = ' + (p === null ? 'n/a' : p.toExponential(3)))
      const lt = t2.loadGivenSearch
      const lc = c2.loadGivenSearch
      if (lt.turns > 0 && lc.turns > 0) {
        const pl = fisherExact(lt.calls, lt.misses, lc.calls, lc.misses)
        log('Fisher exact（两尾，条件加载率）：')
        log('  表 a=' + lt.calls + ' b=' + lt.misses + ' c=' + lc.calls + ' d=' + lc.misses)
        log('  p = ' + (pl === null ? 'n/a' : pl.toExponential(3)))
      }
      log('  ⚠️ 一次读数里的多重比较不做校正。p 只回答"这一批数据像不像同一分布"，不是效应量。')
    }
  }
  if (argv.includes('--show-tokens')) {
    // 只有在 debug 开关打开过的日志里才有内容。默认不打印。
    const withTokens = pairs.discovery.filter((t) => Array.isArray(t.ignoredTokens) && t.ignoredTokens.length > 0)
    log('')
    log('被语料过滤丢弃的词（debug 记录，共 ' + withTokens.length + ' 条）：')
    for (const t of withTokens.slice(0, 20)) log('  turn ' + t.turn + ': ' + t.ignoredTokens.map((x) => x.token + '(' + (x.ratio * 100).toFixed(0) + '%)').join(', '))
    const withUsed = pairs.discovery.filter((t) => Array.isArray(t.tokensUsed))
    if (withUsed.length > 0) {
      log('')
      log('任务 token（debug 记录，共 ' + withUsed.length + ' 条，前 10 条）：')
      for (const t of withUsed.slice(0, 10)) log('  turn ' + t.turn + ': ' + JSON.stringify(t.tokensUsed))
    }
  } else {
    log('')
    log('（token 文本默认不打印——加 --show-tokens 才看，且只有日志里存在时才看得到。）')
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
