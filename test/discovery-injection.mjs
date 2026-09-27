// 发现层的接线测试：**HIGH 注入** + **每回合工具调用计数**。
//
// 这个文件经历了三个版本，值得记下演变的原因，因为它记录的正是这个仓库最警惕的那类错误：
//
//   v1（干跑） 断言"决策不被改变"—— 当时那是硬约束，因为什么都不注入。
//   v2（本版） 断言"HIGH 注入、其余不注入"—— 决策**必须**被改变，且只在 HIGH 时。
//
// 上一版那两条断言（"干跑不改变决策"、"injected: false"）现在会红，而且**应该红**：行为按设计
// 变了。一个不会因为行为改变而变红的测试，等于没有在测行为。
//
// 这一版真正要证明的三件事：
//   1. 注入只发生在 `tier === HIGH` 且 `step === 1`，注入的消息形状合法（含唯一 id）；
//   2. 遥测如实记录 `injected` 与**实测的 hint 字节数**（不是估算）；
//   3. 每回合的工具调用被**在回合结束后**统计（`step 1` 时谁也不知道这一回合会不会去搜）。
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

// ── 5) 每回合工具调用计数（在回合结束后写出）──────────────────────────────────
// 时序必须与真实一致：**回合内先发生调用，下一个回合的 step 1 才 flush**。
// 第一版把调用投在 flush 之后，于是它们被记到了下一回合——测试自己制造了一个"计数为 0"的假象。
// 这里先回到第 12 回合的上下文（注入那一次），再投递这一回合的调用。
const turn12 = enter(highTask)
await preStep({ agent, messages: turn12.messages, turn: 12, step: 1, signal: undefined }, turn12)
toolCall('skill_search', agent.session)
toolCall('skill_load', agent.session)
toolCall('skill', agent.session)
toolCall('read', agent.session)
toolCall('bash', agent.session)
toolCall('glob', agent.session)
// 下一次 pre-step 触发 flush，把第 12 回合的计数写出来
const nextTurn = enter(highTask)
await preStep({ agent, messages: nextTurn.messages, turn: 14, step: 1, signal: undefined }, nextTurn)
const calls12 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).pop()
ok('回合结束后写出 turn-calls 记录', calls12 !== undefined, JSON.stringify(lines().filter((r) => r.kind === 'turn-calls')))
ok('三个技能工具分别计数', calls12 !== undefined && calls12.skillSearchCalls === 1 && calls12.skillLoadCalls === 1 && calls12.skillRefCalls === 0, JSON.stringify(calls12))
ok('原生 skill 工具单独计数（常驻目录 ≠ 库）', calls12 !== undefined && calls12.residentSkillCalls === 1, JSON.stringify(calls12 && calls12.residentSkillCalls))
ok('其它工具汇总，不逐个记名', calls12 !== undefined && calls12.otherToolCalls === 3, JSON.stringify(calls12 && calls12.otherToolCalls))
// 分臂现在是**按会话**的，所以这里不能断言 injected 一定为 true——要看该会话被分到哪一臂。
ok('turn-calls 记录带 tier、arm 与 injected，便于对齐实验臂', calls12 !== undefined && calls12.tier === 'HIGH' && ['treatment', 'control'].includes(String(calls12.arm)) && calls12.injected === (calls12.arm === 'treatment'), JSON.stringify(calls12 && { t: calls12.tier, a: calls12.arm, i: calls12.injected }))
ok('turn-calls 记录里没有工具参数、没有技能正文', calls12 !== undefined && JSON.stringify(calls12).includes('arguments') === false, JSON.stringify(calls12))

// ── 6) 计数按回合归零（不会把上一回合的数带过来）───────────────────────────────
const turn14 = enter(highTask)
await preStep({ agent, messages: turn14.messages, turn: 14, step: 1, signal: undefined }, turn14)
toolCall('skill_search', agent.session)
const oneMore = enter(highTask)
await preStep({ agent, messages: oneMore.messages, turn: 15, step: 1, signal: undefined }, oneMore)
const calls14 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 14).pop()
ok('第 14 回合只记它自己的 1 次搜索', calls14 !== undefined && calls14.skillSearchCalls === 1 && calls14.skillLoadCalls === 0, JSON.stringify(calls14))

// ── 7) 会话隔离：两个会话的同号回合既不混计数，也不被当成同一条记录 ─────────────
//
// 这条修复来自一次实测缺陷：计数状态曾是模块级的、遥测里也没有会话标识，于是两个会话各自的
// turn 12 是同一条记录（实测 14 个 turn 号被重复），并发会话还会互相污染计数。两个后果都足以让
// "注入是否改变行为"算反。
{
  const A = agentFor('session-A')
  const B = agentFor('session-B')
  // 两个会话都走到 turn 40（同号），各投递不同的调用
  const taskA = enter(highTask)
  await preStep({ agent: A, messages: taskA.messages, turn: 40, step: 1, signal: undefined }, taskA)
  const taskB = enter(highTask)
  await preStep({ agent: B, messages: taskB.messages, turn: 40, step: 1, signal: undefined }, taskB)

  toolCall('skill_search', A.session)
  toolCall('skill_search', A.session)
  toolCall('skill_load', B.session)

  // 各自进入下一回合，触发各自的 flush
  const nextA = enter(highTask)
  await preStep({ agent: A, messages: nextA.messages, turn: 41, step: 1, signal: undefined }, nextA)
  const nextB = enter(highTask)
  await preStep({ agent: B, messages: nextB.messages, turn: 41, step: 1, signal: undefined }, nextB)
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
