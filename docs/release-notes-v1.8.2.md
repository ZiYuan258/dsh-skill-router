# v1.8.2 — 一个事实只有一个来源：调用数改为从记录派生

[English](#english) | 中文

v1.8.0 的真机报告里有一处**数字不一致**，我差点放过去：

```
本会话共 17 次技能调用，涉及 10 个技能。
1 … 18      ← 表头说 17 次，列出来 18 行
```

我试了四种能想到的成因（跨页重复投递、`name`/`names` 同时给出、参数形态不同、被 `MAX_NAMES` 截断），全部行不通——每一种都被现有的去重正确处理。压力测试（17 次调用分布在 18 条事件里、跨页重复投递、窗口挤出）也得到自洽的 `17/17/10`。

## 结论：不是某个具体成因，而是两个来源

`files` 由键 `callId::skill` 去重决定，而 `calls` 是**另一个**独立累加的计数器。同一个事实有两个来源，它们就能漂移——而**我无法从外部判定哪一边对**，这正是它值钱的地方。

修法不是去追那一个具体的 off-by-one，而是**取消第二个来源**：

```js
// 从最终记录派生，而不是并行累加
const byCall = {}
for (const file of files) byCall[file.callId] = true
const calls = Object.keys(byCall).length
```

于是两条不变量**在结构上**成立，不再依赖任何人的正确性：

- `calls <= files.length` 恒成立；
- 取等号**当且仅当**没有任何一次调用点名多个技能。

这也顺手消掉了一个隐患：旧写法里"被截断/无可用名字的调用"要靠 `take` 的副作用来保证不计数，现在它不可能被计数——因为不存在那个计数器了。

## 断言

`ledger` 53 → **58**，五条新的全部围绕这条不变量：每次调用一个技能时行数==调用数、一次点名两个技能时调用数<行数、重复投递两者都不增、被截断的名字不影响一致性、没有可用名字的调用不计入。

## English

v1.8.0's live report contained a numeric inconsistency I nearly let pass: the header said 17 calls while the list showed 18 rows.

I tried four plausible causes (a call re-delivered across pages, `name` and `names` given together, differing argument shapes, names truncated by `MAX_NAMES`) and none of them reproduce it — each is handled correctly by the existing dedupe. A stress run (17 calls spread over 18 events, re-delivered across pages, with eviction) also came out self-consistent at 17/17/10.

**So the cause is not a particular off-by-one; it is having two sources for one fact.** `files` is decided by keying on `callId::skill`, while `calls` was a *separate* counter incremented along the way. Two independent answers to questions about the same set can drift — and, crucially, **I cannot tell from outside which one is right**, which is what makes it worth fixing rather than chasing.

The fix removes the second source instead of hunting the discrepancy: `calls` is now derived from the records that survived. Two invariants then hold **structurally**, independent of anyone's care: `calls <= files.length`, with equality exactly when no call named more than one skill. It also retires a latent hazard — the old code relied on a `take` side effect to avoid counting calls whose names were all unusable; now they cannot be counted, because that counter does not exist.

`ledger` 53 → **58** assertions, all five about the invariant.
