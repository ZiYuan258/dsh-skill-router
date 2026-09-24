# v1.6.8 — 真机第二次反馈定案：`loadOlder()` 不是挂住，是**静默空转**

[English](#english) | 中文

v1.6.7 之后用户刷新了页面，标签页**多出了正确的一行**：

```
本会话已加载 1 个技能名（1 次调用，涉及 1 个技能），正在读取更早的记录…
1  验证·前置·完成 (verification-before-completion)  skill_load  第 63 轮
已读到第 0 页更早的记录，仍在继续。
```

数据链路全通了（技能名、轮次、调用数都对），只剩那条状态永远不收敛。而这次能定案了——因为我终于去读了真实的实现：

```js
async loadOlder() {
  if (this.openState !== "open" || !this.hasMore || this.loadingOlder) return;  // 三层早退
  const events = this.events;
  if (events === undefined) return;                                             // 第四层
  ...
}
```

**它不是一个会挂住的请求，它是一个会静默什么都不做的请求。** 会话还在打开、`events` 还没到、已有并发请求——任何一种都让它立刻返回一个**已 resolve 的 promise**。

而我一直在把"promise resolve 了"当成"读到了一页"。这是同一个错误的第五次变体：**把代理解成了事实**。前四次分别是节点形状、工具声明、`legacy.nodes` 投影、`props.sessionId` 巧合。这次是把"请求完成"当成了"数据到达"。

## 修法：以窗口为判据

官方 trajectory 标签页早就给出了答案，我该早点照抄：

```js
loadOlder: async () => {
  const before = trajectory.getSnapshot();
  await session.loadOlder();
  return trajectory.getSnapshot() !== before;   // 判据是窗口，不是 promise
}
```

现在我也这么做：请求前后比对**窗口长度**。变长了 = 真读到一页，`page` 加一；没变 = 空转，重试一次（会话可能还在打开），连续两次无进展才停下并说明原因。

三种停止原因分开说，因为它们对排查的人意义不同：

| 停止原因 | 文案 |
|---|---|
| 请求无回应（8 秒看门狗） | 读取更早记录没有回应，已停止——上面的数字只是这部分的。 |
| 有回应但窗口没动 | 账本暂时没有交出更早的记录（sessions.loadOlder 无进展），已停止——上面的数字只是这部分的。 |
| 到页数上限 | 已读到第 N 页更早的记录，之后不再继续读取——上面的数字只是这部分的。 |

## 过程中测试抓到的三个真缺陷

1. **重试计数会归零。** 我最初在每次尝试后写 state（好让界面动起来），而 effect 重跑时局部的 `retries` 从 0 开始——上限永远到不了，等于无限重试。改成**一次 effect 内把重试跑完，只在结论处写 state**。
2. **进度判据取错了基准。** 用 effect 开头的快照比对，会让"上一次尝试读到的页"满足条件，于是**真正读到页的那次重试反被判成空转**。改成一个记住"见过的最大窗口"的 ref。
3. **看门狗变量声明在错误的作用域**，清理函数引用它会 ReferenceError——卸载时抛异常会把整个标签页带走。

## 又被夹具咬了一次（第四次）

分页测试在修好实现后仍然红，因为**夹具模拟了一个现实中不存在的账本**：它的"翻页"每页返回一个**只含那一页的全新数组**，于是窗口长度恒为 1，"无进展"恒为真。

真实窗口是**追加**的。夹具比现实更简单，和夹具比现实更友好一样危险——这是这个项目第四次栽在夹具上（前三次：推断的节点形状、同步 flush 对 promise、单参数 inject）。**夹具必须照抄实测行为，包括它的时序。**

修好夹具后分页立刻收敛，且"第 5 页深埋的调用"这条也通过了。

## 测试

`test/usage-tab.mjs` 保持 **62** 条断言——上一版加的"非 promise / 永不 settle"那几条已经覆盖了两条新路径，本轮真正新增的是**两条夹具修正**（累积式账本）和一个改名（看门狗文案），而没有新增计数。修好夹具后，之前红的五条全部转为绿，包括"第 5 页深埋的调用"。

一句话总结这两轮：**实现和测试各自错了一半，而每一次都是"代理 vs 事实"的同一个错误。**

## English

After v1.6.7 the user refreshed and the tab gained **the right row** — the data path was fully working (name, turn, call count all correct). Only the status line never converged.

Reading the real implementation settled it:

```js
async loadOlder() {
  if (this.openState !== "open" || !this.hasMore || this.loadingOlder) return;
  const events = this.events;
  if (events === undefined) return;
  ...
}
```

**It is not a request that hangs, it is a request that silently does nothing.** A session still opening, events not yet arrived, a concurrent read — any of these makes it return an already-resolved promise. I had been treating "the promise resolved" as "a page arrived", which is the fifth variant of the same mistake this file keeps recording: **mistaking the proxy for the fact** (after node shapes, tool declarations, the `legacy.nodes` projection, and the `props.sessionId` coincidence). This time it was mistaking "the request finished" for "the data arrived".

The shipped trajectory tab had the answer all along: snapshot the window before, `await session.loadOlder()`, and treat "unchanged" as "nothing older". That is now the judgement — the window's length, never the promise. Grew means a real page; unchanged means a no-op, retried once (the session may simply still be opening), and two in a row means stop and say why. The three ways to stop are worded differently because they mean different things to whoever is debugging.

Three real defects the tests caught along the way: the retry counter reset because each attempt wrote state and the effect re-ran with a fresh local counter (fixed by running the whole retry sequence inside one effect and writing state only at its conclusion); the progress baseline was the wrong snapshot, so the retry that actually read a page was judged a no-op (fixed with a ref holding the largest window seen); and the watchdog variable was declared in a scope its cleanup could not reach — a ReferenceError on unmount, which takes the whole tab down.

And the fixtures bit again, for the fourth time: the paging fixture returned a **fresh array holding only that page** on every read, so the window length was pinned at 1 and "no progress" was always true — a fixture modelling a ledger that does not exist. Real windows **append**. A fixture simpler than reality is as dangerous as one friendlier than reality, and this project has now been caught by that four times (inferred node shapes, synchronous flush against a promise, a single-argument inject, and this).
