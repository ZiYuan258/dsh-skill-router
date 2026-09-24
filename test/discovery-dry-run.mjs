// Discovery 的干跑测试。
//
// 这里测的不是"函数返回值对不对"，而是**插到宿主里会不会跑起来**——前几轮已经把教训写在这个仓库
// 里了（19 个绿测试陪着一个不存在的标签页）。所以这个文件真的调用 `apply(ctx)`，用桩 ctx 提供
// `fs` / `tools` / `on`，然后**像 agent-loop 那样**触发 `agent/pre-step`，看它写了什么到日志。
//
// 三条断言是这个阶段的全部意义：
//   1. 它真的写了遥测（否则干跑什么都没测到）；
//   2. 它**不改变决策**（干跑不改行为，这是本阶段的硬约束）；
//   3. 它**不写用户原文**（一个观察功能不该制造新的会话数据存储）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

const problems = []
const ok = (label, passed, detail) => {
  console.log('  ' + (passed ? 'ok  ' : 'FAIL') + ' ' + label + (passed || detail === undefined ? '' : ' — ' + detail))
  if (!passed) problems.push(label)
}

// ── 一个装好索引的夹具库 ────────────────────────────────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'skill-router-dryrun-'))
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

/** A ctx just rich enough for `apply`: fs for the library, tools for registration, on for events. */
function makeCtx(workspaceDir) {
  const handlers = new Map()
  const registered = []
  let effectCount = 0
  const ctx = {
    fs: {
      // 与真实 ctx.fs 的契约一致（照抄 test/helpers.mjs 的桩）：resolve 返回
      // { targetKey, displayPath }，stat 收 target 并给出 { version, type }。
      // 第一版这里返回了字符串路径，于是 resolveRoot 读 target.displayPath 时抛
      // "Cannot read properties of undefined (reading 'slice')" —— 又是桩比现实简单。
      async resolve(path) {
        const abs = resolvePath(String(path))
        return { targetKey: abs, displayPath: abs }
      },
      async stat(target) {
        const info = statSync(target.targetKey)
        return { version: String(info.mtimeMs), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      },
      async readText(target) {
        return readFileSync(target.targetKey, 'utf8')
      },
      async listDir(target) {
        return readdirSync(target.targetKey).map((name) => ({ name }))
      },
    },
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    get: (name) => (name === 'skills' ? undefined : undefined),
    effect(fn) {
      effectCount += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      if (handlers.has(event) === false) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    logger: { warn() {}, info() {} },
    _workspace: workspaceDir,
    _handlers: handlers,
    _registered: registered,
    _effects: () => effectCount,
  }
  return ctx
}

/** Drive one pre-step exactly as the agent loop does: `(payload, next)` with a `next` decision. */
async function preStep(ctx, payload, decision) {
  const handlers = ctx._handlers.get('agent/pre-step') ?? []
  const next = async () => decision
  let result = decision
  for (const handler of handlers) result = await handler(payload, next)
  return result
}

globalThis.__dshSkillRouterDiscoveryErrors = []

console.log('发现层干跑:')

const ctx = makeCtx(workspace)
mod.apply(ctx)
ok('apply 注册了三个工具（原有行为未受影响）', ctx._registered.length === 3, 'tools=' + ctx._registered.map((t) => t.name).join(','))
ok('apply 注册了 agent/pre-step 监听', (ctx._handlers.get('agent/pre-step') ?? []).length === 1)

const agent = { session: { header: { cwd: workspace } } }
const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'Run a semgrep security audit on this repo' }] }] }

const returned = await preStep(ctx, { agent, messages: decision.messages, turn: 3, step: 1, signal: undefined }, decision)
ok('干跑不改变决策（硬约束）', returned === decision, 'returned kind=' + String(returned && returned.kind))

const errs = globalThis.__dshSkillRouterDiscoveryErrors
ok('discover 未抛错（有错则列在下方）', errs.length === 0, errs.join(' | '))
ok('写了遥测行', existsSync(logPath), logPath)
const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l !== '') : []
ok('遥测恰好一行', lines.length === 1, 'lines=' + lines.length)
const record = lines.length > 0 ? JSON.parse(lines[0]) : {}
ok('记录含候选与分数', record.candidateCount >= 1 && record.candidates[0].name === 'semgrep', JSON.stringify(record.candidates))
ok('记录含 turn/step/耗时/索引行数', record.turn === 3 && record.step === 1 && typeof record.elapsedMs === 'number' && record.indexRows === 2, JSON.stringify({ turn: record.turn, step: record.step, elapsedMs: record.elapsedMs, indexRows: record.indexRows }))
ok('记录标为 injected:false（干跑）', record.injected === false)

// 最重要的一条：一个观察功能不该制造新的会话数据存储。
const rawLog = lines.join('\n')
for (const leak of ['semgrep security audit on this repo', 'Run a', 'security audit on']) {
  ok('遥测未写入用户原文片段 ' + JSON.stringify(leak.slice(0, 24)), rawLog.includes(leak) === false)
}
ok('遥测里没有 content 字段', rawLog.includes('"content"') === false && rawLog.includes('"messages"') === false)

// step !== 1 不重复记录：一个回合只测一次触发。
await preStep(ctx, { agent, messages: decision.messages, turn: 3, step: 2, signal: undefined }, decision)
const afterStep2 = readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l !== '')
ok('只在第一步记录（多步任务不重复）', afterStep2.length === 1, 'lines=' + afterStep2.length)

// 中文任务：应当记下 no-searchable-token，而不是伪装成"没有匹配"。
const zhDecision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我做一次安全审计' }] }] }
await preStep(ctx, { agent, messages: zhDecision.messages, turn: 4, step: 1, signal: undefined }, zhDecision)
const afterZh = readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l !== '')
const zhRecord = JSON.parse(afterZh[afterZh.length - 1])
ok('中文任务记录 no-searchable-token', zhRecord.reason === 'no-searchable-token' && zhRecord.candidateCount === 0, JSON.stringify({ reason: zhRecord.reason, n: zhRecord.candidateCount }))
ok('中文任务的原文也未写入', readFileSync(logPath, 'utf8').includes('安全审计') === false)

// 拒绝的决策不被触碰。
const reject = { kind: 'reject' }
const afterReject = await preStep(ctx, { agent, messages: decision.messages, turn: 5, step: 1, signal: undefined }, reject)
ok('reject 决策原样返回', afterReject === reject)

rmSync(workspace, { recursive: true, force: true })
console.log(problems.length === 0 ? '\n发现层干跑: OK' : '\n发现层干跑 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
