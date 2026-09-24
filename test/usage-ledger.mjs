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

const { buildLedger, normalizeSkillName, splitNames } = internals
/** 供断言使用的视图：按显示顺序列出技能名。 */
const names = (ledger) => ledger.files.map((file) => file.skill)

/** 一条会话事件，形状照抄实测的 tool/call。 */
const call = (callId, name, args, seq) => ({ type: 'tool/call', seq: seq === undefined ? 1 : seq, time: 1, data: { turn: 1, step: 1, callId, name, arguments: args } })
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
check('skill_search 不算加载（搜索不等于使用）', searched.files.length === 0 && searched.calls === 0, JSON.stringify(names(searched)))
const unrelated = buildLedger(entries([call('c5', 'pwsh', { command: 'ls' }), other('tool/result')]), {})
check('无关工具与其它事件类型被忽略', unrelated.files.length === 0)
// 参数是原始 JSON 字符串时同样要认出来（模型可能给字符串）。
const rawArgs = buildLedger(entries([call('c6', 'skill_load', '{"name":"gh-cli"}')]), {})
check('arguments 为 JSON 字符串时同样识别', names(rawArgs).join() === 'gh-cli', JSON.stringify(names(rawArgs)))

// --- 2. callId 是事件身份：同一调用跨分页只算一次 --------------------------------
const twice = buildLedger(entries([call('same', 'skill_load', { name: 'gh-cli' }), call('same', 'skill_load', { name: 'gh-cli' })]), {})
check('同一 callId 只计一次（跨分页重复不产生 A B A）', twice.calls === 1 && twice.files.length === 1, 'calls=' + twice.calls + ' rows=' + twice.files.length)
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
check('窗口挤出后先读到的记录不丢', names(second).join() === 'later-one,earlier-one', JSON.stringify(names(second)))
check('顺序稳定：先记到的在前', names(second)[0] === 'later-one', JSON.stringify(names(second)))
check('累积后完整性变为 complete', second.completeness === 'complete', second.completeness)
check('调用计数在合并后仍然正确', second.calls === 2, 'calls=' + second.calls)

// --- 7. live append：同一份累积状态喂入新事件，立即出现 --------------------------
const liveFirst = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' })]), { hasMore: true })
const liveSecond = buildLedger(entries([call('c1', 'skill_load', { name: 'a-b' }), call('c2', 'skill', { name: 'c-d' })]), { hasMore: true, previous: liveFirst })
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
check('缺 callId 的调用被跳过（无法去重就不能计数）', buildLedger(entries([call('', 'skill_load', { name: 'x' })]), {}).calls === 0)
check('arguments 为 null 的调用被跳过', buildLedger(entries([call('c', 'skill_load', null)]), {}).calls === 0)
check('splitNames 容忍非字符串', splitNames(undefined).length === 0 && splitNames(42).join() === '42' && splitNames(['a', null, '', 'a']).join() === 'a', JSON.stringify(splitNames(['a', null, '', 'a'])))

console.log(problems.length === 0 ? '\n技能账本: OK' : '\n技能账本 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
