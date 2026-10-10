// 发现层的接线测试：**HIGH 注入** + **每回合工具调用计数**。
//
// 这个文件经历了三个版本，值得记下演变的原因，因为它记录的正是这个仓库最警惕的那类错误：
//
//   v1（干跑） 断言"决策不被改变"—— 当时那是硬约束，因为什么都不注入。
//   v2 断言"HIGH 注入、其余不注入"—— 决策**必须**被改变，且只在 HIGH 时。
//   v3（本版） 注入层默认关停（INJECT_TIERS env-gated，见 host.js）。本测试在文件顶部把
//           DSH_SKILL_ROUTER_INJECT_TIERS=HIGH 设上，以继续验证接线；真机默认不注入。
//
// 上一版那两条断言（"干跑不改变决策"、"injected: false"）现在会红，而且**应该红**：行为按设计
// 变了。一个不会因为行为改变而变红的测试，等于没有在测行为。
//
// 这一版真正要证明的四件事：
//   1. 注入只发生在 `tier === HIGH` 且 `step === 1`，注入的消息形状合法（含唯一 id）；
//   2. 遥测如实记录 `injected` 与**实测的 hint 字节数**（不是估算）；
//   3. 每回合的工具调用被**在回合结束后**统计（`step 1` 时谁也不知道这一回合会不会去搜）；
//   4. 结算点是会话事件流里的 `turn/end`（外加 `session/disposed` 兜底），所以**会话的最后一个
//      回合也有记录**——首观测通常正落在那一回合。v1.15.5 之前只在下一回合的 `step 1` 结算，
//      于是每个会话永远缺最后一回合，主指标的分母被系统性挖空（实测：19 个合格会话只剩 1 个
//      可配对观测）。
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

// ── 夹具：一个能产出 HIGH 的库（命中 name 且 ≥2 个 token 落地）────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'discovery-inject-'))
const libraryRoot = join(workspace, '.skill-src')
mkdirSync(libraryRoot, { recursive: true })
writeFileSync(
  join(libraryRoot, 'skill-index.tsv'),
  ['repo\trelpath\tname\tdescription\tfiles\tKB\twhenToUse',
    'trailofbits\tskills/semgrep/SKILL.md\tsemgrep\tStatic analysis security review for source code\t1\t2\tsecurity audit, vulnerability scan, SAST',
    'superpowers\tskills/vbc/SKILL.md\tverification-before-completion\tEvidence before claims\t1\t2\tbefore claiming work is complete',
  ].join('\n') + '\n',
  'utf8',
)
const logPath = join(workspace, 'discovery.jsonl')
process.env.DSH_SKILL_ROUTER_DISCOVERY_LOG = logPath
// v3：注入层默认关停；这里显式打开以测接线（每个测试文件是独立 node 进程，不污染其它测试）。
process.env.DSH_SKILL_ROUTER_INJECT_TIERS = 'HIGH'
const mod = await import('../host.js')
const { experimentArmOf } = mod

