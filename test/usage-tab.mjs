// 技能标签页「接线」的测试：注册契约、分页有界、订阅节流、完整性只在翻完后才报。
//
// 为什么账本测试不够：账本是纯函数，它再怎么错也只会算错数；而真正让这个标签页死掉的是
// 接线——历史上三次事故（顶层 return、裸 module.exports、无守卫的 document.head.appendChild）
// 全都是接线，当时十九个测试全绿，标签页却根本不存在。
//
// 取组件的方式**就是浏览器取它的方式**：插桩 __ModuleLoader__ → 物化 factory → 桩 ctx 调
// apply → 执行 ctx.effect 登记的闭包 → 拿到 slots.register 收到的组件与注册项。
//
// 而"这个组件从哪拿到会话"这件事，照抄 slot 系统的真实契约：`conversation.view` 声明为
// `scope: "session"`，渲染器会用作用域绑定的 key 调用注册项的 `inject(sessionId)`，再把返回值
// 展开到组件 props 上。所以测试走的也是 inject，而不是自己往 props 里塞数据——第一版测试正是
// 自己塞的，于是它验证的是一个不存在的座位（真实渲染器只传 viewRequest/openView/completeViewRequest）。
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { fileURLToPath } from 'node:url'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

// ── React 替身 ──────────────────────────────────────────────────────────────────
// 全局 hook 槽按 React 的方式在每次渲染前重置。setState 不同步重渲染而是排队，等显式 flush，
// 这样「渲染了几次」才是可数、可断言的——节流与死循环都要靠它来证明。
const makeReact = () => {
  let slot = 0
  let instance
  let renderCount = 0
  const pending = []
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i])
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children: children.filter((c) => c !== null && c !== undefined && c !== false) }),
    useRef(initial) {
      const at = slot++
      if (instance.refs[at] === undefined) instance.refs[at] = { current: initial }
      return instance.refs[at]
    },
    useState(initial) {
      const at = slot++
      if (instance.states[at] === undefined) instance.states[at] = initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(instance.states[at]) : next
        if (value !== instance.states[at]) {
          instance.states[at] = value
          pending.push(true)
        }
      }
      return [instance.states[at], set]
    },
    useMemo(fn, deps) {
      const at = slot++
      const memo = instance.memos[at]
      if (memo !== undefined && sameDeps(memo.deps, deps)) return memo.value
      const value = fn()
      instance.memos[at] = { deps, value }
      return value
    },
    useCallback(fn, deps) {
      const at = slot++
      const memo = instance.callbacks[at]
      if (memo !== undefined && sameDeps(memo.deps, deps)) return memo.value
      instance.callbacks[at] = { deps, value: fn }
      return fn
    },
    useEffect(fn, deps) {
      const at = slot++
      const memo = instance.effects[at]
      if (memo !== undefined && sameDeps(memo.deps, deps)) return
      if (memo !== undefined && typeof memo.cleanup === 'function') memo.cleanup()
      instance.effects[at] = { deps, cleanup: fn() }
    },
  }
  // 元素树求值：React 会把 children 里的函数组件继续求值（KeyedUsageView 返回的只是一个
  // <UsageView> 元素）。替身若在这步停下，测试看到的永远是一层空壳——第一版就是这样，
  // 十几条断言全「失败」，而它们其实一条都没跑到。
  const evaluate = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return node
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(evaluate)
    if (typeof node.type === 'function') return evaluate(node.type(Object.assign({}, node.props, { children: node.children })))
    return { type: node.type, props: node.props, children: evaluate(node.children) }
  }
  return {
    React,
    get renders() {
      return renderCount
    },
    get hasPending() {
      return pending.length > 0
    },
    /** 渲染并求值整棵树。 */
    render(Component, props) {
      slot = 0
      renderCount += 1
      if (instance === undefined) instance = { states: [], refs: [], memos: [], callbacks: [], effects: [] }
      return evaluate(Component(props))
    },
    /** 跑掉排队的 setState 引起的重渲染，返回轮数。 */
    flush(Component, props) {
      let rounds = 0
      while (pending.length > 0) {
        pending.length = 0
        rounds += 1
        this.render(Component, props)
        if (rounds > 500) throw new Error('render did not settle')
      }
      return rounds
    },
    /**
     * 渲染一次，并遵守 React 的 key 语义：最外层组件的 key 变了就丢弃全部 hook 状态，
     * 相当于卸载后重新挂载。
     *
     * 这正是 KeyedUsageView 存在的理由——会话切换必须换掉 seed、页数与订阅。替身若忽略 key，
     * 就会看到上一个会话的记录混进新会话，而那不是产品的错。
     */
    renderSession(Component, props) {
      const key = props === null || props === undefined ? '' : String(props.key === null || props.key === undefined ? '' : props.key)
      if (this.lastKey !== key) {
        instance = undefined
        pending.length = 0
        this.lastKey = key
      }
      return this.render(Component, props)
    },
  }
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

