// 技能账本的测试。
//
// 夹具形状来自实测（不是推断）：
//   { type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }
// 这份契约由三轮探针确认：legacy.nodes 不是完整历史；eventSource 是账本；
// 账本自带 live append 且窗口有上限（实测约 1664–1900 条，曾见 3336 → 1664 回落）。
//
// 测试通过**真实加载路径**拿到 client.js 的内部实现：插桩 __ModuleLoader__ → 物化 factory
// → 用桩 ctx 调 apply → 取 __internals。测的是真代码，不是另写一份等价实现。
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { fileURLToPath } from 'node:url'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
let captured
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  console: { log() {}, error() {} },
}
sandbox.globalThis = sandbox
new Script(source).runInContext(createContext(sandbox))
const plugin = captured.factory(() => ({ createElement: () => null }))
// `apply` 用桩 ctx 调用。桩必须让 ctx.get('slots') 返回东西：真实的 apply 在注册表缺席时
// 会提前 return，而“提前 return”正是测试缝自己失踪的原因——桩返回 undefined 时，测试会
// 把自身的错误算在文件头上。
//
// apply 的所有注册都在 ctx.effect 里，这里只登记闭包不执行，因此测试不需要 DOM、
// 不需要 slot 注册表、也不需要宿主。
const effects = []
plugin.apply({
  get: (name) => (name === 'slots' ? { inject: () => () => {}, register: () => () => {} } : undefined),
  effect: (fn) => {
    effects.push(fn)
    return () => {}
  },
  on: () => () => {},
})
const internals = plugin.__internals
check('client.js 暴露内部实现供测试', internals !== undefined && typeof internals.buildLedger === 'function')
check('apply 只登记 effect，不直接注册 slot', effects.length === 2, 'effects=' + effects.length)
if (internals === undefined) {
  console.log('\n技能账本 FAILED: 无法取得内部实现')
  process.exit(1)
}

const { buildLedger, normalizeSkillName, splitNames, resultCallIdOf, resultTextOf, parseSearchHits, parseRunCodeCalls } = internals
/** 供断言使用的视图：按显示顺序列出技能名。 */
const names = (ledger) => ledger.files.map((file) => file.skill)

/** 一条会话事件，形状照抄实测的 tool/call。 */
let seqCounter = 0
// `seq` 在真实事件里是会话级单调计数器，每条事件各不相同。夹具必须照抄这一点：
// 早先默认所有事件都用 seq=1，于是"两个不同 callId"在事件身份上成了同一条事件。
const call = (callId, name, args, seq) => {
  seqCounter += 1
  return { type: 'tool/call', seq: seq === undefined ? seqCounter : seq, time: 1, data: { turn: 1, step: 1, callId, name, arguments: args } }
}
const other = (type, seq) => ({ type, seq: seq === undefined ? 2 : seq, time: 1, data: {} })
const entries = (list) => list.map((event) => ({ type: 'event', event }))

console.log('技能账本:')

// --- 1. 三种加载工具都算，skill_search 不算 --------------------------------------
const basic = buildLedger(entries([call('c1', 'skill_load', { name: 'gh-cli' })]), {})
check('skill_load 被记录', names(basic).join() === 'gh-cli', JSON.stringify(names(basic)))
const resident = buildLedger(entries([call('c2', 'skill', { name: 'writing-plans' })]), {})
check('内置 skill 被记录', names(resident).join() === 'writing-plans', JSON.stringify(names(resident)))
const ref = buildLedger(entries([call('c3', 'skill_ref', { name: 'semgrep', path: 'a.md' })]), {})
check('skill_ref 被记录', names(ref).join() === 'semgrep', JSON.stringify(names(ref)))
const searched = buildLedger(entries([call('c4', 'skill_search', { query: 'x' })]), {})
check('skill_search 无 result 时显示查询行', searched.files.length === 1 && searched.files[0].skill === '🔍 x' && searched.files[0].tool === 'skill_search', JSON.stringify(names(searched)))
const unrelated = buildLedger(entries([call('c5', 'pwsh', { command: 'ls' }), other('tool/result')]), {})
check('无关工具与其它事件类型被忽略', unrelated.files.length === 0)
// 参数是原始 JSON 字符串时同样要认出来（模型可能给字符串）。
const rawArgs = buildLedger(entries([call('c6', 'skill_load', '{"name":"gh-cli"}')]), {})
check('arguments 为 JSON 字符串时同样识别', names(rawArgs).join() === 'gh-cli', JSON.stringify(names(rawArgs)))

