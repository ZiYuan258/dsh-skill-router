// 实验读数脚本的测试。
//
// 这个脚本的价值全在一件事上：**不把"未知"当成"0 次"**。按回合的计数天生右截断——
//
//   回合 10 开始 → 累计调用
//   回合 11 开始 → 才把回合 10 的数落盘
//
// 所以最后一个已完成的回合、以及中止/崩溃的回合**没有** turn-calls 记录。若分析时把"没有记录"
// 当成 search=0，一个上升的搜索率会被算成没变化。这个文件就是钉住这件事。
//
// 另外钉住配对键：**必须是 (会话标签, 回合)，不是回合**。实测真机日志里 `turn` 1 出现过 3 次、
// 14 个 turn 号被重复——只用 turn 会把不同会话合并。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, pairKey, pairTurns, summarise } from '../tools/discovery-report.mjs'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? '    ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

/** 一条发现记录。 */
const disc = (turn, tier, extra = {}) => JSON.stringify({ at: '2026-01-01T00:00:00.000Z', turn, step: 1, sessionKey: 'aaaa1111', tier, reason: 'ok', tokenCount: 3, effectiveTokenCount: 2, filteredCommonTokens: 1, ignoredTokenRatios: [1], indexRows: 1025, candidateCount: tier === 'NONE' ? 0 : 5, candidates: [], injected: tier === 'HIGH', hintBytes: tier === 'HIGH' ? 330 : 0, ...extra })
/** 一条回合计数记录。 */
const call = (turn, search, load, extra = {}) => JSON.stringify({ at: '2026-01-01T00:00:00.000Z', kind: 'turn-calls', turn, sessionKey: 'aaaa1111', tier: 'HIGH', injected: true, skillSearchCalls: search, skillLoadCalls: load, skillRefCalls: 0, residentSkillCalls: 0, otherToolCalls: 3, ...extra })

console.log('实验读数:')

// ── 1) 配对：有计数才算 paired，没有就是 unpaired（unknown）────────────────────
const text1 = [disc(1, 'HIGH'), call(1, 1, 1), disc(2, 'HIGH'), disc(3, 'NONE'), call(3, 0, 0)].join('\n')
const p1 = pairTurns(text1)
ok('三条发现记录、两条计数记录', p1.discovery.length === 3 && p1.calls.size === 2)
ok('配对成功的是 turn 1 与 turn 3', p1.paired.length === 2 && p1.unpaired.length === 1)
ok('turn 2 无计数 → unpaired（不是 0 次）', p1.unpaired[0].turn === 2)
const s1 = summarise(p1)
ok('分母只算可配对的回合（2，不是 3）', s1.injected.pairedTurns === 1, 'injected.pairedTurns=' + s1.injected.pairedTurns)
ok('① 注入后搜索率按 paired 算（1/1）', s1.injected.searchRate === 1, String(s1.injected.searchRate))
ok('② 加载率按 paired 算（1/1）', s1.injected.loadRate === 1, String(s1.injected.loadRate))
ok('未注入的对照也在（turn 3, 0 次搜索）', s1.notInjected.pairedTurns === 1 && s1.notInjected.searchRate === 0, JSON.stringify(s1.notInjected))

// ── 2) 反例：如果错误地把 unpaired 当成 0，比率会被拉低 ────────────────────────
// 3 个注入回合，1 个有计数且搜了、2 个无计数。正确 = 1/1 = 100%；错误 = 1/3 = 33%。
const text2 = [disc(1, 'HIGH'), call(1, 1, 0), disc(2, 'HIGH'), disc(3, 'HIGH')].join('\n')
const s2 = summarise(pairTurns(text2))
ok('未配对的注入回合被排除在分母外（正确算成 100%）', s2.injected.pairedTurns === 1 && s2.injected.searchRate === 1, JSON.stringify({ turns: s2.injected.pairedTurns, rate: s2.injected.searchRate }))
ok('未配对的回合仍被如实计数（2 个）', s2.records.unpaired === 2)

// ── 3) 配对键必须是 (sessionKey, turn) ────────────────────────────────────────
const text3 = [
  disc(40, 'HIGH', { sessionKey: 'aaaa1111' }), call(40, 2, 0, { sessionKey: 'aaaa1111' }),
  disc(40, 'HIGH', { sessionKey: 'bbbb2222' }), call(40, 0, 1, { sessionKey: 'bbbb2222' }),
].join('\n')
const s3 = summarise(pairTurns(text3))
ok('两个会话的同号回合各自配对（不合并）', s3.records.paired === 2, 'paired=' + s3.records.paired)
ok('同号回合的计数没有互相污染', s3.injected.pairedTurns === 2 && s3.injected.searchCalls === 1 && s3.injected.loadCalls === 1, JSON.stringify({ t: s3.injected.pairedTurns, s: s3.injected.searchCalls, l: s3.injected.loadCalls }))
// 反例：只用 turn 配对会怎样
const text3b = [
  disc(40, 'HIGH', { sessionKey: undefined }), call(40, 2, 0, { sessionKey: undefined }),
].join('\n')
ok('pairKey 对缺会话标签的记录给出 (none) 而不是崩溃', pairKey({ turn: 40 }) === '(none)#40', pairKey({ turn: 40 }))

