# v1.8.0 — 根因：`loadOlder` 在会话上，不在账本上；四次修复修的都是死代码

[English](#english) | 中文

v1.7.2 只加了埋点、不改行为。一行反馈就把答案交了出来：

```
dsh-skill-router v1.7.2 · 第 0 页 · 超时停止 · 尝试 0/收尾 0 · 挂载 3(#1) · effect 0 · 心跳 1
```

## `effect 0` 是决定性的

翻页 effect 的第一行是守卫，我加的计数器在第二行——所以 `effect 0` 意味着**守卫在第一行就把它挡住了**，指针从未进入函数体。三条守卫只有一条可能：

```js
if (usable === false || typeof source.loadOlder !== 'function') return undefined
```

**这个 eventSource 上没有 `loadOlder`。**

然后框架自己的类型声明给出了答案，不需要再猜：

```ts
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: SessionFace        // ← loadOlder(): Promise<void> 在这里
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
```

账本上只有 `getSnapshot` 和 `subscribe`。**翻页方法在会话脸上**（`ISession` 的 `loadOlder()`），这正是官方 trajectory 标签页写 `session.loadOlder()` 的原因——那份代码我读过、还引用过它的"比对窗口"技巧，却始终没注意它调用的是**另一个对象**。

## 代价：四次修复，一条从未执行的代码路径

| 版本 | 我"修"了什么 | 实际效果 |
|---|---|---|
| v1.6.5 | 改成读 `eventSource` 的 entries | ✅ 这条是真的（取数走对了对象） |
| v1.6.7 | 看门狗、非 promise、`hasMore` 折叠 | ❌ 在死代码里 |
| v1.6.8 | 以窗口是否移动为判据 | ❌ 在死代码里 |
| v1.7.0 | 尝试寿命与 effect 解耦（重入） | ❌ 在死代码里 |
| v1.7.1 | `loading` 改成有截止时间的量 | ⚠️ 只对"状态永不说谎"有效 |
| **v1.8.0** | **改用 `session.loadOlder()`** | ✅ **真正的修复** |

前四次之所以看起来"有道理"，是因为我在读**自己写的代码**，而它内部自洽。**我从未验证过被调用的那个方法是否存在。**

## 修法

- `inject` 同时交出 `source` 和 `session`；
- 守卫改成 `canPage`（`typeof session.loadOlder === 'function'`）；
- 调用改成 `session.loadOlder()`，仍然以**窗口是否变长**为判据（这个技巧本来就是从 trajectory 抄的，现在抄完整了）；
- 拿不到会话脸时**不假装**：新增 `capped` 状态，文案是"这个会话还有更早的记录，但当前窗口没有给出向后读取的入口"——不是"读完了"，也不是"永远正在读取"；
- 版本行增加 `可翻页 是/否`。

## 测试桩也在犯同一个错

夹具一直把 `loadOlder` 放在 **source** 上——**和产品调用的错误对象完全一致**。这就是为什么 78 条断言全绿而翻页从未发生：**桩和 bug 达成了一致**。

现在夹具严格按框架声明：source 只有 `getSnapshot` 与 `subscribe`，`loadOlder` 在 session 上；并新增断言把这个形状钉死（"翻页调用的是会话上的 loadOlder，而不是账本上的"）。

顺带修掉一根同源的刺：`ObservableSnapshot` **没有** `unsubscribe`，取消是 `subscribe()` 的返回值。桩之前给了这个方法，产品靠 `typeof` 守卫没炸，但那条守卫其实一直是空转。

## 教训（给未来的自己）

1. **验证被调用的东西存在**——不是验证"我的代码内部自洽"。四次修复都在自洽的死代码里。
2. **夹具必须照抄框架的声明**，否则它会和 bug 站在同一边。这已经是第五次栽在夹具上。
3. **埋点比推理便宜**。我做了四次推理，第四次之后才按调试规程加埋点，而埋点一次就给出了答案。我应该在第一或第二次失败后就加。

## English

v1.7.2 added instrumentation and changed no behaviour. One report handed over the answer:

```
尝试 0/收尾 0 · effect 0 · 心跳 1
```

**`effect 0` is decisive.** The paging effect's first line is a guard and the counter sits on the second — so the guard returned before the body ever ran, and of its three conditions only one was possible: `typeof source.loadOlder !== 'function'`. **This eventSource has no `loadOlder`.**

The framework's own declarations then settled it without guesswork: `SessionEventSource` is `ObservableSnapshot<SessionEventWindow>`, whose entire surface is `getSnapshot()` and `subscribe()`; `loadOlder(): Promise<void>` is on the session face (`SessionFace extends ISession`). That is why the shipped trajectory tab writes `session.loadOlder()` — code I had read, and whose window-comparison trick I had even copied, without ever noticing it called a **different object**.

**Four fixes, one code path that never executed.** v1.6.7 (watchdog, non-promise, `hasMore` folding), v1.6.8 (judge by window movement) and v1.7.0 (decouple attempt lifetime from the effect) all edited code the guard never let run. They looked reasonable because I was reading my own code, which was internally consistent — and **I never verified that the method being called existed**.

**The fix:** `inject` hands over both `source` and `session`; the guard becomes `canPage`; the call becomes `session.loadOlder()` while still judging by whether the window grew; a missing session face is reported as the limitation it is (a new `capped` state: "this session has older records but the current window offers no way back"), never as completion and never as an endless read; and the version line gained `可翻页 是/否`.

**The fixture was making the same mistake.** It had always put `loadOlder` on the **source** — the exact wrong object the product called it on. That is why 78 assertions could be green while no paging ever happened: the fixture agreed with the bug. It now follows the framework declaration exactly, with an assertion pinning the shape, plus a same-rooted fix: `ObservableSnapshot` has no `unsubscribe` either — cancelling is the return value of `subscribe()` — so the fixture had been handing over a method the product's `typeof` guard was silently ignoring.

**For the future:** verify that the thing being called exists, rather than that my code is internally consistent; keep fixtures faithful to the framework's declarations, or they take the bug's side (this is the fifth time a fixture has done that here); and instrument earlier — four rounds of inference gave nothing that one round of instrumentation did not.