// --- 2. callId 是事件身份：同一调用跨分页只算一次 --------------------------------
const twice = buildLedger(entries([call('same', 'skill_load', { name: 'gh-cli' }, 700), call('same', 'skill_load', { name: 'gh-cli' }, 700)]), {})
check('同一条事件被投递两次只计一次（跨分页重复不产生 A B A）', twice.calls === 1 && twice.files.length === 1, 'calls=' + twice.calls + ' rows=' + twice.files.length)
// (2) 上游边界：两条**不同**事件共用同一个 callId（比如网关或模型让不同调用拿到同一个
//     tool-call 配对 id）。按事件身份计数，它们必须算两次——若按 callId 去重就会静默少算一次。
const sharedId = buildLedger(entries([call('collide', 'skill_load', { name: 'gh-cli' }, 800), call('collide', 'skill_load', { name: 'semgrep' }, 900)]), {})
check('不同事件共用同一 callId 时仍算两次调用（不静默少算）', sharedId.calls === 2 && sharedId.files.length === 2, 'calls=' + sharedId.calls + ' rows=' + sharedId.files.length)
const distinct = buildLedger(entries([call('c1', 'skill_load', { name: 'gh-cli' }), call('c2', 'skill_load', { name: 'gh-cli' })]), {})
check('两个不同 callId 加载同一技能：2 次调用、1 个唯一技能', distinct.calls === 2 && distinct.uniqueSkills === 1, 'calls=' + distinct.calls + ' unique=' + distinct.uniqueSkills)

// --- 3. 一次 callId 可带多个技能名（name / names 两种形态） ----------------------
const multi = buildLedger(entries([call('m1', 'skill_load', { names: 'alpha, beta' })]), {})
check('一次调用带两个技能名：两行、1 次调用', multi.files.length === 2 && multi.calls === 1 && multi.uniqueSkills === 2, 'rows=' + multi.files.length + ' calls=' + multi.calls)
check('A+B 两个技能都保留，顺序稳定', names(multi).join() === 'alpha,beta', JSON.stringify(names(multi)))
const multiArray = buildLedger(entries([call('m2', 'skill_load', { names: '["alpha","beta"]' })]), {})
check('names 为 JSON 字符串数组时同样展开', names(multiArray).join() === 'alpha,beta', JSON.stringify(names(multiArray)))
const multiReal = buildLedger(entries([call('m4', 'skill_load', { names: ['alpha', 'beta'] })]), {})
check('names 为真数组时同样展开', names(multiReal).join() === 'alpha,beta', JSON.stringify(names(multiReal)))
const multiUnique = buildLedger(entries([call('m3', 'skill_load', { names: 'alpha, alpha' })]), {})
check('同一次调用里重复的名字只留一条', multiUnique.files.length === 1 && multiUnique.calls === 1)
const mixed = buildLedger(entries([call('m5', 'skill_load', { name: 'alpha', names: 'beta,alpha' })]), {})
check('name 与 names 合并后去重', names(mixed).join() === 'alpha,beta', JSON.stringify(names(mixed)))
const capped = buildLedger(entries([call('m6', 'skill_load', { names: 'n1,n2,n3,n4,n5,n6,n7,n8,n9,n10' })]), {})
check('单次调用最多记 8 个（与 router 的 LOAD_CAP 一致）', capped.files.length === 8, 'rows=' + capped.files.length)