function makeCtx() {
  const handlers = new Map()
  const registered = []
  const ctx = {
    fs: {
      async resolve(path) {
        return path
      },
      async stat() {
        return undefined
      },
      async readText() {
        return ''
      },
      async listDir() {
        return []
      },
    },
    tools: { register: (tool) => registered.push(tool) },
    get: () => undefined,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      if (handlers.has(event) === false) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    logger: { warn() {}, info() {} },
    _handlers: handlers,
    _registered: registered,
  }
  // 索引真实存在，所以走真实的库路径（而不是入门库回退）
  ctx.fs = {
    async resolve(p) {
      const abs = String(p)
      return { targetKey: abs, displayPath: abs }
    },
    async stat(target) {
      const { statSync } = await import('node:fs')
      try {
        const info = statSync(target.targetKey)
        return { version: String(info.mtimeMs), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return readFileSync(target.targetKey, 'utf8')
    },
    async listDir(target) {
      const { readdirSync } = await import('node:fs')
      return readdirSync(target.targetKey).map((name) => ({ name }))
    },
  }
  return ctx
}

const ctx = makeCtx()
mod.apply(ctx)

/** 驱动一次 pre-step，像 agent-loop 那样传入 `next` 决策。 */
async function preStep(payload, decision) {
  const handlers = ctx._handlers.get('agent/pre-step') ?? []
  let result = decision
  for (const handler of handlers) result = await handler(payload, async () => decision)
  return result
}

/**
 * 向会话事件流投递一次 tool/call。
 *
 * **session 是必填的。** 计数按 (会话标签, 回合) 定位，所以"这是哪个会话的调用"必须由调用方给出。
 * 第一版让它缺省时退回某个默认会话，结果旧调用点没传参就静默变成 unknown、计数全为 0——一个
 * "贴心的默认值"制造了一次看起来像产品缺陷的假失败。现在缺它就抛，而不是静默。
 */
function toolCall(name, session) {
  if (session === undefined) throw new Error('toolCall 需要一个 session（第二个参数）')
  for (const handler of ctx._handlers.get('session/event') ?? []) {
    handler(session, { type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 0, step: 0, callId: 'c', name, arguments: {} } })
  }
}

/**
 * 投递一次 `turn/end`：**这是结算点**。
 *
 * 真机上它由 `dsh-agent-loop` 在 `finally` 里 append（所以取消、报错的回合也被闭合），并和
 * `tool/call` 走同一条 `session/event` 通道；`dsh-session-projection-cache` 就是这么消费它的。
 * 事件里的 `turn` 故意写成 0：插件应当按**自己记录的回合**结算，而不是被事件里的数字带着走。
 */
function turnEnd(session) {
  if (session === undefined) throw new Error('turnEnd 需要一个 session')
  for (const handler of ctx._handlers.get('session/event') ?? []) {
    handler(session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 0, reason: { kind: 'completed' } } })
  }
}

/** 投递一次 `session/disposed`：会话在两个回合之间被销毁时的结算点。 */
function dispose(session) {
  if (session === undefined) throw new Error('dispose 需要一个 session')
  for (const handler of ctx._handlers.get('session/disposed') ?? []) handler(session)
}

const highTask = 'Run a semgrep security audit on this repo'
// 会话对象带 id：配对键是 (sessionKey, turn)，没有 id 就退化成 (unknown, turn)——那正是旧缺陷。
// header.createdAt 是 epoch 毫秒（真机实测形状），插件要把它归一化成 ISO 再落盘。
//
// 注意别写成 `agentFor(id, createdAt = 1789…)`：那样传 `undefined` 会触发**默认参数**，
// 于是"测拿不到创建时间"的用例其实拿到了默认值——夹具自己把被测场景换掉了（这个坑我踩了）。
const agentFor = (id, header) => ({ session: { id, header: header === undefined ? { cwd: workspace, createdAt: 1789000000000 } : header } })
const agent = agentFor('session-one')
const enter = (text) => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })

console.log('发现层（HIGH 注入 + 回合计数）:')

ok('apply 注册了三个工具', ctx._registered.length === 3, String(ctx._registered.length))
ok('apply 注册了 agent/pre-step 与 session/event 监听', (ctx._handlers.get('agent/pre-step') ?? []).length === 1 && (ctx._handlers.get('session/event') ?? []).length === 1)

