// Client half 的测试。
//
// Client 半在浏览器里跑，Node 里没有 React、没有 DOM、也没有 Cordis ctx。但它的顶层是
// 一个函数体，所以可以用 node:vm 给它一套桩环境，然后：
//   1. 确认它导出的插件形状正确（有 apply，且不依赖 Node 内建、不 import DSH 包）；
//   2. 捕获它注册到 conversation.view 的组件；
//   3. **真的渲染一次**，用夹具数据断言输出里的中文名与英文原名。
//
// 第 3 步是关键：只做静态检查的话，一个把字段名写错的组件照样通过。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

// --- 1. the file must be loadable in a browser, so: no imports, no Node builtins -------
check('no import/require of any package', /^\s*(import|const\s+\w+\s*=\s*require\()/m.test(source) === false)
check('no @deepseek-ai/* reference', source.includes('@deepseek-ai/') === false)
check('no node: builtin reference', /node:[a-z/]+/.test(source) === false)
check('no fs / process / Buffer use', /\b(require|process\.|Buffer\.)\b/.test(source) === false)

// --- 2. evaluate the body with a stubbed browser + cordis ----------------------------
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

const sandbox = { React, document, ctx, console, JSON, Set, Array, Object, String, Number, RegExp, Date, Math }
sandbox.globalThis = sandbox
// The module loader's factory supplies CommonJS bindings; the Client half assigns through
// them, so the sandbox must provide them or the plugin never reaches the runner.
sandbox.module = { exports: {} }

// The Client entry is a plugin *body* — it ends with `return { … }` — so it is evaluated
// the way DSH evaluates it: wrapped in a function and called.
const captured = runInContext('(function () {\n' + source + '\n})()', createContext(sandbox))

check('the body returns a plugin object', captured !== null && typeof captured === 'object')
check('the plugin exposes apply()', captured !== null && typeof captured.apply === 'function')
check('the plugin is also assigned to module.exports', sandbox.module.exports === captured, 'exports=' + Object.keys(sandbox.module.exports || {}).join(','))

if (captured !== null && typeof captured.apply === 'function') {
  captured.apply(ctx)

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