// --- 4. 名字规范化 --------------------------------------------------------------
check('全文路径规范化为技能名', normalizeSkillName('Q:/lib/skills/gh-cli/SKILL.md') === 'gh-cli', normalizeSkillName('Q:/lib/skills/gh-cli/SKILL.md'))
check('@scope/name/ 规范化', normalizeSkillName('@scope/name/') === 'name', normalizeSkillName('@scope/name/'))
check('repo/name 取末段', normalizeSkillName('trailofbits/semgrep') === 'semgrep', normalizeSkillName('trailofbits/semgrep'))
check('Windows 反斜杠路径', normalizeSkillName('Q:\\lib\\skills\\gh-cli') === 'gh-cli', normalizeSkillName('Q:\\lib\\skills\\gh-cli'))
// 路径与裸名指向同一个技能时不能算两个。
const sameSkill = buildLedger(entries([call('p1', 'skill_load', { name: 'Q:/lib/skills/gh-cli/SKILL.md' }), call('p2', 'skill_load', { name: 'gh-cli' })]), {})
check('路径与裸名归并为同一技能', sameSkill.uniqueSkills === 1 && sameSkill.calls === 2, 'unique=' + sameSkill.uniqueSkills + ' calls=' + sameSkill.calls)

// --- 5. 完整性三态：只有翻完才叫完整 --------------------------------------------
const partial = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' })]), { hasMore: true })
check('hasMore=true 时 report 为 partial', partial.completeness === 'partial', partial.completeness)
const complete = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' })]), { hasMore: false })
check('hasMore=false 时 report 为 complete', complete.completeness === 'complete', complete.completeness)
const loading = buildLedger(entries([]), { hasMore: true, loading: true })
check('正在翻页时 report 为 loading', loading.completeness === 'loading', loading.completeness)
const errored = buildLedger(entries([]), { hasMore: true, error: 'boom' })
check('出错时 report 为 error（不冒充 partial）', errored.completeness === 'error', errored.completeness)
// 空窗口 + 已读完，才是真的“没加载过”。
const emptyDone = buildLedger(entries([other('step/start')]), { hasMore: false })
check('读完且无记录时才是空账本', emptyDone.files.length === 0 && emptyDone.completeness === 'complete')

// --- 6. 窗口上限导致的历史挤出：已读到的记录不得丢失 ------------------------------
// 第 0 页是新的一端，只含较新的调用；随后 loadOlder 把更早的 skill_load 拉进来。
const page0 = entries([other('step/start', 100), call('late', 'skill_load', { name: 'later-one' }, 101)])
const first = buildLedger(page0, { hasMore: true })
check('第 0 页读到较新的调用，且标为未读完', names(first).join() === 'later-one' && first.completeness === 'partial', JSON.stringify(names(first)))
// 第二页到来时，窗口里可能已经不含 late（被挤出），但累积状态里必须还在。
const page1 = entries([call('early', 'skill_load', { name: 'earlier-one' }, 1)])
const second = buildLedger(page1, { hasMore: false, previous: first })
check('窗口挤出后先读到的记录不丢', names(second).sort().join() === 'earlier-one,later-one', JSON.stringify(names(second)))
// 注意断的是**会话顺序**（seq 小的在前），不是"读到的先后"：真机上读到的先后恰好是反的。
check('按会话顺序排列：seq 小的在前，而不是先读到的在前', names(second).join() === 'earlier-one,later-one', JSON.stringify(names(second)))
check('累积后完整性变为 complete', second.completeness === 'complete', second.completeness)
check('调用计数在合并后仍然正确', second.calls === 2, 'calls=' + second.calls)

// --- 7. live append：同一份累积状态喂入新事件，立即出现 --------------------------
const liveFirst = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' }, 300)]), { hasMore: true })
const liveSecond = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' }, 300), call('c2', 'skill', { name: 'c-d' }, 301)]), { hasMore: true, previous: liveFirst })
check('新事件 append 后立即可见', names(liveSecond).join() === 'a-b,c-d', JSON.stringify(names(liveSecond)))
check('live 追加不重复已有记录', liveSecond.calls === 2 && liveSecond.files.length === 2, 'calls=' + liveSecond.calls)

