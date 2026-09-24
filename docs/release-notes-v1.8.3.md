# v1.8.3 — 让账本自己点名那个调用，而不是我继续问

[English](#english) | 中文

v1.8.2 之后：

```
dsh-skill-router v1.8.2 · 第 42 页 · 已读完 · 可翻页 是
尝试 42/收尾 42 · effect 45 · 心跳 0 · 记录 18 行/17 次调用/10 个技能
```

**顺序修好了**（第 1 轮 → 第 67 轮，正序）。但 `18 行/17 次调用` 还在。

## 这个组合现在是有信息量的

`calls` 在 v1.8.2 已经**从 18 行派生**，所以它等于 17 只意味着一件事：**这 18 行里有 17 个不同的 `callId`，其中一个 `callId` 产生了 2 行。**

而两行同一个 `callId`，只可能是一次调用**点名了多个技能**（`callId::skill` 的去重键不同）。所以：会话里存在一次"一次调用加载两个技能"的记录，它在列表里表现为相邻两行。

我在你贴的清单里找不到它对——所以**不再猜**。既然 `rows > calls` 已经**证明**了多名调用存在，账本应该直接说出是哪一次：

```
… · 记录 18 行/17 次调用/10 个技能 · 多名调用 call_abc[gh-cli|semgrep]
```

格式是 `callId[技能|技能]`。这是从"我描述现象、你复制粘贴、我再猜"转向"证据由界面自己带回来"——上一轮埋点的成功已经证明了这条路的性价比。

## 为什么这不是又一次基于推理的修复

我没有改任何行为逻辑，只加了一个**打印**。如果下次报告的诊断行没有 `多名调用` 字段，那说明我的推导错了（`rows > calls` 不可能在派生计数下发生），而那也是同等有价值的信息——它会指向"派生计数没有生效"而不是"存在多名调用"。

两种结果都能定位问题。这就是埋点与猜测的区别。

## English

After v1.8.2: `记录 18 行/17 次调用/10 个技能`, with the ordering now fixed (turn 1 → 67, ascending).

**The combination is informative now.** `calls` is derived from those 18 rows, so 17 means exactly one thing: the 18 rows hold 17 distinct `callId`s, and one callId produced two rows. Two rows for one callId is only possible when a single call names more than one skill (different `callId::skill` keys), so a multi-name call exists and shows up as two adjacent rows.

I cannot find it in the pasted list, so I am not guessing again. Since `rows > calls` **proves** a multi-name call exists, the ledger can name it: `多名调用 call_abc[gh-cli|semgrep]`, formatted `callId[skill|skill]`. That is the shift from "I describe, you paste, I infer" to "the evidence comes back with the report" — which the last round of instrumentation already proved is worth far more than another round of reasoning.

**Why this is not another inference-based fix:** no behaviour changed, only an extra print. If the next diagnostic line has no `多名调用` field, then my derivation is wrong (it cannot happen under a derived count) — and that is equally valuable, because it points at "the derived count is not in effect" rather than "a multi-name call exists". Both outcomes localise the problem; that is the difference between instrumenting and guessing.