// ── 4) 旧记录（无会话标签）被单独计数，不混进配对 ─────────────────────────────
// 两条**没有 sessionKey 的发现记录**：一条在 turn 5（有计数）、一条在 turn 99（无计数）。
// 第一版这里只放了一条发现记录，却断言 legacy===2——把计数记录也算进去了。legacy 统计的是
// **发现记录**（只有它们需要被配对），所以夹具要放两条发现记录才对应得上。
const legacyDisc = (turn) => JSON.stringify({ at: '2025-12-01T00:00:00.000Z', turn, step: 1, tier: 'HIGH', reason: 'ok', injected: true })
// 两边的 injected 必须一致：call 夹具默认写 injected:true，所以发现记录也要写 true，
// 否则同一条回合会被算进"未注入侧"（夹具不一致会造出假的失败——这次又是我的夹具问题）。
// call 要给 sessionKey: undefined：它默认带 'aaaa1111'，而 legacyDisc 不带，两边键不同就配不上。
const text4 = [legacyDisc(5), call(5, 1, 1, { sessionKey: undefined }), legacyDisc(99)].join('\n')
const p4 = pairTurns(text4)
ok('无会话标签的旧发现记录被单独报出', p4.legacy.length === 2, 'legacy=' + p4.legacy.length)
const s4 = summarise(p4)
// 有计数的旧记录照常配对（turn 5），没计数的仍算 unpaired（turn 99）——旧不等于不可用，
// 只是配对可靠性低，所以单独报出来让人判断。
ok('旧记录里能配对的仍然被配对', s4.injected.pairedTurns === 1 && s4.records.unpaired === 1, JSON.stringify({ injected: s4.injected.pairedTurns, unpaired: s4.records.unpaired }))

// ── 5) 坏行不让整份读数失败，但也不被吞掉 ─────────────────────────────────────
const text5 = [disc(1, 'HIGH'), call(1, 1, 1), '{ 这不是 JSON', ''].join('\n')
const p5 = pairTurns(text5)
ok('坏行被计数而不是抛出', p5.malformed === 1, 'malformed=' + p5.malformed)
ok('坏行不影响其余记录', p5.paired.length === 1)

// ── 6) indexRows 出现多个取值时要报警（语料换过，跨它对比不可靠）──────────────
const text6 = [disc(1, 'HIGH', { indexRows: 1025 }), call(1, 1, 1), disc(2, 'HIGH', { indexRows: 1028 }), call(2, 1, 1)].join('\n')
const s6 = summarise(pairTurns(text6))
ok('多个 indexRows 取值被收集起来', s6.indexRows.length === 2 && s6.indexRows.includes(1025) && s6.indexRows.includes(1028), JSON.stringify(s6.indexRows))

// ── 7) 未注入回合的搜索率也算（A/B 的对照侧）──────────────────────────────────
const text7 = [disc(1, 'NONE', { injected: false }), call(1, 1, 0, { tier: 'NONE', injected: false }), disc(2, 'HIGH'), call(2, 0, 0)].join('\n')
const s7 = summarise(pairTurns(text7))
ok('未注入侧有搜索时也被计入', s7.notInjected.pairedTurns === 1 && s7.notInjected.searchCalls === 1, JSON.stringify(s7.notInjected))
ok('注入侧 0 次搜索如实为 0', s7.injected.searchCalls === 0 && s7.injected.searchRate === 0)

// ── 8) CLI：日志不存在 → 退出码 2；--json 可解析 ───────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'report-'))
const logPath = join(dir, 'discovery.jsonl')
const QUIET = { log() {}, error() {} }
ok('日志不存在时退出码 2', main(['--log', join(dir, 'nope.jsonl')], QUIET) === 2)
writeFileSync(logPath, [disc(1, 'HIGH'), call(1, 2, 1)].join('\n'), 'utf8')
const chunks = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk) => {
  chunks.push(chunk)
  return true
}
const code = main(['--log', logPath, '--json'], QUIET)
process.stdout.write = realWrite
ok('--json 退出码 0', code === 0)
const payload = JSON.parse(chunks.join(''))
ok('--json 可解析且含三个指标', payload.injected !== undefined && payload.notInjected !== undefined && payload.records !== undefined, Object.keys(payload).slice(0, 6).join(','))
ok('--json 不含 token 文本（隐私默认）', JSON.stringify(payload).includes('ignoredTokens') === false, '')

rmSync(dir, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n实验读数: OK' : '\n实验读数 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