// --- 8. 参数缺失 / 坏输入不抛 ---------------------------------------------------
for (const weird of [undefined, null, 'x', 42, {}, [null, 7, 'x'], entries([null, 7]), entries([{ type: 'event', event: { type: 'tool/call' } }]), entries([call('c', 'skill_load', null)]), entries([call('', 'skill_load', { name: 'x' })]), entries([{ event: null }])]) {
  let threw
  let value
  try {
    value = buildLedger(weird, {})
  } catch (error) {
    threw = error
  }
  check('坏输入返回账本而非抛错: ' + JSON.stringify(weird), threw === undefined && value !== undefined && Array.isArray(value.files), threw === undefined ? undefined : String(threw))
}
check('缺 callId 的调用仍被记录（身份来自事件，不再依赖 callId）', buildLedger(entries([call('', 'skill_load', { name: 'x' })]), {}).calls === 1)
check('arguments 为 null 的调用被跳过', buildLedger(entries([call('c', 'skill_load', null)]), {}).calls === 0)
check('splitNames 容忍非字符串', splitNames(undefined).length === 0 && splitNames(42).join() === '42' && splitNames(['a', null, '', 'a']).join() === 'a', JSON.stringify(splitNames(['a', null, '', 'a'])))

// --- 9. 顺序：按事件自己的 seq，而不是读到的先后 --------------------------------
//
// 真机报告暴露了这条：列表是**倒序**的（第 31 轮排在第 5 轮前面）。原因是事件本来就以"最新在前"
// 到达，而更早的页是**前插**进来的，于是"读到的先后"恰好是会话顺序的反面。`seq` 是会话自己的
// 单调计数，按它排序才是时间线——无论页以什么顺序到达。
{
  const newest = buildLedger(entries([call('c3', 'skill_load', { name: 'third' }, 300), call('c2', 'skill_load', { name: 'second' }, 200)]), {})
  check('页 0 是新的一端（读入顺序是最新在前）', names(newest).join() === 'second,third', JSON.stringify(names(newest)))
  const older = buildLedger(entries([call('c1', 'skill_load', { name: 'first' }, 100)]), { previous: newest })
  check('回填更早的页后按会话顺序排列（first 在前）', names(older).join() === 'first,second,third', JSON.stringify(names(older)))
  check('回填不改变计数', older.calls === 3 && older.uniqueSkills === 3, 'calls=' + older.calls)
  const sameSeq = buildLedger(entries([call('m', 'skill_load', { names: 'alpha,beta' }, 50)]), {})
  check('同一 seq 的多行保持稳定顺序', names(sameSeq).join() === 'alpha,beta', JSON.stringify(names(sameSeq)))
  const noSeq = buildLedger(entries([{ type: 'tool/call', data: { callId: 'x', name: 'skill_load', arguments: { name: 'no-seq' } } }, call('y', 'skill_load', { name: 'has-seq' }, 10)]), {})
  check('缺 seq 的记录排在最后而不是最前', names(noSeq).join() === 'has-seq,no-seq', JSON.stringify(names(noSeq)))
}