// ── 0) 分臂函数本身：确定性、约 50/50、值域、以及"会话标签真的参与" ─────────────
//
// 这是整个实验的地基。分臂若有偏或不确定，读数会**看起来完全正常**却毫无意义——所以它先被测。
//
// 注意这一版修掉了两条**恒真断言**。上一版写的是：
//
//   new Set([...]).size >= 1                              // 任何集合都满足
//   armOf(A, 7) !== armOf(B, 7) || true                   // `|| true` 让整条永真
//
// 两条都在"测"会话标签参与分臂，实际什么都没测。现在改成固定夹具 + 明确的两臂断言。
const keyOf = (id) => createHash('sha256').update(id).digest('hex').slice(0, 8)
// 预先算好的夹具：这两个会话必定落 control，那两个必定落 treatment。
// 一旦哈希或阈值被改动，夹具就会失配——那正是它该做的事。
const CONTROL_FIXTURE = 'fixture-session-1'
const TREATMENT_FIXTURE = 'fixture-session-0'
ok('固定夹具 A 落在 control（' + experimentArmOf(keyOf(CONTROL_FIXTURE)) + '）', experimentArmOf(keyOf(CONTROL_FIXTURE)) === 'control')
ok('固定夹具 B 落在 treatment（' + experimentArmOf(keyOf(TREATMENT_FIXTURE)) + '）', experimentArmOf(keyOf(TREATMENT_FIXTURE)) === 'treatment')
ok('同会话重复调用永远同臂（确定性）', experimentArmOf(keyOf(CONTROL_FIXTURE)) === experimentArmOf(keyOf(CONTROL_FIXTURE)) && experimentArmOf(keyOf(TREATMENT_FIXTURE)) === experimentArmOf(keyOf(TREATMENT_FIXTURE)))
// 会话标签**真的**参与：换标签会改变分配。用一对真实存在的异臂夹具来断言，而不是 `|| true`。
ok('换会话标签会改变分配（不是常量函数）', experimentArmOf(keyOf(CONTROL_FIXTURE)) !== experimentArmOf(keyOf(TREATMENT_FIXTURE)))
// 值域
const armSamples = []
for (let i = 0; i < 500; i += 1) armSamples.push(experimentArmOf(keyOf('sample-session-' + i)))
ok('分臂值域只有 treatment/control', armSamples.every((a) => a === 'treatment' || a === 'control'))
const controlShare = armSamples.filter((a) => a === 'control').length / armSamples.length
ok('分臂接近 50/50（实测 ' + (controlShare * 100).toFixed(1) + '%）', controlShare > 0.42 && controlShare < 0.58, String(controlShare))
// 会话臂不随回合变化：现在函数根本不接受 turn，所以两次调用（模拟两个回合）必然同臂。
ok('同一会话的臂不随回合变化', experimentArmOf(keyOf(TREATMENT_FIXTURE)) === experimentArmOf(keyOf(TREATMENT_FIXTURE)))

// ── 1) HIGH 时：注入与否由**会话臂**决定，且提示只在 treatment 出现 ─────────────
const agentT = agentFor(TREATMENT_FIXTURE)
const agentC = agentFor(CONTROL_FIXTURE)
const base = enter(highTask)
const injected = await preStep({ agent: agentT, messages: base.messages, turn: 11, step: 1, signal: undefined }, base)
ok('treatment 会话的决策被替换（messages 多了一条）', injected !== base && Array.isArray(injected.messages) && injected.messages.length === base.messages.length + 1, JSON.stringify(injected.messages.length))
const controlTurn = enter(highTask)
const controlOut = await preStep({ agent: agentC, messages: controlTurn.messages, turn: 11, step: 1, signal: undefined }, controlTurn)
ok('control 会话的决策原样返回（**这是真正的对照组**）', controlOut === controlTurn, 'messages=' + controlOut.messages.length)
const hint = injected.messages[injected.messages.length - 1]
ok('注入的是 user 角色消息', hint !== undefined && hint.role === 'user', JSON.stringify(hint && hint.role))
ok('content 是 [{type:"text", text}] 形状', Array.isArray(hint.content) && hint.content[0] && hint.content[0].type === 'text' && typeof hint.content[0].text === 'string')
ok('带唯一 id（不是 undefined，也不是固定值）', typeof hint.id === 'string' && hint.id.length >= 8, JSON.stringify(hint.id))
ok('source 标了自己的来源', hint.source !== undefined && hint.source.kind === 'skill-router', JSON.stringify(hint.source))
ok('原文消息未被改动（只在末尾追加）', injected.messages[0] === base.messages[0])
const hintText = String(hint.content[0].text)
ok('提示里含候选名与"可以都不用"的许可', hintText.includes('semgrep') && /ignore this/i.test(hintText), hintText.slice(0, 90))

