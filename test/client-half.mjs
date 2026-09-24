// Client half 的测试。
//
// Client 半在浏览器里跑,由 client-modules 打包成一个拼接的经典脚本,每个文件必须通过
// `window.__ModuleLoader__.load({ id, factory })` 注册自己。Node 里没有 React、没有 DOM、
// 也没有 Cordis ctx,所以用 node:vm 给它一套桩环境,然后:
//   1. 确认它作为经典脚本可编译、并把自己注册进 __ModuleLoader__ 队列;
//   2. 按 create() 的方式 materialize factory(require 提供 React 桩),校验插件形状;
//   3. 确认那些**已被实测证伪的数据契约**没有偷偷回来。
//
// 关于第 3 步:这个文件过去用夹具「真的渲染一次」,并因此断言过 useChat/legacy.nodes 的形状。
// 那些断言当时全绿,而标签页在真实会话里是空的——因为夹具编码的是一个**推断**出来的形状,
// 而不是实测到的形状,而 legacy.nodes 本身就已证明不是会话历史(实测 210 个节点、0 次工具
// 调用,同期账本里有 2778+ 条事件)。渲染行为现在由 test/usage-tab.mjs 用实测形状覆盖,这里
// 不再重复一遍假装的渲染,改为把作废契约钉死:它们回来就是回归。
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { fileURLToPath } from 'node:url'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

// --- 1. the file must be loadable in a browser, so: no Node builtins ------------------
//
// These scan CODE, with comments stripped. A Client half has every reason to quote a package
// name or an error message in its comments — this one quotes the boot-failure text that its
// own missing-registration seam produced — and a checker that flags documentation is a checker
// people silence by deleting the documentation.
//
// `require('react')` inside the factory is expected and normal — shipped Client halves such as
// dshmarket do the same. What must not appear is a Node builtin or the host half's packages.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

check('no @deepseek-ai/* reference in code', code.includes('@deepseek-ai/') === false)
check('no node: builtin reference in code', /node:[a-z/]+/.test(code) === false)
check('no process / Buffer use in code', /\b(process\.|Buffer\.)\b/.test(code) === false)

// --- 1b. the falsified contracts must not come back ----------------------------------
//
// Every one of these was measured wrong against a live session, and each wrong version looked
// entirely reasonable in review. Reintroducing one is a regression even if every render test
// still passes, because the failure mode is a plausible-looking list rather than a crash.
check('does not read useChat / legacy.nodes (a truncated UI projection, not the history)', /\.legacy\b|\buseChat\b/.test(code) === false, code.match(/[^\n]*(\.legacy\b|useChat)[^\n]*/)?.[0]?.trim().slice(0, 100))
check('does not collect per-turn tool declarations as usage', /toolDecl|declarations|requestHeaders/.test(code) === false)
check('reads the session ledger via sessions.binding', code.includes('sessions') && code.includes('binding('))
check('reads snapshot entries from eventSource', code.includes('eventSource') && code.includes('getSnapshot'))
check('keys records on callId', code.includes('callId'))
// Paging goes through the SESSION, never the source. `SessionEventSource` is
// `ObservableSnapshot<SessionEventWindow>` — declared surface: `getSnapshot()` and `subscribe()` —
// while `loadOlder(): Promise<void>` is on the session face. Calling it on the source made the
// paging effect exit at its guard on every render, and four "fixes" changed code that never ran.
check('pages through the session, not the source', /session\.loadOlder\(\)/.test(code) && /source\.loadOlder/.test(code) === false)
check('subscribes to the ledger', code.includes('subscribe'))

// --- 2. compile as a classic script, then materialize the registration ---------------
const styleTags = []
const registered = []
let effectCount = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
  },
}

const document = {
  createElement(tag) {
    return { tag, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, parentNode: null }
  },
  head: {
    appendChild(node) {
      node.parentNode = this
      if (node.tag === 'style') styleTags.push(node)
      return node
    },
  },
}

// --- 3. apply() must survive the document timings it can actually meet ---------------
//
// `apply()` runs the moment the bundle is evaluated, which is not necessarily when a
// document is ready. Verified the hard way: with `head: null` the unguarded version threw
// "Cannot read properties of null (reading 'appendChild')", and an exception inside apply()
// means the slot registration below it never runs — the tab simply would not exist, with no
// error the user could act on. A stylesheet is cosmetic; it must never be able to take the
// tab down. Each timing is re-run here so a future edit cannot quietly reintroduce it.
const timings = [
  ['a ready document (head present)', () => ({ createElement: mkEl, head: mkHost() })],
  ['head not created yet (null), documentElement present', () => ({ createElement: mkEl, head: null, documentElement: mkHost() })],
  ['head and documentElement absent, body present', () => ({ createElement: mkEl, head: null, documentElement: null, body: mkHost() })],
  ['no document at all', () => undefined],
]

function mkEl(tag) {
  return { tag, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, parentNode: null }
}
function mkHost() {
  return { children: [], appendChild(node) { node.parentNode = this; this.children.push(node); return node } }
}

for (const [label, make] of timings) {
  const registrationSeen = []
  const localRegistered = []
  const doc = make()
  const sandbox2 = {
    window: { __ModuleLoader__: { load: (spec) => registrationSeen.push(spec) } },
    console,
  }
  if (doc !== undefined) sandbox2.document = doc
  sandbox2.globalThis = sandbox2
  let error
  try {
    new Script(source).runInContext(createContext(sandbox2))
    const localPlugin = registrationSeen[0].factory(() => React)
    const localSlots = {
      inject: (key, cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      register: (options, Component) => { localRegistered.push({ options, Component }); return () => {} },
    }
    localPlugin.apply({ get: (n) => (n === 'slots' ? localSlots : undefined), effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} } })
  } catch (caught) {
    error = caught
  }
  check('apply() survives ' + label, error === undefined, error === undefined ? undefined : String(error).slice(0, 90))
  check('the tab still registers with ' + label, localRegistered.length === 1, 'registrations=' + localRegistered.length)
}