// --- 10. 计数与行数必须结构上一致 ------------------------------------------------
//
// 真机报告里出现过「18 行 / 17 次调用」这样的组合。原因是 calls 曾经是一个**独立累加**的计数器，
// 而 files 由键去重决定——同一个事实有两个来源，就能漂移。现在 calls 从最终记录派生，于是
// `calls <= rows` 永远成立，且仅当没有一次调用点名多个技能时取等号。
{
  const one = buildLedger(entries([call('a', 'skill_load', { name: 'x' }, 1), call('b', 'skill_load', { name: 'y' }, 2)]), {})
  check('每次调用一个技能时 行数 == 调用数', one.files.length === 2 && one.calls === 2, 'rows=' + one.files.length + ' calls=' + one.calls)
  const two = buildLedger(entries([call('a', 'skill_load', { names: 'x,y' }, 1), call('b', 'skill_load', { name: 'z' }, 2)]), {})
  check('一次调用点名两个技能时 调用数 < 行数', two.files.length === 3 && two.calls === 2, 'rows=' + two.files.length + ' calls=' + two.calls)
  // 跨页重复投递 + 参数形态不同：仍然只算一次调用，也只留一行。
  const p1 = buildLedger(entries([call('a', 'skill_load', '{"name":"x"}', 1)]), { hasMore: true })
  const p2 = buildLedger(entries([call('a', 'skill_load', { name: 'x' }, 1)]), { hasMore: false, previous: p1 })
  check('重复投递不增加行数也不增加调用数', p2.files.length === 1 && p2.calls === 1, 'rows=' + p2.files.length + ' calls=' + p2.calls)
  // 被 MAX_NAMES 截掉的名字不得留下一个"有名无行"的调用。
  const capped = buildLedger(entries([call('a', 'skill_load', { names: 'n1,n2,n3,n4,n5,n6,n7,n8,n9' }, 1)]), {})
  check('被截断的名字不影响行数与调用数的一致性', capped.files.length === 8 && capped.calls === 1, 'rows=' + capped.files.length + ' calls=' + capped.calls)
  const none = buildLedger(entries([call('a', 'skill_load', { name: '///' }, 1), call('b', 'skill_load', { name: 'ok' }, 2)]), {})
  check('没有可用名字的调用不计入调用数', none.calls === 1 && none.files.length === 1, 'rows=' + none.files.length + ' calls=' + none.calls)
}

