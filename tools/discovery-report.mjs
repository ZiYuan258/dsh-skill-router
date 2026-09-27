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
export function summarise(pairs) {
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
  // 真正的对照是**同一类任务**（都是 HIGH、候选质量相同）里被随机分到 control 的那些回合。所以
  // 下列所有比率都按 `arm` 分，而 `injected` 只在核对"分配是否被真正执行"时用。
  //
  // 分臂只统计 **arm 为 treatment/control 的 paired 回合**；`not-eligible` 与非 HIGH 的一律不进，
  // 否则又会把不同任务总体混进来——那正是这一版要修掉的错误。
  const byArm = (arm) => pairs.paired.filter((t) => t.arm === arm)
  const rate = (list, field) => {
    if (list.length === 0) return { pairedTurns: 0, calls: 0, rate: null }
    const hits = list.filter((t) => (t.calls[field] ?? 0) > 0).length
    return { pairedTurns: list.length, calls: hits, rate: hits / list.length }
  }
  const treatment = byArm('treatment')
  const control = byArm('control')
  const notEligible = pairs.paired.filter((t) => t.arm === 'not-eligible' || t.arm === null || t.arm === undefined)
  // 分配与执行是否一致：control 回合不该有 hint，treatment 回合不该没有。
  const armViolations = pairs.paired.filter((t) => (t.arm === 'control' && t.injected === true) || (t.arm === 'treatment' && t.injected !== true))
  return {
    records: { discovery: pairs.discovery.length, turnCalls: pairs.calls.size, paired: pairs.paired.length, unpaired: pairs.unpaired.length, malformed: pairs.malformed, legacy: pairs.legacy === undefined ? 0 : pairs.legacy.length },
    tier,
    reason,
    experiment: {
      treatment: { ...rate(treatment, 'skillSearchCalls'), load: rate(treatment, 'skillLoadCalls') },
      control: { ...rate(control, 'skillSearchCalls'), load: rate(control, 'skillLoadCalls') },
      notEligiblePairedTurns: notEligible.length,
      // 非零即为 bug：说明分配与实际注入不一致，这批数据不能用来判断效果。
      armViolations: armViolations.length,
      // 门槛：唯一、可配对的 HIGH opportunity 数（treatment + control）。
      eligiblePairedTurns: treatment.length + control.length,
    },
    anyCall: pairs.paired.filter(calledSomething).length,
    hintBytes: pairs.paired.filter((t) => t.injected === true).map((t) => t.hintBytes ?? 0),
    indexRows: [...new Set(pairs.discovery.map((t) => t.indexRows).filter((n) => typeof n === 'number'))],
  }
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
  lines.push('── 实验：同一个 HIGH 总体里的随机分臂 ──')
  lines.push('')
  const e = summary.experiment
  lines.push('① 提示 → Agent 是否开始 skill_search（**核心指标**）')
  lines.push('  ' + pad('treatment（有提示）：', 26) + e.treatment.pairedTurns + ' 个回合，' + e.treatment.calls + ' 个搜了 → ' + pct(e.treatment.rate))
  lines.push('  ' + pad('control（无提示）：', 26) + e.control.pairedTurns + ' 个回合，' + e.control.calls + ' 个搜了 → ' + pct(e.control.rate))
  if (e.treatment.rate !== null && e.control.rate !== null) {
    const delta = (e.treatment.rate - e.control.rate) * 100
    lines.push('  ' + pad('差值：', 26) + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' 个百分点')
  }
  lines.push('')
  lines.push('② search → skill_load（两组分别看）')
  lines.push('  ' + pad('treatment 里加载了：', 26) + e.treatment.load.calls + ' → ' + pct(e.treatment.load.rate))
  lines.push('  ' + pad('control 里加载了：', 26) + e.control.load.calls + ' → ' + pct(e.control.load.rate))
  lines.push('')
  lines.push('③ 候选相关性（HIGH 的 top-5 里至少一个明显相关）')
  lines.push('  **这个脚本算不出来，必须人工抽样。** 且它是前置门槛：相关性不过关时，①② 的差值没有解释力。')
  lines.push('')
  lines.push(pad('非合格回合（不进分臂）：', 26) + e.notEligiblePairedTurns + '（NONE/MEDIUM 或旧记录）')
  if (e.armViolations > 0) lines.push('  ⚠️ 分配与实际注入不一致的回合：' + e.armViolations + ' —— 这批数据不能用来判断效果')
  else lines.push('  ' + pad('分配与实际注入一致：', 26) + '是（0 处冲突）')
  lines.push('')
  if (e.eligiblePairedTurns < 50) {
    lines.push('结论：唯一、可配对的 HIGH opportunity 只有 ' + e.eligiblePairedTurns + ' 个（需要 ≥50，约各半）。继续收集。')
  } else if (e.treatment.pairedTurns < 20 || e.control.pairedTurns < 20) {
    lines.push('结论：总数过了 50，但某一臂不足 20 → 分臂随机性存疑，再看几天。')
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
  const summary = summarise(pairs)
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    return 0
  }
  log(renderReport(summary))
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
