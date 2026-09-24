# v1.7.1 — 「读取中」改成有截止时间的量，并把诊断印在界面上

[English](#english) | 中文

v1.7.0 的反馈是同一句话，但版本行换成了新的：

```
dsh-skill-router v1.7.0 · 第 0 页 · 读取中
```

**新代码在跑，状态仍然不收敛。** 所以我第四次判断（effect 重入）也不是（唯一）原因。到这一步该停止猜了——问题不在某一个具体回调，而在设计本身。

## 根本设计错误：让"我在读取"依赖回调链不断

`loading` 一直是**只有回调能清掉的布尔值**。清它的路径有好几条（读到页、无进展、超时看门狗、`hasMore` 为假、到上限），但**只要那条链断在任何一环，标签页就永远在撒谎**——而"链条会断"恰恰是这四轮反馈一直在证明的事。

现在它是**截止时间**：

```js
const reading = state.startedAt !== 0 && Date.now() - state.startedAt < LOAD_OLDER_TIMEOUT_MS
```

不需要任何东西触发它变假——**截止时间之后的下一次渲染读一下时钟就够了**。所有原来"清 loading"的地方，改成了"退掉这个截止时间"。

再加一个**心跳**：过期这件事本身是看不见的，除非有东西渲染。这个 hook 里其他所有渲染来源都是事件（账本变化、页解析、effect 写状态），而正在防的失败恰恰是"事件链不再到来"。心跳是唯一不依赖它们的渲染来源，且在没有待办时自己停掉。

## 下一次报告会携带完整诊断

版本行现在多两个数字：

```
dsh-skill-router v1.7.1 · 第 0 页 · 读取中 · 尝试 0/收尾 0
```

- **`尝试 0` + `读取中`** = 翻页 effect **压根没启动过**（这是从外部无法区分的那类事实）；
- **`尝试 1/收尾 0`** = 启动了，但链条断在中途；
- **`尝试 1/收尾 1`** = 正常收尾。

这三个数字就是我这四轮里一直缺的那块证据。

## 这一轮新增的断言

`test/usage-tab.mjs`：69 → **74** 条。核心两条：

- **请求永不 settle、且看门狗被外力清掉**（模拟"回调链断掉"）→ 超过截止时间后必须不再显示「读取中」，并给出停止原因；
- **账本正常完成时，心跳不得误报超时** → 仍报「已读完」。

测试的时钟也补齐了：vm 沙箱原先没有 `Date`，而"过没过期"一旦依赖它，测试就会变成"跑得快就过"——正是这类缺陷的温床。现在 `Date` 与 `setTimeout`/`setInterval` 都由同一个受控时钟驱动。

## 一句诚实的结论

我在这条 bug 上错了四次（数据契约、注入契约、空转语义、重入寿命）。**第五次我没有再断言根因**，而是把"撒谎"这条路从结构上堵死：无论哪条回调断掉，截止时间都会让标签页在 4 秒内说出真相。剩下的不确定性交给界面上的三个数字。

## English

v1.7.0's report was the same sentence with a new version line:

```
dsh-skill-router v1.7.0 · 第 0 页 · 读取中
```

The new code was running and the state still never resolved — so my fourth diagnosis (effect re-entrancy) was not the (only) cause either. That is where guessing had to stop, because the problem is not any single callback. It is the design.

**The design error: "I am reading" depended on a chain of callbacks staying intact.** `loading` was a boolean only a callback could clear, with several such paths (a page arrived, no progress, the watchdog, `hasMore` false, the cap) — and if that chain broke anywhere, the tab lied forever. A chain breaking is exactly what four rounds of feedback kept demonstrating.

So it is now a **deadline**: `reading` holds only while `Date.now() - startedAt < LOAD_OLDER_TIMEOUT_MS`. Nothing has to fire for it to become false — the next render after the deadline simply reads the clock. Everything that used to clear the flag now retires the deadline instead.

Plus a **heartbeat**, because expiring is invisible until something renders, and every other render source in this hook is an event — while the failure being defended against is events that stopped arriving. The heartbeat is the one render source that does not depend on them, and it stops itself when nothing is pending.

**The next report will carry its own diagnosis.** The version line gains two counters: `尝试 0/收尾 0` beside "读取中" means the paging effect never started at all — a fact I could not distinguish from outside; `尝试 1/收尾 0` means it started and the chain broke midway. Those two numbers are the evidence I have been missing for four rounds.

Five new assertions (69 → 74): a request that never settles **with the watchdog cleared from outside** must still stop saying "读取中" past the deadline and name a reason; and a ledger that completes normally must still report "已读完" after the heartbeat has had time to fire. The test clock gained a controlled `Date` as well — once expiry depends on the clock, a test with real time is a test that passes when it runs fast enough, which is precisely how "stuck reading forever" hides.

**Honest conclusion:** I got this wrong four times (data contract, inject contract, no-op semantics, re-entry lifetime). The fifth time I did not assert a root cause at all — I closed the lie structurally, so that whichever callback breaks, the deadline makes the tab tell the truth within four seconds. What remains uncertain is delegated to three numbers on screen.