// --- 11. skill_search 结果追踪：搜索找到了什么，而非问了什么 ------------------------
//
// 搜索本身不是加载（第 1 节已验），但一次成功的搜索证明了库是活的——这个事件以前在
// 标签页里完全不可见。修法是显示搜索*找到*的技能（tool/result 里的 hits），不是它*问*
// 的词（tool/call 里的 query）。技能名在 result 事件里，所以先索引 call、再用 callId 配对。
{
  // tool/result 事件夹具：0.1.6 shape（tool-result wrapper block）。
  let resSeq = 1000
  const searchResult = (callId, text, seq) => ({
    type: 'tool/result',
    seq: seq === undefined ? (resSeq += 1) : seq,
    time: 1,
    data: {
      message: {
        source: { callId },
        content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
      },
    },
  })
  // 0.1.7 shape：text blocks 在 message.content 顶层，无 tool-result wrapper。
  const searchResultFlat = (callId, text, seq) => ({
    type: 'tool/result',
    seq: seq === undefined ? (resSeq += 1) : seq,
    time: 1,
    data: { message: { source: { callId }, content: [{ type: 'text', text }] } },
  })
  const sampleText = '2 match(es) in dsh-skill-router; showing 2\n- gh-cli  [trailofbits]\n    Enforces authenticated gh CLI workflows.\n- semgrep  [trailofbits]\n    Find security vulnerabilities.'

  // 搜索 + 结果 → 找到的技能出现在列表里
  const found = buildLedger(entries([
    call('s1', 'skill_search', { query: 'security cli' }, 100),
    searchResult('s1', sampleText, 101),
  ]), {})
  check('搜索结果中的技能被记录', names(found).join() === 'gh-cli,semgrep', JSON.stringify(names(found)))
  check('搜索结果行的 tool 字段为 skill_search', found.files.every((f) => f.tool === 'skill_search'), JSON.stringify(found.files.map((f) => f.tool)))
  check('一次搜索算一次调用', found.calls === 1, 'calls=' + found.calls)
  check('两个命中是两个唯一技能', found.uniqueSkills === 2, 'unique=' + found.uniqueSkills)

  // 0.1.7 shape 同样工作
  const foundFlat = buildLedger(entries([
    call('s2', 'skill_search', { query: 'x' }, 200),
    searchResultFlat('s2', sampleText, 201),
  ]), {})
  check('0.1.7 shape 的结果同样解析', names(foundFlat).join() === 'gh-cli,semgrep', JSON.stringify(names(foundFlat)))

  // 搜索无结果 → 不产生行
  const empty = buildLedger(entries([
    call('s3', 'skill_search', { query: 'zzz' }, 300),
    searchResult('s3', '0 match(es) in dsh-skill-router; showing 0', 301),
  ]), {})
  check('搜索无结果时不产生行', empty.files.length === 0 && empty.calls === 0, 'rows=' + empty.files.length + ' calls=' + empty.calls)

  // 搜索有结果但 result 事件不在窗口里 → 显示查询行（eventSource 不含 tool/result，这是生产的常态）
  const noResult = buildLedger(entries([call('s4', 'skill_search', { query: 'x' }, 400)]), {})
  check('搜索 call 无 result 时显示查询行', noResult.files.length === 1 && noResult.files[0].skill === '🔍 x' && noResult.calls === 1, 'rows=' + noResult.files.length + ' names=' + JSON.stringify(names(noResult)))

  // 查询行跨页重复投递不产生重复行
  const qPage1 = buildLedger(entries([call('s10', 'skill_search', { query: 'deploy' }, 900)]), { hasMore: true })
  const qPage2 = buildLedger(entries([call('s10', 'skill_search', { query: 'deploy' }, 900)]), { hasMore: false, previous: qPage1 })
  check('查询行跨页重复不产生重复行', qPage2.files.length === 1 && qPage2.calls === 1, 'rows=' + qPage2.files.length + ' calls=' + qPage2.calls)

  // 有 result 的搜索不显示查询行（result 优先于 query fallback）
  const withResult = buildLedger(entries([
    call('s11', 'skill_search', { query: 'security' }, 950),
    searchResult('s11', sampleText, 951),
  ]), {})
  check('有 result 时不显示查询行', withResult.files.every((f) => !f.skill.startsWith('🔍 ')), JSON.stringify(names(withResult)))

  // result 事件在数组中排在 call 前面（newest-first）→ 仍能配对
  const reversed = buildLedger(entries([
    searchResult('s5', sampleText, 501),
    call('s5', 'skill_search', { query: 'x' }, 500),
  ]), {})
  check('result 在 call 之前（newest-first）仍能配对', names(reversed).join() === 'gh-cli,semgrep', JSON.stringify(names(reversed)))

  // 搜索 + 加载混合：两种都出现
  const mixed = buildLedger(entries([
    call('s6', 'skill_search', { query: 'x' }, 600),
    searchResult('s6', '- gh-cli  [trailofbits]\n    desc', 601),
    call('s7', 'skill_load', { name: 'writing-plans' }, 602),
  ]), {})
  check('搜索与加载混合：两者都记录', names(mixed).join() === 'gh-cli,writing-plans', JSON.stringify(names(mixed)))
  check('混合：2 次调用', mixed.calls === 2, 'calls=' + mixed.calls)

  // 同一搜索跨页重复投递不产生重复行
  const page1 = buildLedger(entries([
    call('s8', 'skill_search', { query: 'x' }, 700),
    searchResult('s8', sampleText, 701),
  ]), { hasMore: true })
  const page2 = buildLedger(entries([
    call('s8', 'skill_search', { query: 'x' }, 700),
    searchResult('s8', sampleText, 701),
  ]), { hasMore: false, previous: page1 })
  check('搜索结果跨页重复不产生重复行', page2.files.length === 2 && page2.calls === 1, 'rows=' + page2.files.length + ' calls=' + page2.calls)

  // MAX_NAMES 同样限制搜索结果
  const manyHits = Array.from({ length: 12 }, (_, k) => '- skill-' + k + '  [repo]').join('\n')
  const cappedSearch = buildLedger(entries([
    call('s9', 'skill_search', { query: 'x' }, 800),
    searchResult('s9', manyHits, 801),
  ]), {})
  check('搜索结果也受 MAX_NAMES=8 限制', cappedSearch.files.length === 8, 'rows=' + cappedSearch.files.length)
}

