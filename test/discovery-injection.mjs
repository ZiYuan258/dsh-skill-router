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

/** 向会话事件流投递一次 tool/call。 */
function toolCall(name) {
  const hs = ctx._handlers.get('session/event') ?? []
  for (const handler of hs) {
    const ev = { type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 0, step: 0, callId: 'c', name, arguments: {} } }
    handler({}, ev)
  }
}

const highTask = 'Run a semgrep security audit on this repo'
const agent = { session: { header: { cwd: workspace } } }
const enter = (text) => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })

console.log('发现层（HIGH 注入 + 回合计数）:')

ok('apply 注册了三个工具', ctx._registered.length === 3, String(ctx._registered.length))
ok('apply 注册了 agent/pre-step 与 session/event 监听', (ctx._handlers.get('agent/pre-step') ?? []).length === 1 && (ctx._handlers.get('session/event') ?? []).length === 1)

// ── 1) HIGH 注入 ───────────────────────────────────────────────────────────────
const base = enter(highTask)
const injected = await preStep({ agent, messages: base.messages, turn: 11, step: 1, signal: undefined }, base)
ok('HIGH 时决策被替换（messages 多了一条）', injected !== base && Array.isArray(injected.messages) && injected.messages.length === base.messages.length + 1, JSON.stringify(injected.messages.length))
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

// ── 5) 每回合工具调用计数（在回合结束后写出）──────────────────────────────────
// 时序必须与真实一致：**回合内先发生调用，下一个回合的 step 1 才 flush**。
// 第一版把调用投在 flush 之后，于是它们被记到了下一回合——测试自己制造了一个"计数为 0"的假象。
// 这里先回到第 12 回合的上下文（注入那一次），再投递这一回合的调用。
const turn12 = enter(highTask)
await preStep({ agent, messages: turn12.messages, turn: 12, step: 1, signal: undefined }, turn12)
toolCall('skill_search')
toolCall('skill_load')
toolCall('skill')
toolCall('read')
toolCall('bash')
toolCall('glob')
// 下一次 pre-step 触发 flush，把第 12 回合的计数写出来
const nextTurn = enter(highTask)
await preStep({ agent, messages: nextTurn.messages, turn: 14, step: 1, signal: undefined }, nextTurn)
const calls12 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 12).pop()
ok('回合结束后写出 turn-calls 记录', calls12 !== undefined, JSON.stringify(lines().filter((r) => r.kind === 'turn-calls')))
ok('三个技能工具分别计数', calls12 !== undefined && calls12.skillSearchCalls === 1 && calls12.skillLoadCalls === 1 && calls12.skillRefCalls === 0, JSON.stringify(calls12))
ok('原生 skill 工具单独计数（常驻目录 ≠ 库）', calls12 !== undefined && calls12.residentSkillCalls === 1, JSON.stringify(calls12 && calls12.residentSkillCalls))
ok('其它工具汇总，不逐个记名', calls12 !== undefined && calls12.otherToolCalls === 3, JSON.stringify(calls12 && calls12.otherToolCalls))
ok('turn-calls 记录带 tier 与 injected，便于 A/B 对齐', calls12 !== undefined && calls12.tier === 'HIGH' && calls12.injected === true, JSON.stringify(calls12 && { t: calls12.tier, i: calls12.injected }))
ok('turn-calls 记录里没有工具参数、没有技能正文', calls12 !== undefined && JSON.stringify(calls12).includes('arguments') === false, JSON.stringify(calls12))

// ── 6) 计数按回合归零（不会把上一回合的数带过来）───────────────────────────────
const turn14 = enter(highTask)
await preStep({ agent, messages: turn14.messages, turn: 14, step: 1, signal: undefined }, turn14)
toolCall('skill_search')
const oneMore = enter(highTask)
await preStep({ agent, messages: oneMore.messages, turn: 15, step: 1, signal: undefined }, oneMore)
const calls14 = lines().filter((r) => r.kind === 'turn-calls' && r.turn === 14).pop()
ok('第 14 回合只记它自己的 1 次搜索', calls14 !== undefined && calls14.skillSearchCalls === 1 && calls14.skillLoadCalls === 0, JSON.stringify(calls14))

// ── 7) reject 决策原样返回（不注入、不计数）──────────────────────────────────
const reject = { kind: 'reject' }
ok('reject 原样返回', (await preStep({ agent, messages: [], turn: 16, step: 1, signal: undefined }, reject)) === reject)

rmSync(workspace, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n发现层（HIGH 注入 + 回合计数）: OK' : '\n发现层（HIGH 注入 + 回合计数） FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
