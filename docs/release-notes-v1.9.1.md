# v1.9.1 — 审查发现的两处结构性风险：滑窗判据，与"读到的页"没有当场记账

[English](#english) | 中文

一次外部审查指出 1.9.0 的分页判据可能绑定了一个未经充分证明的假设。**是对的**，而且比指出的更深一层。

## 缺陷一：用"窗口变长"判断"读到了更早的历史"

分页的进展判据原来是：

```js
after.entries.length > seenRef.current   // 变长才算读到一页
```

而 README 自己写着窗口**有上限**（实测约 1664–1900，见过 3336 → 1664 回落）。有界窗口可以是**滑窗**：长度不变，内容整体向更早方向移动。那种情况下这一页会被判成"没进展"，两次之后标签页就停在 `第 0 页 · 无进展停止`，把"放弃"说成了"没有"。

修法是换判据——**窗口里最老那条的 `seq` 是否变小**：

```js
const oldestAfter = oldestSeqOf(after.entries)
const reachedOlder = oldestAfter !== undefined && oldestAfter < oldestRef.current
```

`seq` 变小只可能是"拿到了更早的历史"，长度只是次要信号（实时追加也可能让长度变长）。**测试先写，先复现**：构造容量恒定、每页整体前移的真实滑窗，修复前它确实报 `无进展停止`。

## 缺陷二（更深）：读到的那一页没有当场记账

写测试时才发现的：`seedRef`（累积器）**只由 `push()` 写**，而 `push()` 只在订阅通知时跑。一次会话里它可能只跑一两次。

于是某条记录可以这样消失：`loadOlder()` 让它进入窗口 → 当前这一帧渲染出了它 → 在下次通知之前它随窗口滑出 → **累积器从未见过它**。

真机滑窗下这不再是竞态，而是常态。修法是**每读到一页就当场并入累积器**：

```js
seedRef.current = buildLedger(after.entries, { previous: seedRef.current, hasMore: after.hasMore })
```

数据的字节只在那一刻完整地在手里，所以"读一页"必须在那一行完成记账。

**这个测试是纯靠推理写不出来的**：判据和记账都得对，少一个都过不去。

## 身份模型：事件身份，而不是配对 id

审查的另一条：`callId` 更像是工具调用的**配对 id**，不该假定它是会话事件的唯一身份。

框架声明支持这个判断：

```ts
export type SessionEvent<T extends SessionEventType> = {
  [K in SessionEventType]: { type: K; seq: SessionSeq; time: number; data: SessionEventMap[K] }
}[T]
```

`seq` 在**每个**事件的信封上，契约保证唯一，而一条 `tool/call` 事件正是一次调用。`callId` 没有这个保证——理论上两条不同调用可以共用它，后果是**静默少算**（两次真实调用并成一行）。

现在：行键 `eventKey::技能名`，调用数按 `eventKey` 分组；`eventKey` 优先取 `seq`，没有数字 `seq` 时才退回 `(窗口内位置, callId)`。`seq` 同时仍是排序依据。

新增一条断言覆盖上游边界：**两条不同事件共用同一 `callId` 时必须算两次**。

## 语义变化：不再跳过缺 `callId` 的调用

身份不再依赖 `callId`，所以一条没有 `callId` 的 `tool/call` 事件照常入账（旧行为是跳过）。这是行为变化，断言已相应更新——旧行为是"没有配对 id 就不敢记账"，而事件本身已经足够标识自己。

## 其他

- `buildLedger` 自称 pure/total，却在累积路径里直接写 `carried.seq`。改成构造副本——**注释与实现不一致本身就是缺陷**，哪怕当前无害。
- `multiCalls` 原本重算了一遍（同一个事实两个来源，正是漂移的温床），改为复用已算好的结果。
- 夹具修正：默认 `seq` 原来对所有事件都是 1，于是"两个不同 `callId`"在事件身份上成了同一条事件。真实 `SessionSeq` 是单调计数器，夹具现在照抄这一点。

断言 `ledger` 58 → **59**，`tab` 82 → **87**，20/20 全绿。

## English

An external review flagged that 1.9.0's paging judgement might rest on an unproven assumption. **It did** — and the problem ran one level deeper than reported.

**One: "the window grew" as a proxy for "older history arrived".** The README itself records that the window is bounded (~1,664–1,900 observed, with a 3,336 → 1,664 reset). A bounded window can **slide**: constant length, content moving older. A genuinely successful page was then judged a no-op, two of those ended paging at `第 0 页 · 无进展停止`, and the tab reported "gave up" as "nothing there". The judgement is now the **oldest `seq` in the window decreasing** — that can only happen by acquiring older history; length is kept as a secondary signal. Test first, and it reproduced the stall before the fix.

**Two, deeper: the page that was read was never booked.** Writing that test exposed it: `seedRef` was written only by `push()`, which runs only when the source notifies — sometimes once in a session. So a record could arrive, render for one frame, slide out of the window before the next notification, and **never reach the accumulator at all**. Under a true sliding window that is the normal case, not a race. Every page is now folded in at the moment it is read, because that is the only line guaranteed to run while the bytes are still in hand. The test cannot be passed by either fix alone.

**Identity: the event, not the pairing id.** `SessionEvent` declares `seq: SessionSeq` on every event's envelope, so it is contractually unique, and one `tool/call` event is exactly one call. `callId` pairs a call with its result and carries no such guarantee; deduping on it held on every session observed, but the failure would be silent — two real calls collapsing into one row and a quietly low count. Rows are now keyed `eventKey::skill` and the call count groups by `eventKey`, with `seq` preferred and `(position, callId)` as the fallback when an event carries no numeric `seq`. A new assertion covers the upstream edge: two different events sharing one `callId` must count as two.

**One behaviour change:** events without a `callId` are no longer skipped, since identity no longer depends on it. Also fixed: `buildLedger` documented itself as pure while writing into a caller's record (a copy is built now — a comment that contradicts its code is a defect even when harmless), and `multiCalls` was derived twice, which is precisely the two-sources-for-one-fact shape that drifted before.

Assertions: `ledger` 58 → **59**, `tab` 82 → **87**. 20/20 green.