// 提示必须说清"这技能是干什么的"，而不是复述"命中了哪些字段"。
//
// 这条断言来自一次实测的事故：渲染 `c.fields` 让 467 个候选里的 304 个都显示成
// `(name, description, path)` —— 字段**名**代替了字段**内容**，于是五行提示的信息量是零。
// 模型看到五个陌生名字、没有任何用途说明，行为是原样继续 read/edit/pwsh；遥测侧 14 次注入
// 对应 0 次库加载。判据因此是"描述文本本身在提示里"，而不是"提示非空"。
// 只断言**实际出现的那个候选**。第一版同时断言了夹具里两个技能的描述，直接红了——那个任务是
// `semgrep security audit`，只有 semgrep 是候选（`Evidence before claims` 属于另一个技能，从来
// 不在这一行提示里）。断言写了"提示应当包含不存在的东西"，那个红是夹具错了，不是代码错了。
ok('提示里是候选的真实描述（不是命中字段名）', hintText.includes('semgrep ' + String.fromCharCode(0x2014) + ' Static analysis security review for source code'), hintText.slice(0, 160))
ok('不再出现字段名占位符 (name, description, path)', hintText.includes('(name, description, path)') === false && /\(name\b|whenToUse/.test(hintText) === false, hintText.slice(0, 160))
ok('名与描述之间是可见分隔符（不是靠括号）', hintText.includes('semgrep ' + String.fromCharCode(0x2014) + ' '), hintText.slice(0, 90))

// 两次注入的 id 必须不同（同一个 id 会让下游无法区分）
const again = await preStep({ agent, messages: enter(highTask).messages, turn: 12, step: 1, signal: undefined }, enter(highTask))
const second = again.messages[again.messages.length - 1]
ok('两次注入的 id 不同', second.id !== hint.id, hint.id + ' vs ' + second.id)

// ── 2) step !== 1 不注入（一个回合只提示一次）──────────────────────────────────
const stepTwo = enter(highTask)
const atStep2 = await preStep({ agent, messages: stepTwo.messages, turn: 12, step: 2, signal: undefined }, stepTwo)
ok('step=2 不注入', atStep2 === stepTwo, 'messages=' + atStep2.messages.length)

// ── 3) 非 HIGH 不注入 ──────────────────────────────────────────────────────────
// 中文任务 → no-searchable-token → tier NONE（这也正是实测里 24.4% 的那一类）
const zh = enter('帮我做一次安全审计')
const zhOut = await preStep({ agent, messages: zh.messages, turn: 13, step: 1, signal: undefined }, zh)
ok('tier NONE（中文无 token）不注入', zhOut === zh, 'messages=' + zhOut.messages.length)

// ── 4) 遥测如实记录 injected 与实测 hint 字节数 ────────────────────────────────
const lines = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const turn11 = lines().find((r) => r.turn === 11 && r.kind === undefined)
ok('记录标 injected: true', turn11 !== undefined && turn11.injected === true, JSON.stringify(turn11 && turn11.injected))
ok('hintBytes 是实测的正数，且与真实提示长度一致', turn11 !== undefined && turn11.hintBytes === Buffer.byteLength(hintText, 'utf8'), JSON.stringify({ recorded: turn11 && turn11.hintBytes, actual: Buffer.byteLength(hintText, 'utf8') }))
const turn13 = lines().find((r) => r.turn === 13)
ok('未注入的记录 hintBytes 为 0', turn13 !== undefined && turn13.hintBytes === 0 && turn13.injected === false, JSON.stringify(turn13 && { i: turn13.injected, b: turn13.hintBytes }))
ok('记录里仍然没有用户原文', lines().every((r) => JSON.stringify(r).includes('security audit on') === false))
// 会话创建时间必须**归一化成 ISO**：日志里混数字与 ISO 就无法和 --since 比较（1789… 与 "2026-…" 不可比）。
ok('sessionCreatedAt 以 ISO 落盘（不是 epoch 数字）', turn11 !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(String(turn11.sessionCreatedAt)), JSON.stringify(turn11 && turn11.sessionCreatedAt))
ok('sessionCreatedAt 等于夹具的毫秒时间', turn11 !== undefined && turn11.sessionCreatedAt === new Date(1789000000000).toISOString(), JSON.stringify(turn11 && turn11.sessionCreatedAt))
// 拿不到创建时间时必须是 null（可见），而不是伪造一个时间
{
  const noBirth = agentFor('session-no-birth', { cwd: workspace })
  const t9 = enter(highTask)
  await preStep({ agent: noBirth, messages: t9.messages, turn: 90, step: 1, signal: undefined }, t9)
  const rec = lines().find((r) => r.turn === 90 && r.kind === undefined)
  ok('创建时间拿不到时记 null（不伪造）', rec !== undefined && rec.sessionCreatedAt === null, JSON.stringify(rec && rec.sessionCreatedAt))
}

// ── 5) 每回合工具调用计数：`turn/end` 到达时就结算 ─────────────────────────────
// 时序与真机一致：**回合内先发生调用，回合结束时 `turn/end` 结算**。
// 旧版在**下一个回合的 step 1** 结算，代价是每个会话的最后一个回合永远没有记录——而首观测通常
// 就在那一回合。这里先回到第 12 回合的上下文（注入那一次），投递这一回合的调用，再投 `turn/end`。
const turn12 = enter(highTask)
await preStep({ agent, messages: turn12.messages, turn: 12, step: 1, signal: undefined }, turn12)
toolCall('skill_search', agent.session)
toolCall('skill_load', agent.session)
toolCall('skill', agent.session)
toolCall('read', agent.session)
toolCall('bash', agent.session)
toolCall('glob', agent.session)
const beforeEnd = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).length
turnEnd(agent.session)
const calls12 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).pop()
ok('回合结束时写出 turn-calls 记录（不必等下一个回合）', calls12 !== undefined && lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).length === beforeEnd + 1, JSON.stringify(lines().filter((r) => r.kind === 'turn-calls')))
ok('三个技能工具分别计数', calls12 !== undefined && calls12.skillSearchCalls === 1 && calls12.skillLoadCalls === 1 && calls12.skillRefCalls === 0, JSON.stringify(calls12))
ok('原生 skill 工具单独计数（常驻目录 ≠ 库）', calls12 !== undefined && calls12.residentSkillCalls === 1, JSON.stringify(calls12 && calls12.residentSkillCalls))
ok('其它工具汇总，不逐个记名', calls12 !== undefined && calls12.otherToolCalls === 3, JSON.stringify(calls12 && calls12.otherToolCalls))
// 分臂现在是**按会话**的，所以这里不能断言 injected 一定为 true——要看该会话被分到哪一臂。
ok('turn-calls 记录带 tier、arm 与 injected，便于对齐实验臂', calls12 !== undefined && calls12.tier === 'HIGH' && ['treatment', 'control'].includes(String(calls12.arm)) && calls12.injected === (calls12.arm === 'treatment'), JSON.stringify(calls12 && { t: calls12.tier, a: calls12.arm, i: calls12.injected }))
ok('turn-calls 记录里没有工具参数、没有技能正文', calls12 !== undefined && JSON.stringify(calls12).includes('arguments') === false, JSON.stringify(calls12))