const slots = {
  inject(key, callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  register(options, Component) {
    registered.push({ options, Component })
    return () => {}
  },
}

const ctx = {
  get(name) {
    if (name === 'slots') return slots
    return undefined
  },
  effect(callback) {
    effectCount += 1
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

// Compile it the way the browser does: as a CLASSIC SCRIPT, not as a function body.
//
// This is the check that matters, and whose absence caused a boot failure. The browser loads
// every Client half as one concatenated classic script, where a bare top-level `return` is a
// SyntaxError — and a single one takes the whole bundle, and therefore every other client
// half, down with it. An earlier version of this test wrapped the source in
// `(function () { … })()`, which makes a top-level `return` legal and so validated a seam
// that does not exist.
//
// The classic script must also REGISTER itself: without a `__ModuleLoader__.load` call the
// bundle runs but no client half rings up — a boot failure that has no SyntaxError, exactly
// the "loaded without registering <id>" report. So the stub queue captures the registration,
// and the test materializes it the way create() does.
const registrations = []
const windowStub = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

let compileError
try {
  const sandbox = { window: windowStub, React, document, ctx, console, JSON, Set, Array, Object, String, Number, RegExp, Date, Math }
  sandbox.globalThis = sandbox
  new Script(source).runInContext(createContext(sandbox))
} catch (error) {
  compileError = error
}
check('compiles as a classic script (a top-level return fails here)', compileError === undefined, compileError === undefined ? undefined : String(compileError))

// A belt-and-braces scan, so a failure names the offending line rather than only "SyntaxError".
const topLevelReturns = source
  .split('\n')
  .map((line, index) => ({ line, index: index + 1 }))
  .filter((entry) => /^return\b/.test(entry.line))
check('no unindented top-level return statement', topLevelReturns.length === 0, topLevelReturns.map((e) => 'line ' + e.index).join(', '))

check('the script registers itself via __ModuleLoader__.load', registrations.length === 1, 'registrations=' + registrations.length)
const registration = registrations[0]
check('it registers under the plugin id', registration !== undefined && registration.id === 'dsh-skill-router', registration === undefined ? '' : String(registration.id))

let plugin
let factoryError
try {
  plugin = registration.factory(() => React)
} catch (error) {
  factoryError = error
}
check('the factory materializes without throwing', factoryError === undefined, factoryError === undefined ? undefined : String(factoryError))
check('the factory returns a plugin with apply()', plugin !== null && typeof plugin === 'object' && typeof plugin.apply === 'function')

// The Client runner activates services PER PLUGIN, from that plugin's own `inject` list.
// Without `slots` declared, `ctx.get('slots')` returns undefined at runtime, apply() returns
// early, and nothing is registered — the tab simply never appears, with no error anywhere.
// This assertion is the point: the harness below hands `slots` to ctx unconditionally, so a
// plugin that forgot to declare it would otherwise pass every other check in this file.
//
// `sessions` is deliberately NOT declared: the ledger does not come from a service lookup but
// from the registration's own `inject`, which the session-scoped slot calls with the scope's
// session id. That declaration is asserted below instead, because a registration without it
// renders an empty tab forever.
const declaresSlots = plugin !== null && typeof plugin === 'object' && Array.isArray(plugin.inject) && plugin.inject.includes('slots')
check('the plugin declares inject: ["slots"]', declaresSlots, JSON.stringify(plugin === null || typeof plugin !== 'object' ? null : plugin.inject))

if (plugin !== null && typeof plugin === 'object' && typeof plugin.apply === 'function') {
  plugin.apply(ctx)

  check('a stylesheet is inserted into document.head', styleTags.length === 1, 'tags=' + styleTags.length)
  check('the stylesheet is tagged for removal', styleTags[0] !== undefined && styleTags[0].attrs['data-dsh-skill-router'] === 'usage-tab')
  check('the plugin takes at least two effects (styles + tab)', effectCount >= 2, 'effects=' + effectCount)

  check('exactly one slot registration happens', registered.length === 1, 'registrations=' + registered.length)
  const reg = registered[0]
  check('it registers into conversation.view', reg !== undefined && reg.options.name === 'conversation.view', JSON.stringify(reg === undefined ? null : reg.options))
  check('its slot id is namespaced', reg !== undefined && reg.options.id === 'skill-router-usage', reg === undefined ? '' : String(reg.options.id))
  check('its tab label is Chinese', reg !== undefined && reg.options.label === '技能', reg === undefined ? '' : String(reg.options.label))
  check('it registers a component', reg !== undefined && typeof reg.Component === 'function')
  // The ledger reaches the component only through this: `conversation.view` is a session-scoped
  // slot, and its registration is where the scope's session id is turned into that session's
  // eventSource. Without `inject` the tab renders, says "no ledger", and never recovers.
  check('the registration declares inject (that is where the session ledger arrives)', reg !== undefined && typeof reg.options.inject === 'function', reg === undefined ? '' : typeof reg.options.inject)
  // The tab is a singleton while sessions are not: the outer component must be the keyed
  // wrapper, or a session switch keeps rendering the previous session's ledger.
  check('it registers the keyed wrapper, not the bare view', reg !== undefined && reg.Component.name === 'KeyedUsageView', reg === undefined ? '' : String(reg.Component.name))
}

console.log(problems.length === 0 ? 'client half: OK' : 'client half FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1