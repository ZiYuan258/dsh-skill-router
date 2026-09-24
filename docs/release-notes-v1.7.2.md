# v1.7.2 — 只加埋点，不改行为：按调试规程先把证据取到手

[English](#english) | 中文

这一版**没有修任何东西**，只加诊断。这是刻意的转向。

## 为什么停手

我在这条 bug 上连续提出了四个修复（数据契约、注入契约、空转语义、重入寿命），每一个都写成"这次找到根因了"，而 v1.7.0 的反馈证明第四个也不成立。我随后加载了 `systematic-debugging` 技能，它把这条路的规矩写得很清楚：

> **3 次以上修复失败 → 停下来质疑架构，不要再试第 4 次。**
>
> **多组件系统：在提出修复之前，先在每个组件边界加诊断埋点，跑一次，拿到证据说明"在哪一层断掉"。**

我两条都违反了。四次修复全是推理出来的，而我**从来没有埋点取过一次证据**。所以 v1.7.2 不加修复。

## 这次埋点要回答的具体问题

之前每一轮的诊断都被同一个盲点限制：**单实例的计数器无法区分"effect 从没跑过"和"组件在被反复重挂"**。

如果标签页每次父组件渲染都被重挂，那么实例内的截止时间、ref、计数器会被不断重置：4 秒的过期永远等不到（本地时钟一直在重新开始），而"尝试 0"旁边仍然写着"读取中"。这是当前代码上仅剩的几种解释之一，而它恰好能解释全部现象。

所以计数器改成**跨实例**（放在 `apply` 作用域，一个插件一份，不随挂载重置），并印在版本行：

```
dsh-skill-router v1.7.2 · 第 0 页 · 读取中 · 尝试 0/收尾 0 · 挂载 37(#37) · effect 0 · 心跳 0
```

读法：

| 现象 | 含义 |
|---|---|
| `挂载 1(#1) · effect 1 · 尝试 1` 而后一直「读取中」 | effect 跑了、请求发了，链条断在中途——问题在 promise 那一侧 |
| `挂载` 一直涨、`effect 0 · 心跳 0` | **组件在反复重挂**，所有本地截止时间都被重置 |
| `挂载 1 · effect 0` | effect 的守卫把它挡住了（`usable` / `loadOlder` / `gaveUp`） |
| `心跳 ≥1` 而仍是「读取中」 | 心跳跑了却没改动状态——那是我代码里的另一个 bug，而不再需要猜 |

这四个格子是互斥且穷尽的：拿到任意一行，我就能确定是哪一层。

## 这一版带来的唯一行为变化

无。`npm test` 20/20 全绿，`tab` 断言 74 → 75（新增一条：诊断字段确实印出来了）。**埋点不该改变被观测的行为**，否则观测本身就成了变量。

## English

This release **fixes nothing**. It only adds diagnostics, and that is a deliberate turn.

I proposed four fixes in a row for this bug (data contract, inject contract, no-op semantics, re-entry lifetime), each written as "found the root cause", and the report from v1.7.0 showed the fourth was not it either. I then loaded the `systematic-debugging` skill, which states the rule plainly: **after three failed fixes, stop and question the architecture rather than attempting a fourth**, and for multi-component systems, **add diagnostic instrumentation at each boundary and gather evidence about which layer breaks before proposing any fix**. I violated both: four fixes from inference, and not one instrumented measurement.

So v1.7.2 proposes no fix. Every previous round was limited by the same blind spot — **per-instance counters cannot distinguish "the effect never ran" from "the component is being remounted"**. A tab remounted on every parent render resets its deadline, its refs and its counters, so the 4-second expiry is never reached (the local clock keeps restarting) while "尝试 0" still sits beside "读取中". That is one of the few remaining explanations, and it accounts for every observation.

The counters are therefore **module-lifetime** — they live in `apply`'s scope, one per plugin, and survive remounts — and they print in the version line: `挂载 37(#37) · effect 0 · 心跳 0`. Those four readings are mutually exclusive and exhaustive, and any one of them identifies the layer: an effect that ran and sent a request but never converged (the promise side), a mounting count that keeps climbing with `effect 0` (a remount storm resetting every local deadline), an effect blocked by one of its own guards, or a heartbeat that fired without changing state — which would be a bug in my code rather than something left to guess.

The only behavioural change here is none: 20/20 scripts green, `tab` assertions 74 → 75 for the fields being present at all. Instrumentation that changes what it measures is not instrumentation.