// --- 12. parseSearchHits / resultTextOf / resultCallIdOf 单元 ----------------------
{
  check('parseSearchHits 提取技能名', parseSearchHits('- gh-cli  [trailofbits]\n    desc\n- semgrep').join() === 'gh-cli,semgrep', JSON.stringify(parseSearchHits('- gh-cli  [trailofbits]\n    desc\n- semgrep')))
  check('parseSearchHits 跳过描述行', parseSearchHits('    description\n- skill-a').join() === 'skill-a', JSON.stringify(parseSearchHits('    description\n- skill-a')))
  check('parseSearchHits 空文本返回空数组', parseSearchHits('').length === 0)
  check('parseSearchHits 无命中返回空数组', parseSearchHits('0 match(es); showing 0').length === 0)
  check('parseSearchHits 容忍非字符串', parseSearchHits(undefined).length === 0 && parseSearchHits(null).length === 0)
  check('parseSearchHits 无 repo 的技能名', parseSearchHits('- bare-skill').join() === 'bare-skill', JSON.stringify(parseSearchHits('- bare-skill')))
  check('parseSearchHits catalog 来源', parseSearchHits('- my-skill  [catalog:source]').join() === 'my-skill', JSON.stringify(parseSearchHits('- my-skill  [catalog:source]')))

  const event = { type: 'tool/result', data: { message: { source: { callId: 'abc' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hi' }] }] } } }
  check('resultCallIdOf 提取 callId', resultCallIdOf(event) === 'abc', resultCallIdOf(event))
  check('resultTextOf 提取文本（0.1.6）', resultTextOf(event) === 'hi', resultTextOf(event))
  const flat = { type: 'tool/result', data: { message: { source: { callId: 'xyz' }, content: [{ type: 'text', text: 'hello' }] } } }
  check('resultCallIdOf 提取 callId（0.1.7）', resultCallIdOf(flat) === 'xyz', resultCallIdOf(flat))
  check('resultTextOf 提取文本（0.1.7）', resultTextOf(flat) === 'hello', resultTextOf(flat))
  check('resultCallIdOf 容忍坏输入', resultCallIdOf(undefined) === '' && resultCallIdOf({}) === '' && resultCallIdOf({ data: {} }) === '')
  check('resultTextOf 容忍坏输入', resultTextOf(undefined) === undefined && resultTextOf({}) === undefined && resultTextOf({ data: {} }) === undefined)
}

// --- 13. run_code 内嵌调用解析 ------------------------------------------------
{
  // run_code 事件：arguments.code 含 tools.skill_search 和 tools.skill_load 调用
  const rcCode = [
    'const a = await tools.skill_search({ query: "plugin security review", limit: 8 })',
    'const b = await tools.skill_load({ name: "test-driven-development" })',
    'const c = await tools.skill_search({ query: "univer spreadsheet excel", limit: 5 })',
  ].join('\n')
  const rcEvent = call('rc1', 'run_code', { code: rcCode, description: 'test' }, 500)
  const rcLedger = buildLedger(entries([rcEvent]), {})
  check('run_code 含 skill_search 产生查询行', rcLedger.files.some(f => f.skill === '\u{1F50D} plugin security review' && f.tool === 'skill_search'), JSON.stringify(names(rcLedger)))
  check('run_code 含第二个 skill_search 也产生查询行', rcLedger.files.some(f => f.skill === '\u{1F50D} univer spreadsheet excel' && f.tool === 'skill_search'), JSON.stringify(names(rcLedger)))
  check('run_code 含 skill_load 产生加载行', rcLedger.files.some(f => f.skill === 'test-driven-development' && f.tool === 'skill_load'), JSON.stringify(names(rcLedger)))
  check('run_code 内嵌调用计入 calls（2 搜索 + 1 加载 = 3 次调用）', rcLedger.calls === 3, 'calls=' + rcLedger.calls)

  // bracket access form: tools["skill_search"]
  const rcCode2 = 'await tools["skill_search"]({ query: "chinese cjk tokenizer", limit: 3 })'
  const rc2 = buildLedger(entries([call('rc2', 'run_code', { code: rcCode2, description: 'test' }, 510)]), {})
  check('run_code bracket access 也识别', rc2.files.some(f => f.skill === '\u{1F50D} chinese cjk tokenizer'), JSON.stringify(names(rc2)))

  // skill_load with names (comma-separated)
  const rcCode3 = 'await tools.skill_load({ names: "alpha, beta, gamma" })'
  const rc3 = buildLedger(entries([call('rc3', 'run_code', { code: rcCode3, description: 'test' }, 520)]), {})
  check('run_code skill_load names 拆分', names(rc3).join() === 'alpha,beta,gamma', JSON.stringify(names(rc3)))

  // variable query (not a literal) — invisible, acceptable false negative
  const rcCode4 = 'const q = "dynamic"; await tools.skill_search({ query: q, limit: 3 })'
  const rc4 = buildLedger(entries([call('rc4', 'run_code', { code: rcCode4, description: 'test' }, 530)]), {})
  check('run_code 变量查询不产生行（假阴性可接受）', rc4.files.length === 0, 'rows=' + rc4.files.length)

  // run_code without skill calls — no rows
  const rcCode5 = 'const x = await tools.pwsh({ command: "ls" })'
  const rc5 = buildLedger(entries([call('rc5', 'run_code', { code: rcCode5, description: 'test' }, 540)]), {})
  check('run_code 无 skill 调用不产生行', rc5.files.length === 0, 'rows=' + rc5.files.length)

  // run_code with bad/missing code — no rows, no throw
  const rc6 = buildLedger(entries([call('rc6', 'run_code', { description: 'no code' }, 550)]), {})
  check('run_code 无 code 字段不产生行', rc6.files.length === 0, 'rows=' + rc6.files.length)
  const rc7 = buildLedger(entries([call('rc7', 'run_code', '{"description":"bad"}', 560)]), {})
  check('run_code arguments 为 JSON 字符串时同样识别', rc7.files.length === 0, 'rows=' + rc7.files.length)

  // parseRunCodeCalls unit tests
  const parsed = parseRunCodeCalls('tools.skill_search({ query: "test" }); tools.skill_load({ name: "gh-cli" })')
  check('parseRunCodeCalls 提取 search', parsed.searches.length === 1 && parsed.searches[0].query === 'test', JSON.stringify(parsed.searches))
  check('parseRunCodeCalls 提取 load', parsed.loads.length === 1 && parsed.loads[0].name === 'gh-cli', JSON.stringify(parsed.loads))
  check('parseRunCodeCalls 空代码返回空', parseRunCodeCalls('').searches.length === 0 && parseRunCodeCalls('').loads.length === 0)
  check('parseRunCodeCalls 容忍非字符串', parseRunCodeCalls(undefined).searches.length === 0 && parseRunCodeCalls(null).loads.length === 0)

  // dedup: same run_code event delivered twice (cross-page) — no duplicate rows
  const rcDup1 = buildLedger(entries([call('rcD', 'run_code', { code: rcCode, description: 'test' }, 600)]), { hasMore: true })
  const rcDup2 = buildLedger(entries([call('rcD', 'run_code', { code: rcCode, description: 'test' }, 600)]), { hasMore: false, previous: rcDup1 })
  check('run_code 跨页重复不产生重复行', rcDup2.files.length === rcDup1.files.length, 'p1=' + rcDup1.files.length + ' p2=' + rcDup2.files.length)
}

console.log(problems.length === 0 ? '\n技能账本: OK' : '\n技能账本 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