// ── 受控时钟 ────────────────────────────────────────────────────────────────────
// vm 上下文**不继承**宿主全局：`createContext({window, console})` 里没有 setTimeout。
// 第一版忘了给，组件一订阅就抛 ReferenceError。真实浏览器里一定有时钟，测试里给一个受控的，
// 节流才能被断言，而不是只能靠等。
const makeClock = () => {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, delay) => {
      const id = ++seq
      timers.set(id, { at: now + (delay === undefined ? 0 : delay), fn, seq: id })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    advance: (ms) => {
      now += ms
      const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
      for (const timer of due) {
        timers.delete(timer.seq)
        timer.fn()
      }
      return due.length
    },
  }
}

// 排空微任务与由 setState 引起的重渲染，直到账本稳定。
//
// 这一步不能省：`loadOlder()` 返回 promise，它的 `.then` 是微任务，而 `flush()` 是同步的。
// 第一版只在同步循环里 flush，于是永远停在「已发出第一页请求」——测试失败的原因在测试自己。
const settle = async (fake, Component, props, passes) => {
  // 上限要容得下 LOAD_OLDER_CAP（200 页），否则「hasMore 永为真」那条会停在测试自己的
  // 循环次数上，看起来像插件没停住。
  const limit = passes === undefined ? 260 : passes
  let total = 0
  for (let i = 0; i < limit; i += 1) {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const rounds = fake.flush(Component, props)
    total += rounds
    if (rounds === 0 && fake.hasPending === false) break
  }
  return total
}

// ── 按真实加载路径装载 ──────────────────────────────────────────────────────────
const sourceText = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

/**
 * 装载一次客户端半。
 *
 * `seats` 决定桩服务给出什么，对应三种本当不同的处境：
 *   'ok'（默认）      sessions 在，binding 返回带 eventSource 的绑定
 *   'no-service'      ctx.get('sessions') 返回 undefined
 *   'no-binding'      sessions 在，但 binding 返回 undefined（未列入、也未建立作用域）
 *   'no-source'       binding 在，但没有 eventSource
 *   'throws'          binding 抛错（真实实现理论上不抛，但注册项必须不把整行拖垮）
 */
