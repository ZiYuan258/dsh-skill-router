// Client half 的测试。
//
// Client 半在浏览器里跑,由 client-modules 打包成一个拼接的经典脚本,每个文件必须通过
// `window.__ModuleLoader__.load({ id, factory })` 注册自己。Node 里没有 React、没有 DOM、
// 也没有 Cordis ctx,所以用 node:vm 给它一套桩环境,然后:
//   1. 确认它作为经典脚本可编译、并把自己注册进 __ModuleLoader__ 队列;
//   2. 按 create() 的方式 materialize factory(require 提供 React 桩),校验插件形状;
//   3. **真的渲染一次**,用夹具数据断言输出里的中文名与英文原名。
//
// 第 3 步是关键:只做静态检查的话,一个把字段名写错的组件照样通过。
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

  // --- 3. render it against fixture nodes ------------------------------------------
  const flat = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flat).join('')
    if (typeof node === 'object' && Array.isArray(node.children)) return flat(node.children)
    return ''
  }

  const nodes = [
    { kind: 'assistant', seq: 1, blocks: [{ kind: 'reasoning', text: 'thinking' }, { kind: 'tool-call', name: 'skill_load', arguments: { name: 'verification-before-completion' } }] },
    { kind: 'tool-result', seq: 2, call: { name: 'skill_load', argsRaw: '{"name":"verification-before-completion"}' }, content: [] },
    { kind: 'assistant', seq: 3, blocks: [{ kind: 'tool-call', name: 'skill', arguments: { name: 'writing-plans' } }, { kind: 'tool-call', name: 'skill_search', arguments: { query: 'x' } }] },
    { kind: 'user', seq: 4 },
  ]
  const useChat = (selector) => selector({ legacy: { nodes } })
  const tree = reg.Component({ useChat, sessionId: 's1', useProjection: () => null })
  const text = flat(tree)

  check('the view renders the loaded skills', text.includes('verification-before-completion') && text.includes('writing-plans'), text.slice(0, 160))
  check('it shows the Chinese name for each skill', text.includes('验证·前置·完成') && text.includes('写作·规划'), text.slice(0, 200))
  check('it counts two loads and two distinct skills', text.includes('共 2 次') && text.includes('2 个技能'), text.slice(0, 200))
  check('skill_search is not counted', text.includes('skill_search') === false)
  check('the tool-result node is not double counted', (text.match(/verification-before-completion/g) || []).length === 1, 'occurrences=' + (text.match(/verification-before-completion/g) || []).length)
  check('it states that only display is translated', text.includes('仅用于显示'), text.slice(0, 200))

  // A session with no skill loads must say so rather than render an empty list.
  const emptyTree = flat(reg.Component({ useChat: () => ({ legacy: { nodes: [{ kind: 'user', seq: 1 }] } }) }))
  check('an empty session says so in Chinese', emptyTree.includes('尚未加载任何技能'), emptyTree.slice(0, 120))

  // A missing seat must degrade, not throw.
  let threw
  try {
    const noSeat = flat(reg.Component({}))
    check('a missing useChat seat degrades with an explanation', noSeat.includes('useChat'), noSeat.slice(0, 120))
  } catch (error) {
    threw = error
  }
  check('a missing useChat seat does not throw', threw === undefined, threw === undefined ? undefined : String(threw))
}

console.log(problems.length === 0 ? 'client half: OK' : 'client half FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1