// ── 6) 结算过的回合不会被兜底重复写出，且计数按回合归零 ────────────────────────
const settled12 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).length
const turn14 = enter(highTask)
await preStep({ agent, messages: turn14.messages, turn: 14, step: 1, signal: undefined }, turn14)
ok('已结算的回合不会被下一回合的兜底重复写出', lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).length === settled12, JSON.stringify(lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).map((r) => ({ s: r.skillSearchCalls, o: r.otherToolCalls }))))
toolCall('skill_search', agent.session)
turnEnd(agent.session)
const calls14 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 14).pop()
ok('第 14 回合只记它自己的 1 次搜索', calls14 !== undefined && calls14.skillSearchCalls === 1 && calls14.skillLoadCalls === 0, JSON.stringify(calls14))

// ── 6b) 兜底仍在：`turn/end` 万一没到，下一个回合的 step 1 仍然结算 ─────────────
const turn15 = enter(highTask)
await preStep({ agent, messages: turn15.messages, turn: 15, step: 1, signal: undefined }, turn15)
toolCall('skill_load', agent.session)
const turn16 = enter(highTask)
await preStep({ agent, messages: turn16.messages, turn: 16, step: 1, signal: undefined }, turn16)
const calls15 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 15).pop()
ok('`turn/end` 缺失时由下一回合结算（兜底没被删掉）', calls15 !== undefined && calls15.skillLoadCalls === 1, JSON.stringify(calls15))

// ── 6c) 会话的**最后一个**回合也有记录（这一条是回归测试）──────────────────────
// 旧版只在下一回合结算，于是"走完一个回合就结束"的会话——子代理、被关掉的窗口、真机上最常见的
// 一次问答——永远没有记录；而主指标的分母正是每个会话的**首个** eligible 回合。
{
  const last = agentFor('session-last-turn')
  const task = enter(highTask)
  await preStep({ agent: last, messages: task.messages, turn: 20, step: 1, signal: undefined }, task)
  toolCall('skill_search', last.session)
  turnEnd(last.session)
  const rec = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 20).pop()
  ok('会话最后一个回合也有 turn-calls 记录（旧版这条会红）', rec !== undefined && rec.skillSearchCalls === 1, JSON.stringify(rec))
}