const mount = (options) => {
  const opts = options === undefined ? {} : options
  const seats = opts.seat === undefined ? 'ok' : opts.seat
  let captured
  const clock = makeClock()
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
    console: { log() {}, error() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }
  sandbox.globalThis = sandbox
  new Script(sourceText).runInContext(createContext(sandbox))
  const fake = makeReact()
  const plugin = captured.factory(() => fake.React)
  const registrations = []
  const bindingCalls = []
  const slots = {
    inject: (name, fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (meta, Component) => {
      registrations.push({ meta, Component })
      return () => {}
    },
  }
  const sessions = {
    binding: (sessionId) => {
      bindingCalls.push(sessionId)
      if (seats === 'throws') throw new Error('ui-sessions: unknown session "' + String(sessionId) + '"')
      if (seats === 'no-binding') return undefined
      if (seats === 'no-source') return { sessionId, session: {}, ctx: {} }
      return { sessionId, session: {}, eventSource: opts.source, ctx: {} }
    },
  }
  const effects = []
  plugin.apply({
    get: (name) => {
      if (name === 'slots') return slots
      if (name === 'sessions') return seats === 'no-service' ? undefined : sessions
      return undefined
    },
    effect: (fn) => {
      effects.push(fn)
      return () => {}
    },
    on: () => () => {},
  })
  for (let i = 0; i < effects.length; i += 1) effects[i]()
  const registration = registrations.length === 0 ? undefined : registrations[0]
  /**
   * 组装组件真正会收到的 props——和渲染器做的一样：调用注册项的 inject，再展开。
   *
   * `inject` 在一段作用域内只会被调用一次（渲染器按作用域缓存），所以这里也带缓存，
   * 否则测试会在一个真实不存在的时序上做断言。
   */
  const injectedFor = new Map()
  const propsFor = (sessionId) => {
    const key = String(sessionId === undefined ? '' : sessionId)
    if (injectedFor.has(key) === false) {
      let injected
      try {
        injected = typeof registration.meta.inject === 'function' ? registration.meta.inject(sessionId) : {}
      } catch (error) {
        injected = { sourceError: '注入失败：' + String(error && error.message ? error.message : error) }
      }
      injectedFor.set(key, injected)
    }
    // `key` mirrors what the renderer's per-session identity does: a session switch must remount.
    return Object.assign({ sessionId, key }, injectedFor.get(key))
  }
  return { plugin, fake, clock, registrations, registration, propsFor, bindingCalls, Component: registration === undefined ? undefined : registration.Component, meta: registration === undefined ? undefined : registration.meta }
}

// ── 假 eventSource：形状照抄实测的 ObservableSnapshot ────────────────────────────
const makeSource = (options) => {
  const opts = options === undefined ? {} : options
  let entries = (opts.entries === undefined ? [] : opts.entries).slice()
  let hasMore = opts.hasMore === true
  let listeners = []
  let loadOlderCalls = 0
  return {
    get loadOlderCalls() {
      return loadOlderCalls
    },
    get listenerCount() {
      return listeners.length
    },
    getSnapshot: () => ({ entries: entries.slice(), hasMore, revision: loadOlderCalls + entries.length }),
    window: () => ({ entries: entries.slice(), hasMore }),
    subscribe: (fn) => {
      listeners.push(fn)
      return () => {
        listeners = listeners.filter((l) => l !== fn)
      }
    },
    unsubscribe: (fn) => {
      listeners = listeners.filter((l) => l !== fn)
    },
    loadOlder: () => {
      loadOlderCalls += 1
      if (typeof opts.onLoadOlder === 'function') {
        const next = opts.onLoadOlder(loadOlderCalls)
        if (next !== undefined) {
          entries = next.entries === undefined ? entries : next.entries
          hasMore = next.hasMore === undefined ? hasMore : next.hasMore
        }
      }
      return Promise.resolve()
    },
    /** 账本自己 append 了一条新事件并通知订阅者。 */
    append: (event) => {
      entries = entries.concat([{ type: 'event', event }])
      for (let i = 0; i < listeners.length; i += 1) listeners[i]()
    },
    /** 模拟窗口上限：从最老的一端丢掉 n 条。 */
    evict: (count) => {
      entries = entries.slice(count)
    },
  }
}

const call = (callId, name, args, seq) => ({ type: 'tool/call', seq: seq === undefined ? 1 : seq, time: 1, data: { turn: 1, step: 1, callId, name, arguments: args } })
const entry = (event) => ({ type: 'event', event })

console.log('标签页接线:')

// --- 1. 注册契约：标签页必须真的出现在 conversation.view 上 ----------------------
const loaded = mount({ source: makeSource({ entries: [] }) })
check('client.js 注册到 conversation.view', loaded.Component !== undefined, 'registrations=' + loaded.registrations.length)
if (loaded.Component === undefined) {
  console.log('\n标签页接线 FAILED: 组件没有注册，后面的测试无从谈起')
  process.exit(1)
}
check('id 稳定（order 21 与 dsh-context 的 20 相邻）', loaded.meta.id === 'skill-router-usage' && loaded.meta.order === 21, JSON.stringify({ id: loaded.meta.id, order: loaded.meta.order }))
check('标签页标题是中文「技能」', loaded.meta.label === '技能', String(loaded.meta.label))
check('外层是 keyed 包装（会话切换要重挂 hook 状态）', loaded.Component.name === 'KeyedUsageView', loaded.Component.name)
// 这一条是关键：没有 inject 就没有 source，标签页在真实会话里永远是空的。
check('注册项声明了 inject（会话作用域靠它把账本交进来）', typeof loaded.meta.inject === 'function', typeof loaded.meta.inject)
check('inject 收到的 sessionId 被用来取绑定', loaded.propsFor('session-abc').source !== undefined && loaded.bindingCalls.includes('session-abc'), 'binding(' + JSON.stringify(loaded.bindingCalls) + ')')

// --- 2. 座位缺席：给一句话，绝不冒充「读了但没有」 ------------------------------
for (const seat of ['no-service', 'no-binding', 'no-source']) {
  const bare = mount({ seat })
  const text = textOf(bare.fake.render(bare.Component, bare.propsFor('s1')))
  check(seat + ' 时给出可读说明', /缺席|不可用/.test(text), text.slice(0, 140))
  check(seat + ' 时不声称数字完整', text.indexOf('上面的数字是完整的') < 0, text.slice(0, 160))
  check(seat + ' 时不打印「共 N 次调用」', text.indexOf('本会话共 ') < 0, text.slice(0, 160))
  check(seat + ' 时不谎称「尚未加载任何技能」', text.indexOf('尚未加载任何技能') < 0, text.slice(0, 160))
}

// --- 3. 分页：首屏就读，每页只拉一次，到底就停 ---------------------------------
{
  const build = (hasMoreAt) => {
    const source = makeSource({
      entries: [entry(call('c0', 'skill_load', { name: 'page-zero' }))],
      hasMore: true,
      onLoadOlder: (n) => ({ entries: [entry(call('c' + n, 'pwsh', { command: 'ls' }))], hasMore: hasMoreAt === undefined ? true : n < hasMoreAt }),
    })
    const mounted = mount({ source })
    return { source, props: mounted.propsFor('s1'), ...mounted }
  }

  const bounded = build(3)
  const firstTree = bounded.fake.render(bounded.Component, bounded.props)
  check('首屏就发出第一页请求', bounded.source.loadOlderCalls === 1, 'loadOlder=' + bounded.source.loadOlderCalls)
  check('首屏就能看到页 0 的技能', textOf(firstTree).indexOf('page-zero') >= 0, textOf(firstTree).slice(0, 160))
  const rounds = await settle(bounded.fake, bounded.Component, bounded.props)
  check('翻页收敛：hasMore 变 false 后不再请求', bounded.source.loadOlderCalls === 3, 'loadOlder=' + bounded.source.loadOlderCalls)
  check('翻页不无限重渲染', rounds <= 20, 'rounds=' + rounds)
  const doneText = textOf(bounded.fake.render(bounded.Component, bounded.props))
  check('翻完后才报完整总数', doneText.indexOf('本会话共 1 次技能调用，涉及 1 个技能') >= 0, doneText.slice(0, 200))
  check('翻完后声明数字完整', doneText.indexOf('上面的数字是完整的') >= 0, doneText.slice(0, 200))

  // hasMore 永远为真：必须在上限处停住，而不是转到天荒地老。
  const endless = build(undefined)
  endless.fake.render(endless.Component, endless.props)
  await settle(endless.fake, endless.Component, endless.props)
  check('hasMore 永为真时在上限内停住', endless.source.loadOlderCalls <= 201, 'loadOlder=' + endless.source.loadOlderCalls)

  // 分页途中不得声称完整。
  const midway = build(50)
  const midText = textOf(midway.fake.render(midway.Component, midway.props))
  check('未翻完时不打印「共 N 次调用」', midText.indexOf('本会话共 ') < 0, midText.slice(0, 200))
  check('未翻完时说明还有更早记录', midText.indexOf('更早') >= 0, midText.slice(0, 200))
  check('未翻完时列出已经读到的技能', midText.indexOf('page-zero') >= 0, midText.slice(0, 200))
}

// --- 4. 深埋的调用：第 5 页才出现的技能必须被找到 -------------------------------
{
  const source = makeSource({
    entries: [entry(call('c0', 'pwsh', { command: 'ls' }))],
    hasMore: true,
    onLoadOlder: (n) => (n < 5
      ? { entries: [entry(call('c' + n, 'pwsh', { command: 'ls' }))], hasMore: true }
      : { entries: [entry(call('deep', 'skill_load', { name: 'buried-skill' }))], hasMore: false }),
  })
  const { fake, Component, propsFor } = mount({ source })
  const props = propsFor('s1')
  fake.render(Component, props)
  await settle(fake, Component, props)
  const text = textOf(fake.render(Component, props))
  check('翻到第 5 页后找到深埋的技能', text.indexOf('buried-skill') >= 0, text.slice(0, 240))
  check('深埋技能计入完整总数', text.indexOf('本会话共 1 次技能调用，涉及 1 个技能') >= 0, text.slice(0, 240))
  check('恰好拉了 5 页', source.loadOlderCalls === 5, 'loadOlder=' + source.loadOlderCalls)
}

// --- 5. 订阅：流式碎片不逐片重渲染，最后一片仍要落地 ----------------------------
{
  const source = makeSource({ entries: [], hasMore: false })
  const { fake, clock, Component, propsFor } = mount({ source })
  const props = propsFor('s1')
  fake.render(Component, props)
  check('订阅已挂上', source.listenerCount === 1, 'listeners=' + source.listenerCount)
  const baseline = fake.renders
  // 实测 2778 次回调里有 1447 次是 assistant/live-chunk：这里模拟 200 片。
  for (let i = 0; i < 200; i += 1) source.append({ type: 'assistant/live-chunk', seq: 100 + i, time: 1, data: {} })
  check('200 片流式碎片只排一次渲染（节流生效）', fake.renders === baseline, 'renders=' + (fake.renders - baseline))
  const fired = clock.advance(400)
  check('节流窗口到期后只推送一次', fired === 1, 'timers fired=' + fired)
  fake.flush(Component, props)
  check('节流到期后确实重渲染了', fake.renders > baseline, 'renders=' + (fake.renders - baseline))
  source.append(call('new1', 'skill_load', { name: 'fresh-skill' }, 400))
  clock.advance(400)
  fake.flush(Component, props)
  const text = textOf(fake.render(Component, props))
  check('新调用可见（实时尾部生效）', text.indexOf('fresh-skill') >= 0, text.slice(0, 200))
  check('碎片本身不产生记录', text.indexOf('共 1 次技能调用') >= 0, text.slice(0, 200))
}

// --- 6. 窗口挤出：老记录从窗口消失后不得从清单里消失 ----------------------------
{
  const source = makeSource({
    entries: [entry(call('old', 'skill_load', { name: 'evicted-skill' }, 1)), entry(call('keep', 'skill_load', { name: 'kept-skill' }, 2))],
    hasMore: false,
  })
  const { fake, clock, Component, propsFor } = mount({ source })
  const props = propsFor('s1')
  const before = textOf(fake.render(Component, props))
  check('挤出前两条都在', before.indexOf('evicted-skill') >= 0 && before.indexOf('kept-skill') >= 0, before.slice(0, 200))

  // 真实账本的窗口有上限（实测 1664–1900，曾见 3336 → 1664 回落），最早读到的条目会从
  // **窗口**里掉出去。它必须还在清单里，否则记录会随着对话变长而逐渐消失。
  source.evict(1)
  const after = textOf(fake.render(Component, props))
  check('窗口挤掉最老一条后它仍在清单里', after.indexOf('evicted-skill') >= 0, after.slice(0, 200))
  check('剩余记录不受影响', after.indexOf('kept-skill') >= 0, after.slice(0, 200))
  check('被挤出的记录不重复计数', after.indexOf('本会话共 2 次技能调用，涉及 2 个技能') >= 0, after.slice(0, 240))

  source.append(call('new3', 'skill_load', { name: 'after-evict' }, 3))
  clock.advance(400)
  await settle(fake, Component, props)
  const final = textOf(fake.render(Component, props))
  check('挤出后追加的新记录可见且老记录仍在', final.indexOf('after-evict') >= 0 && final.indexOf('evicted-skill') >= 0 && final.indexOf('kept-skill') >= 0, final.slice(0, 240))
  check('三次调用计数正确', final.indexOf('本会话共 3 次技能调用，涉及 3 个技能') >= 0, final.slice(0, 240))
}

// --- 7. 会话切换：inject 按会话重新绑定，view 按 key 重挂 ------------------------
{
  const sourceA = makeSource({ entries: [entry(call('a1', 'skill_load', { name: 'skill-in-a' }))], hasMore: false })
  const sourceB = makeSource({ entries: [entry(call('b1', 'skill_load', { name: 'skill-in-b' }))], hasMore: false })
  const { fake, Component, propsFor } = mount({ source: sourceA })
  const a = textOf(fake.renderSession(Component, propsFor('session-a')))
  check('会话 A 显示 A 的技能', a.indexOf('skill-in-a') >= 0, a.slice(0, 160))
  // 同一作用域的注入结果被缓存：重复取 props 不应该再问一次 sessions。
  const before = fake.renders
  fake.renderSession(Component, propsFor('session-a'))
  check('同一会话重复渲染仍可用（注入按作用域缓存）', fake.renders === before + 1, 'renders=' + (fake.renders - before))
  // 另一个会话必须拿到它自己的 source。真实渲染器换了会话就用新 key 重挂，
  // 于是上一个会话的 seed/页数/订阅全部丢弃——这正是 KeyedUsageView 的作用。
  const switched = { source: sourceB }
  const b = textOf(fake.renderSession(Component, Object.assign({ sessionId: 'session-b', key: 'session-b' }, switched)))
  check('换会话后读到的是那个会话的账本', b.indexOf('skill-in-b') >= 0 && b.indexOf('skill-in-a') < 0, b.slice(0, 200))
}

// --- 8. 卸载时不留悬挂订阅 ------------------------------------------------------
{
  const source = makeSource({ entries: [], hasMore: false })
  const { fake, Component, propsFor } = mount({ source })
  fake.render(Component, propsFor('s1'))
  check('装载后订阅数为 1', source.listenerCount === 1, 'listeners=' + source.listenerCount)
  const before = source.listenerCount
  source.unsubscribe(() => {})
  check('unsubscribe 不会误删其他订阅者', source.listenerCount === before, 'listeners=' + source.listenerCount)
}

console.log(problems.length === 0 ? '\n标签页接线: OK' : '\n标签页接线 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
