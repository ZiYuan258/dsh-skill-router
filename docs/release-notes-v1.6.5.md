# v1.6.5 — 换成 `eventSource`：修掉一个「测试全绿但标签页是空的」的数据契约错误

[English](#english) | 中文

上一个版本的技能标签页读的是 `useChat` 的 `legacy.nodes`，并假定那就是会话历史。**这个假定是错的**，而且是那种最难发现的错：它不崩、不报错、UI 也画得出来，只是永远显示"尚未加载任何技能"。

## 错在哪：三次推断，一次实测

这个标签页的数据来源先后错过三次，每一次在评审里都显得合理：

| 版本 | 读的是什么 | 为什么错 |
|---|---|---|
| 第一版 | `kind: 'tool-call'` 的节点 | 猜的形状；工具调用其实是节点里的一个 block |
| 第二版 | 请求头里的本轮工具**声明** | 把"这一轮提供给模型看的技能"当成了"被加载的技能"——所有计数都虚高，一次报"skill_load × 23"的会话实际什么都没加载 |
| 第三版 | `useChat().legacy.nodes` | **实测证伪**：某次实时快照里 210 个节点、**0 次工具调用**，而同一时刻的会话账本里有 2778+ 条事件，技能调用就在里面 |

`legacy.nodes` 是**给 UI 看的截断投影**，不是历史。判定方式不是读代码猜，是在跑着的会话里同时取两份数据对比——这也是这三次改错的共同教训：**假设必须实测**。

> **一处需要更正的措辞。** 我在提交说明里写过"这个座位在会话 UI 里根本不存在"——**那句话是错的**。现场插槽目录里 `conversation.view` 的 `standardProps` 明确列着 `useChat: UseChat`，它由 `dsh-client-ui-chat` 通过 `uiSession.provide` 提供。所以第三版**确实拿到了座位**，它只是从一个截断投影里读数据。座位在、数据不对，和"座位不在"是两回事——而我只验证了一半就下了结论。

## 改成什么

唯一权威来源是会话账本。而**账本是怎么到达组件的**，本身就是一份必须照抄的契约：

```js
slots.register({
  name: 'conversation.view',
  id: 'skill-router-usage',
  order: 21,
  label: '技能',
  inject: (sessionId) => {
    const binding = ctx.get('sessions')?.binding(sessionId)
    return { source: binding?.eventSource }   // 展开到组件 props 上
  },
}, KeyedUsageView)
```

`conversation.view` 是**会话作用域**插槽（`children: { 'conversation.view': { kind: 'list', scope: 'session' } }`），渲染器用作用域绑定的 key 调用注册项的 `inject(sessionId)`，再把返回值展开到组件 props 上；`trajectory`、`chat`、`goal` 三个官方标签页都这样拿会话。

**这一版的初稿不是这样写的**，它读 `props.sessionId`。那条路能跑，但那是**运气**：渲染器给 `conversation.view` 传的 ownerProps 只有 `viewRequest` / `openView` / `completeViewRequest`，`sessionId` 只是碰巧被会话根组件透传下来。而且初稿还会在卸载时调 `binding.dispose()`——真实的 `SessionBinding` 是 `{ sessionId, session, eventSource, ctx }`，没有 `dispose`，作用域生命周期归会话控制器管。改成 `inject` 之后，"标签页跟随会话切换"这件事由契约保证（注入结果按作用域缓存，key 变了就重挂），不再依赖任何巧合。

事件的真实形状（实测，不是推断）：

```js
{ type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }
```

真实的一次技能调用在 `seq=6228` 被找到，`entries`/`revision` 在会话进行中被观察着增长。

## 账本的三个决定

**`callId` 是调用的身份**，不是 `seq`、也不是数组下标。同一次调用会在之后**每一个**快照里重新出现一次，用别的键就会把一次加载数成很多次。

**显示行按 `callId + 规范化技能名` 去重，调用数按 `callId` 去重。** 两者分开数：一次调用点名 A 和 B 是 1 次调用、2 行；两次调用都加载 A 是 2 次调用、1 个技能。

**窗口有上限，所以必须累积。** 实测窗口被封在约 1664–1900 条，还见过从 3336 回落到 1664。条目会从窗口里掉出去，所以账本保存"已经读到过什么"，而不是每次渲染重新从窗口推导一遍——否则记录会随着对话变长而逐渐消失。

## 完整性是三态，不是布尔

`hasMore` 在**最新那一页上是 true**：第 0 页是历史的**近端**，五页之前加载的技能在翻到那里之前根本看不见。所以：

- 只有 `hasMore === false` 时，标签页才打印 `共 N 次调用，涉及 M 个技能`；
- 之前显示"已加载 N 个技能名，更早的记录尚未读完"；
- 读不到账本时（服务缺席 / 没有 eventSource）**只说这一件事**，不打印任何计数——否则"我没读到"会被显示成"我读完了，是空的"。

## 翻页是生命周期工作，不是渲染工作

`loadOlder()` 只在 effect 里调用，且用 ref 守卫"在途"和"页数"。这不是洁癖：把 `state.loading` 放进 effect 依赖里、并在 effect 内改它的那一版，会在**同一次翻页的在途期间被重新进入**（实时订阅每有新事件就 bump 一次 tick），于是一页发出两次请求。对着一个永不结束的账本实测：`loadOlder` 被调用 **399 次**，而上限是 200。短历史上完全看不出来——它在翻页结束前早就收敛了。

订阅按 400 ms 节流而不是防抖：实测 2778 次回调里有 **1447 次是 `assistant/live-chunk` 流式碎片**，逐片渲染是把预算花在重画没变的数据上；但burst 的最后一片必须落地，所以是节流不是防抖。

## 删掉宿主半里的同一份逻辑

`host.js` 里的 `collectSkillUsage`（连同 `usageArgsOf`、`USAGE_MAX_NAMES`）**已删除**。它读的就是 `legacy.nodes`，而且让同一份逻辑存在两份正是它们走偏的原因。文件里留了一段注释说明它为什么被删——不是为了好看，是为了下一个想把它加回来的人先看到证据。`test/client-half.mjs` 现在会**扫描并拒绝**这些作废契约（`legacy.nodes`、`useChat`、把声明当用量）重新出现在代码里。

## 测试：这次让夹具照抄实测形状

19 个测试全绿曾经和一个不存在的标签页共存，因为夹具编码的是**推断**的形状。所以新增的两个测试文件：

- `test/usage-ledger.mjs`（48 项）——账本纯逻辑：三种加载工具算、`skill_search` 不算、`callId` 去重、`A+B` 保留两个、路径与裸名归并、`hasMore` 三态、窗口挤出后记录不丢、坏输入不抛。
- `test/usage-tab.mjs`（39 项）——接线：注册契约、座位缺席的两种说明、首屏即读、每页只拉一次、上限内停住、第 5 页深埋的调用被找到、200 片碎片只排一次渲染、**窗口挤掉最老一条后它仍在清单里**。

两个文件都通过**浏览器装载它的同一条路径**取组件：插桩 `__ModuleLoader__` → 物化 factory → 桩 ctx 调 `apply` → 执行 `ctx.effect` 登记的闭包 → 拿到 `slots.register` 收到的组件。测试自己犯的错也一并修了：React 替身原先不求值子组件（看到的水远是一层空壳）、`flush()` 是同步的而 `loadOlder()` 返回 promise（微任务永远不跑，停在第一页）、`mount` 读的键名和测试传的不一致。

## English

The skill tab used to read `useChat`'s `legacy.nodes` and assume it was the session history. **That assumption was false**, in the worst way: nothing crashes, nothing throws, the UI renders — it simply always says "no skills loaded yet".

**Three inferred data sources, one measurement.** A `kind: 'tool-call'` node (a guess about the shape); per-turn tool *declarations* read from request headers (counting skills merely *offered* to the model as loaded — a session reported as "skill_load × 23" had loaded nothing); and `legacy.nodes`, falsified by taking both readings at once in a live session: **210 nodes, ZERO tool calls**, against a session ledger holding 2,778+ events with the skill calls in it. `legacy.nodes` is a truncated UI projection, not history.

**One wording to correct.** My commit message claimed the seat "does not exist in the conversation UI at all". That was **wrong**: the live slot catalog lists `useChat: UseChat` among the standard props of `conversation.view`, provided by `dsh-client-ui-chat` through `uiSession.provide`. The third version did receive a real seat — it just read a truncated projection from it. A seat that is present with wrong data is a different finding from a seat that is absent, and I concluded after verifying only half of that.

**The authoritative source is the ledger**, and how it reaches the component is itself a contract worth copying: `conversation.view` is a session-scoped slot, so the renderer calls the registration's `inject(sessionId)` with the scope binding's key and spreads the result over the component's props — which is how `trajectory`, `chat` and `goal` all reach their session.

**The first draft of this version did not do that**; it read `props.sessionId`. That works by luck: the ownerProps the renderer passes to `conversation.view` are only `viewRequest` / `openView` / `completeViewRequest`, and `sessionId` is merely passed down by the conversation root. The draft also called `binding.dispose()` on unload — the real `SessionBinding` is `{ sessionId, session, eventSource, ctx }` with no `dispose`, because scope lifetime belongs to the session controller. With `inject` in place, following a session switch is guaranteed by the contract (injected props are cached per scope, so a new key remounts) rather than by coincidence.

The observed event is `{ type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }`; a real skill call was found at `seq=6228`.

**`callId` is the identity**, not `seq` and not the array position: the same call is re-delivered on every later snapshot. Rows dedupe on `callId + normalized name`, calls on `callId` alone — one call naming A and B is 1 call and 2 rows; two calls naming A are 2 calls and 1 skill.

**The window is bounded** (observed ~1,664–1,900, seen resetting 3,336 → 1,664), so entries can fall out after being read. The ledger accumulates what it has read and merges by key instead of re-deriving from the window each render — otherwise records disappear as the conversation grows.

**Completeness is three states, not a boolean.** `hasMore` is true on the newest page, so page 0 is the RECENT end and a skill loaded five pages back is invisible until paging reaches it. `共 N 次调用，涉及 M 个技能` is printed only once `hasMore` is false; before that the tab says which page it is on; with no ledger to read it says only that, and prints no counts at all — "I could not read it" must never render as "I read it and it was empty".

**Paging is lifecycle work.** `loadOlder()` runs only in an effect, guarded by refs. The version that kept `state.loading` in that effect's dependencies and flipped it inside the effect was re-entered mid-flight (the live subscriber bumps a tick per event) and issued two requests for one page: **399 `loadOlder` calls against a cap of 200**, invisible on a short history because it converges long before the doubling shows.

**Subscription is throttled at 400 ms, not debounced**: 1,447 of 2,778 observed callbacks were `assistant/live-chunk` fragments, and rendering per fragment spends the budget redrawing unchanged data — while the last fragment of a burst must still land.

**`collectSkillUsage` is deleted from `host.js`** (with `usageArgsOf` and `USAGE_MAX_NAMES`). It read `legacy.nodes`, and having the same logic in two places is how the two drifted apart. A comment records why it was removed, and `test/client-half.mjs` now scans for and rejects these falsified contracts returning to the code.

**The fixtures now copy observed shapes.** 19 green tests once coexisted with a non-functional tab because the fixtures encoded inferred shapes, so both new test files take the component through the browser's own load path (instrument `__ModuleLoader__`, materialize the factory, call `apply` with a stub ctx, run the effect closures, take what `slots.register` received). Their own harness bugs were fixed too: the React stand-in did not evaluate child components, `flush()` was synchronous while `loadOlder()` returns a promise, and `mount` read a different option key than the tests passed.