// ── 6d) 会话被销毁时，未结算的回合也会写出（不丢）──────────────────────────────
{
  const going = agentFor('session-disposed')
  const task = enter(highTask)
  await preStep({ agent: going, messages: task.messages, turn: 30, step: 1, signal: undefined }, task)
  toolCall('skill_load', going.session)
  dispose(going.session)
  const rec = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 30).pop()
  ok('会话销毁时把在测回合结算掉', rec !== undefined && rec.skillLoadCalls === 1, JSON.stringify(rec))
}

// ── 6e) 没有在测回合时，结算事件不写出空记录 ────────────────────────────────────
// 否则每个回合结束都会多出一行 0 计数，"没有记录"与"确实 0 次"的区分就被自己毁掉了。
{
  const idle = agentFor('session-never-measured')
  const before = lines().filter((r) => r.kind === 'turn-calls').length
  turnEnd(idle.session)
  turnEnd(idle.session)
  dispose(idle.session)
  const after = lines().filter((r) => r.kind === 'turn-calls').length
  ok('没有在测回合时结算不产生空记录', after === before, 'before=' + before + ' after=' + after)
}

// ── 7) 会话隔离：两个会话的同号回合既不混计数，也不被当成同一条记录 ─────────────
//
// 这条修复来自一次实测缺陷：计数状态曾是模块级的、遥测里也没有会话标识，于是两个会话各自的
// turn 12 是同一条记录（实测 14 个 turn 号被重复），并发会话还会互相污染计数。两个后果都足以让
// "注入是否改变行为"算反。
{
  const A = agentFor('session-A')
  const B = agentFor('session-B')
  // 两个会话都走到 turn 40（同号），各投递不同的调用；B 的调用故意插在 A 的两次调用之间，
  // 用来验证并发会话之间不会互相污染计数。
  const taskA = enter(highTask)
  await preStep({ agent: A, messages: taskA.messages, turn: 40, step: 1, signal: undefined }, taskA)
  const taskB = enter(highTask)
  await preStep({ agent: B, messages: taskB.messages, turn: 40, step: 1, signal: undefined }, taskB)

  toolCall('skill_search', A.session)
  toolCall('skill_load', B.session)
  toolCall('skill_search', A.session)

  // 各自在自己的回合结束时结算
  turnEnd(A.session)
  turnEnd(B.session)
  const turn40 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 40 && r.tier !== undefined)
  const a40 = turn40.find((r) => r.sessionKey !== null && r.skillSearchCalls === 2)
  const b40 = turn40.find((r) => r.sessionKey !== null && r.skillLoadCalls === 1)
  ok('两个会话的同号回合各自结算，且计数不混', a40 !== undefined && b40 !== undefined && a40.sessionKey !== b40.sessionKey, JSON.stringify(turn40.map((r) => ({ k: r.sessionKey, s: r.skillSearchCalls, l: r.skillLoadCalls }))))
  ok('A 的搜索没有被记到 B 上', a40 !== undefined && a40.skillLoadCalls === 0 && b40 !== undefined && b40.skillSearchCalls === 0)

  // 会话标签是稳定哈希前缀：不出现在日志里的不是会话 id 本身，且同一会话反复出现时一致
  ok('sessionKey 是短哈希而不是会话 id 本身', a40 !== undefined && /^[0-9a-f]{8}$/.test(String(a40.sessionKey)) && String(a40.sessionKey).includes('session-A') === false, JSON.stringify(a40 && a40.sessionKey))
  ok('同一会话的标签稳定', a40 !== undefined && b40 !== undefined && a40.sessionKey !== b40.sessionKey)
}

// ── 8) reject 决策原样返回（不注入、不计数）──────────────────────────────────
const reject = { kind: 'reject' }
ok('reject 原样返回', (await preStep({ agent, messages: [], turn: 16, step: 1, signal: undefined }, reject)) === reject)

rmSync(workspace, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n发现层（HIGH 注入 + 回合计数）: OK' : '\n发现层（HIGH 注入 + 回合计数） FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
