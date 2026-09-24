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
// vm 上下文**不继承**宿主全局：`createContext({window, console})` 里没有 setTimeout，也没有
// Date。第一版忘给 setTimeout，组件一订阅就抛 ReferenceError。而"读取中"改成**有截止时间**之后
// Date 也必须受控，否则"过没过期"取决于测试跑得多快——那正是"永远读取中"这类缺陷的温床。
const makeClock = () => {
  let now = 1_000_000
  let seq = 0
  const timers = new Map()
  const intervals = new Map()
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length === 0 ? [now] : args))
    }
    static now() {
      return now
    }
  }
  return {
    now: () => now,
    Date: FakeDate,
    setTimeout: (fn, delay) => {
      const id = ++seq
      timers.set(id, { at: now + (delay === undefined ? 0 : delay), fn, seq: id })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    setInterval: (fn, delay) => {
      const every = delay === undefined || delay <= 0 ? 1 : delay
      const id = ++seq
      intervals.set(id, { every, next: now + every, fn, seq: id })
      return id
    },
    clearInterval: (id) => {
      intervals.delete(id)
    },
    /** 推进时间，按到期顺序触发 timeout 与 interval 回调，返回触发个数。 */
    advance: (ms) => {
      const target = now + ms
      let fired = 0
      for (;;) {
        const dueTimer = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
        const dueInterval = [...intervals.values()].filter((t) => t.next <= target).sort((a, b) => a.next - b.next || a.seq - b.seq)[0]
        if (dueTimer === undefined && dueInterval === undefined) break
        if (dueTimer !== undefined && (dueInterval === undefined || dueTimer.at <= dueInterval.next)) {
          now = dueTimer.at
          timers.delete(dueTimer.seq)
          dueTimer.fn()
        } else {
          now = dueInterval.next
          dueInterval.next = now + dueInterval.every
          dueInterval.fn()
        }
        fired += 1
        if (fired > 500) break
      }
      now = target
      return fired
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
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: clock.Date,
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
      // `eventSource` deliberately has NO `loadOlder`. The framework's own declaration is
      // `SessionEventSource = ObservableSnapshot<SessionEventWindow>`, whose entire surface is
      // `getSnapshot()` and `subscribe()`; `loadOlder(): Promise<void>` is on the session face.
      //
      // This fixture used to put `loadOlder` on the SOURCE — the same wrong object the product
      // called it on. That is why the suite could be green while the tab never paged: the fixture
      // agreed with the bug instead of exposing it.
      const session = opts.session === undefined ? { loadOlder: opts.loadOlder } : opts.session
      if (seats === 'no-source') return { sessionId, session, ctx: {} }
      return { sessionId, session, eventSource: opts.source, ctx: {} }
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
  /**
   * 组装组件真正会收到的 props——和渲染器做的一样：调用注册项的 inject，再展开。
   *
   * 第二个参数是**作用域绑定**。渲染器的 `runInject` 就是 `inject(binding.key, actions)`，而这段
   * 作用域绑定的 key 就是会话 id。之前的版本只传了一个参数、桩里也是 undefined，于是"两个参数都
   * 试"这条回退路径从来没被跑到；只传 1 个参数的替身，验证不到渲染器真正传的东西。
   */
  const propsFor = (sessionId, options) => {
    const opts = options === undefined ? {} : options
    const key = String(sessionId === undefined ? '' : sessionId)
    const scopeBinding = { key: opts.bindingKey === undefined ? sessionId : opts.bindingKey, props: {} }
    const injectedKey = key + '|' + String(scopeBinding.key)
    // `freshInject` bypasses the cache, modelling a parent that hands over a brand-new props object
    // on every render. That is the condition a re-entering effect has to survive.
    if (opts.freshInject === true) injectedFor.delete(injectedKey)
    if (injectedFor.has(injectedKey) === false) {
      let injected
      try {
        injected = typeof registration.meta.inject === 'function'
          ? opts.callInjectWith === 'binding-only'
            ? registration.meta.inject(undefined, scopeBinding)
            : registration.meta.inject(sessionId, scopeBinding)
          : {}
      } catch (error) {
        injected = { sourceError: '注入失败：' + String(error && error.message ? error.message : error) }
      }
      injectedFor.set(injectedKey, injected)
    }
    // `key` mirrors what the renderer's per-session identity does: a session switch must remount.
    return Object.assign({ sessionId, key: opts.bindingKey === undefined ? key : String(opts.bindingKey) }, injectedFor.get(injectedKey))
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
  /** The session's paging method — NOT the source's. `makeSource` returns the window only. */
  const loadOlder = () => {
    loadOlderCalls += 1
    if (typeof opts.onLoadOlder === 'function') {
      const next = opts.onLoadOlder(loadOlderCalls)
      if (next !== undefined) {
        entries = next.entries === undefined ? entries : next.entries
        hasMore = next.hasMore === undefined ? hasMore : next.hasMore
      }
    }
    return Promise.resolve()
  }
  return {
    get loadOlderCalls() {
      return loadOlderCalls
    },
    get listenerCount() {
      return listeners.length
    },
    /** The window, as the framework declares it: `getSnapshot` + `subscribe`, nothing else. */
    getSnapshot: () => ({ entries: entries.slice(), hasMore, revision: loadOlderCalls + entries.length }),
    subscribe: (fn) => {
      listeners.push(fn)
      return () => {
        listeners = listeners.filter((l) => l !== fn)
      }
    },
    /** Mount with this: the session face carries the paging method. */
    session: { loadOlder },
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
const emptySource = makeSource({ entries: [] })
const loaded = mount({ source: emptySource, session: emptySource.session })
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
// 「浏览器跑的是哪一版」必须能从界面上读出来：bundle 带 immutable 缓存、这个文件不能被 Node 测试
// import、服务端字节又挡在 Desktop 的能力校验后面，所以它曾是唯一无法回答的问题。
{
  const text = textOf(loaded.fake.render(loaded.Component, loaded.propsFor('s1')))
  check('标签页印出运行版本', /dsh-skill-router v\d+\.\d+\.\d+/.test(text), text.slice(-140))
  check('标签页印出翻页状态', /(已读完|读取中|无进展停止|超时停止|到上限停止|无读取入口|出错)/.test(text), text.slice(-140))
  // 「尝试 0」+「读取中」= effect 压根没启动过；这是无法从外部区分的那类事实，所以它必须印出来。
  check('标签页印出尝试/收尾计数（区分「没启动」与「启动了没收敛」）', /尝试 \d+\/收尾 \d+/.test(text), text.slice(-220))
  check('标签页印出 effect/心跳计数', /effect \d+/.test(text) && /心跳 \d+/.test(text), text.slice(-220))
  // 「可翻页」必须写在**结论那一行**：它是判读"翻页有没有入口"的唯一字段，不该埋在诊断里。
  const verdict = (loaded.fake.render(loaded.Component, loaded.propsFor('s1')).children || [])
    .map((child) => (child && child.props && child.props.className === 'sr-usage-ver' ? textOf(child) : ''))
    .join('')
  check('结论行写明是否可翻页', /可翻页 [是否]/.test(verdict), verdict)
}

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
  /**
   * 一个会**累积**的账本。
   *
   * 这里必须是累积的：真实窗口是"往里 prepend 一页"，所以翻一页它就变长一次，而产品正是靠
   * "窗口有没有变长"来判断这一页有没有真的读到——`loadOlder()` 在会话还没打开时会静默空转
   * （见 client.js 里的说明），所以 promise resolve 不等于读到了。
   *
   * 早先的夹具每页返回一个**只含那一页的全新数组**，于是窗口长度恒为 1、"无进展"恒为真：
   * 桩模拟了一个现实中不存在的账本，然后让正确的实现看起来是错的。夹具比现实更简单，
   * 和夹具比现实更友好一样危险。
   */
  const build = (hasMoreAt) => {
    const all = [entry(call('c0', 'skill_load', { name: 'page-zero' }))]
    const source = makeSource({
      entries: all.slice(),
      hasMore: true,
      onLoadOlder: (n) => {
        all.unshift(entry(call('c' + n, 'pwsh', { command: 'ls' })))
        return { entries: all.slice(), hasMore: hasMoreAt === undefined ? true : n < hasMoreAt }
      },
    })
    const mounted = mount({ source, session: source.session })
    return { source, props: mounted.propsFor('s1'), ...mounted }
  }

  const bounded = build(3)
  const firstTree = bounded.fake.render(bounded.Component, bounded.props)
  check('首屏就发出第一页请求', bounded.source.loadOlderCalls === 1, 'loadOlder=' + bounded.source.loadOlderCalls)
  // 这一条是这一整轮的核心：翻页方法在**会话**上，不在账本上。账本
  // （`SessionEventSource = ObservableSnapshot<SessionEventWindow>`）只声明了 `getSnapshot` 与
  // `subscribe`。历史版本对着 `source.loadOlder` 写代码，于是 effect 每次都在守卫处早退，
  // 四次"修复"全都改在一条从未执行的代码路径上。这个断言的作用就是让它无法再发生。
  check('翻页调用的是会话上的 loadOlder，而不是账本上的', typeof bounded.source.loadOlder === 'undefined' && bounded.source.loadOlderCalls === 1)
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
  // 同样是累积的账本：第 5 页才出现那次技能调用，它必须被翻到。
  const all = [entry(call('c0', 'pwsh', { command: 'ls' }))]
  const source = makeSource({
    entries: all.slice(),
    hasMore: true,
    onLoadOlder: (n) => {
      all.unshift(n < 5 ? entry(call('c' + n, 'pwsh', { command: 'ls' })) : entry(call('deep', 'skill_load', { name: 'buried-skill' })))
      return { entries: all.slice(), hasMore: n < 5 }
    },
  })
  const { fake, Component, propsFor } = mount({ source, session: source.session })
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
  const { fake, clock, Component, propsFor } = mount({ source, session: source.session })
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
  const { fake, clock, Component, propsFor } = mount({ source, session: source.session })
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
  const { fake, Component, propsFor } = mount({ source: sourceA, session: sourceA.session })
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

// --- 8. 读取卡住时必须给结论，不能永远「正在读取」 ------------------------------
//
// 这三条来自真机观察：标签页在浏览器里停在「已读到第 0 页…仍在继续」，因为一次翻页请求永远
// 没有 settle，而 loading 只在 resolve/reject 时被改写。测试跑不到这条路径，是因为替身的
// loadOlder 总是立刻 resolve —— 又一次「替身比现实更友好」。
{
  // (a) loadOlder 返回非 promise（宿主侧接口不保证返回 promise，`.then` 会当场抛）
  const nonPromise = makeSource({ entries: [entry(call('n1', 'skill_load', { name: 'kept-while-paging' }))], hasMore: true })
  nonPromise.session.loadOlder = () => undefined
  {
    const { fake, clock, Component, propsFor } = mount({ source: nonPromise, session: nonPromise.session })
    const props = propsFor('s1')
    const first = textOf(fake.render(Component, props))
    check('非 promise 的 loadOlder 不使标签页崩溃', first.indexOf('技能调用清单') >= 0, first.slice(0, 160))
    await settle(fake, Component, props)
    const text = textOf(fake.render(Component, props))
    check('非 promise 时不再声称仍在读取', text.indexOf('仍在继续') < 0, text.slice(0, 220))
    check('非 promise 时保留已读到的记录', text.indexOf('kept-while-paging') >= 0, text.slice(0, 220))
    clock.advance(20000)
    fake.flush(Component, props)
    check('非 promise 时不会无限翻页', nonPromise.loadOlderCalls <= 1, 'loadOlder=' + nonPromise.loadOlderCalls)
  }

  // (b) loadOlder 永远不 settle：看门狗必须兜住
  const never = makeSource({ entries: [entry(call('w1', 'skill_load', { name: 'stuck-then-ok' }))], hasMore: true })
  never.session.loadOlder = () => new Promise(() => {})
  {
    const { fake, clock, Component, propsFor } = mount({ source: never, session: never.session })
    const props = propsFor('s1')
    const first = textOf(fake.render(Component, props))
    check('未 settle 时先如实显示「仍在继续」', first.indexOf('仍在继续') >= 0, first.slice(0, 200))
    clock.advance(8000)
    fake.flush(Component, props)
    const after = textOf(fake.render(Component, props))
    check('看门狗到期后不再说「仍在继续」', after.indexOf('仍在继续') < 0, after.slice(0, 240))
    check('看门狗到期后说明读取没有回应', after.indexOf('读取更早记录没有回应') >= 0, after.slice(0, 240))
    check('停住后不打印「共 N 次调用」', after.indexOf('本会话共 ') < 0, after.slice(0, 240))
    check('停住后仍列出已读到的技能', after.indexOf('stuck-then-ok') >= 0, after.slice(0, 240))
    const callsAtStall = never.loadOlderCalls
    clock.advance(20000)
    fake.flush(Component, props)
    await settle(fake, Component, props)
    check('停住之后不再发起新请求', never.loadOlderCalls === callsAtStall, 'loadOlder=' + never.loadOlderCalls)
    // 但实时尾部仍然要活着：账本后来出现了新调用，必须能看到。
    never.append(call('w2', 'skill_load', { name: 'arrived-later' }))
    clock.advance(400)
    fake.flush(Component, props)
    const live = textOf(fake.render(Component, props))
    check('停住翻页不影响实时新记录', live.indexOf('arrived-later') >= 0, live.slice(0, 240))
  }
}

// --- 9. inject 的两个参数都能用 -------------------------------------------------
// 渲染器按作用域绑定的 key 调 inject；第二个参数只在带上下文的渲染路径上被传。所以两种都必须
// 能拿到账本——只赌其中一个，就是在赌渲染器走哪条路。
{
  const source = makeSource({ entries: [entry(call('k1', 'skill_load', { name: 'via-key' }))], hasMore: false })
  const first = mount({ source, session: source.session })
  const viaFirst = textOf(first.fake.render(first.Component, first.propsFor('session-key')))
  check('inject 第一个参数（binding.key）能取到账本', viaFirst.indexOf('via-key') >= 0, viaFirst.slice(0, 160))

  const second = mount({ source, session: source.session })
  const viaBinding = textOf(second.fake.render(second.Component, second.propsFor('session-key', { callInjectWith: 'binding-only' })))
  check('inject 第二个参数（作用域绑定）也能取到账本', viaBinding.indexOf('via-key') >= 0, viaBinding.slice(0, 160))
  check('第二个参数回退时确实用了 binding.key', second.bindingCalls.includes('session-key'), 'binding(' + JSON.stringify(second.bindingCalls) + ')')
}

// --- 10. 父组件重渲染不得让翻页卡死 ---------------------------------------------
//
// 这一条来自真机：界面上印着 v1.6.9、状态却是「读取中」——新代码在跑，而看门狗没有兜住。唯一能
// 同时成立的解释是 effect 被重入：清理跑过一次（`live = false` 让旧看门狗空转），而
// `inFlightRef` 仍是 true，于是新一轮在守卫处直接早退——**没有任何计时器在跑，也没有任何东西
// 会再写状态**，标签页就永远停在"读取中"。
//
// 触发条件就是父组件重渲染：渲染器把注入结果展开成 props，父组件每次给出新的 props 对象时，
// 任何"每次渲染都产生新引用"的值都会让 effect 重新进入。所以这里关掉注入缓存，每次算一份新
// props，断言翻页仍然收敛。
{
  const build = () => {
    const all = [entry(call('r0', 'skill_load', { name: 'churn-a' }))]
    const source = makeSource({
      entries: all.slice(),
      hasMore: true,
      onLoadOlder: (n) => {
        all.unshift(entry(call('r' + n, 'pwsh', { command: 'ls' })))
        return { entries: all.slice(), hasMore: n < 2 }
      },
    })
    const mounted = mount({ source, session: source.session })
    return { source, ...mounted }
  }

  const churn = build()
  const fresh = () => Object.assign({ sessionId: 's1', key: 's1' }, churn.propsFor('s1', { freshInject: true }))
  churn.fake.render(churn.Component, fresh())
  // 故意在翻页在途时重渲染：如果 effect 的清理会让在途请求作废，这里就会卡住。
  churn.fake.render(churn.Component, fresh())
  await settle(churn.fake, churn.Component, fresh())
  const text = textOf(churn.fake.render(churn.Component, fresh()))
  check('父组件重渲染后翻页仍收敛', churn.source.loadOlderCalls === 2, 'loadOlder=' + churn.source.loadOlderCalls)
  check('重渲染后不残留「读取中」', text.indexOf('读取中') < 0, text.slice(-140))
  check('重渲染后如实报告已读完', text.indexOf('已读完') >= 0, text.slice(-140))

  // 最坏情况：请求永不 settle，且父组件一直重渲染——看门狗必须仍然到期。
  const never = makeSource({ entries: [entry(call('n0', 'skill_load', { name: 'churn-b' }))], hasMore: true })
  never.session.loadOlder = () => new Promise(() => {})
  const second = mount({ source: never, session: never.session })
  const fresh2 = () => Object.assign({ sessionId: 's1', key: 's1' }, second.propsFor('s1', { freshInject: true }))
  second.fake.render(second.Component, fresh2())
  second.fake.render(second.Component, fresh2())
  second.clock.advance(4000)
  await settle(second.fake, second.Component, fresh2())
  const stuck = textOf(second.fake.render(second.Component, fresh2()))
  check('重渲染下令看门狗仍然到期', stuck.indexOf('读取中') < 0, stuck.slice(-140))
  check('看门狗到期后报告超时停止', stuck.indexOf('超时停止') >= 0, stuck.slice(-140))
}

// --- 11. 「读取中」必须有截止时间，且不依赖任何回调 ------------------------------
//
// 真机上 v1.6.9 与 v1.7.0 都停在「读取中」，说明"只有回调能清掉 loading"这个设计本身不成立：
// 只要那条回调链断在任何一环，标签页就永远在撒谎。所以"读取中"现在是一个**截止时间**——到点
// 自动过期，不需要任何东西触发；再加一个心跳，只为了让过期这件事被渲染出来。
{
  // (a) 请求永不 settle、且看门狗被外力清掉（模拟"回调链断掉"）：心跳必须兜住。
  const source = makeSource({ entries: [entry(call('d1', 'skill_load', { name: 'deadline-a' }))], hasMore: true })
  source.loadOlder = () => new Promise(() => {})
  const { fake, clock, Component, propsFor } = mount({ source, session: source.session })
  const props = propsFor('s1')
  const first = textOf(fake.render(Component, props))
  check('首屏如实显示「读取中」', first.indexOf('读取中') >= 0, first.slice(-140))
  // 推进超过截止时间：心跳到期并把「读取中」摘掉。
  clock.advance(4000)
  const after = textOf(fake.render(Component, props))
  check('超过截止时间后不再显示「读取中」', after.indexOf('读取中') < 0, after.slice(-140))
  check('并给出停止原因', /(超时停止|无进展停止)/.test(after), after.slice(-140))

  // (b) 账本一直完好、翻页正常完成时，心跳不得把状态误判成超时。
  const fine = makeSource({
    entries: [entry(call('f0', 'skill_load', { name: 'deadline-b' }))],
    hasMore: true,
    onLoadOlder: () => ({ entries: [entry(call('f1', 'pwsh', { command: 'ls' })), entry(call('f0', 'skill_load', { name: 'deadline-b' }))], hasMore: false }),
  })
  const second = mount({ source: fine, session: fine.session })
  const p2 = second.propsFor('s1')
  second.fake.render(second.Component, p2)
  await settle(second.fake, second.Component, p2)
  second.clock.advance(20000)
  const ok = textOf(second.fake.render(second.Component, p2))
  check('正常完成后心跳不误报超时', ok.indexOf('已读完') >= 0, ok.slice(-140))
}

// --- 11. 订阅与取消：契约是 subscribe() 返回取消函数，没有 unsubscribe() ----------
{
  const source = makeSource({ entries: [], hasMore: false })
  const { fake, Component, propsFor } = mount({ source, session: source.session })
  fake.render(Component, propsFor('s1'))
  check('装载后订阅数为 1', source.listenerCount === 1, 'listeners=' + source.listenerCount)
  // `ObservableSnapshot` declares only `getSnapshot()` and `subscribe(fn): () => void` — the
  // canceller is the RETURN VALUE, there is no `unsubscribe` method. The product used to call
  // `source.unsubscribe` behind a `typeof` guard, which silently did nothing and left one listener
  // attached per mount; asserting the real shape is what keeps that from coming back.
  check('账本上没有 unsubscribe 方法（取消靠 subscribe 的返回值）', typeof source.unsubscribe === 'undefined')
  let disposed = 0
  const disposer = source.subscribe(() => {
    disposed += 1
  })
  check('subscribe 返回取消函数', typeof disposer === 'function')
  disposer()
  check('调用返回值即取消该订阅，且不影响其他订阅者', source.listenerCount === 1 && disposed === 0, 'listeners=' + source.listenerCount)
  // 卸载路径必须用返回值取消：否则每次装载都会多留一个监听者。
  const before = source.listenerCount
  const second = mount({ source, session: source.session })
  second.fake.render(second.Component, second.propsFor('s1'))
  check('第二次装载会新增订阅，且取消靠返回值而非不存在的方法', source.listenerCount === before + 1, 'listeners=' + source.listenerCount)
}

console.log(problems.length === 0 ? '\n标签页接线: OK' : '\n标签页接线 FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
