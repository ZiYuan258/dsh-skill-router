# v1.9.0 — 功能收尾：账本自我解释，开发用诊断下线

[English](#english) | 中文

埋点又一次一次到位：

```
多名调用 call_01_FXMgObOiouEzJcHwYSoL8447[code-review-and-quality|gh-cli]
```

**一次 `skill_load` 在第 5 轮同时加载了 `code-review-and-quality` 与 `gh-cli`。** 所以列表里第 6、7 行并排出现，`17 次调用 / 18 行` **两边都是对的**——不是重复计数，不是 off-by-one，是一次调用点名了两个技能。

## 那就别让用户自己去对账

这个组合本身是对的，但**读起来像矛盾**——我为此绕了一整轮。修法不是在文档里解释，而是让界面自己说：

```
本会话共 17 次技能调用，涉及 10 个技能。其中 1 次调用一次点名了多个技能，故按技能名分行列出；
```

那句话**只在两者确实不等时出现**（有断言钉住两个方向）。

## 开发用诊断下线

`尝试/收尾 · effect · 心跳 · 记录 N 行` 那一行已经完成使命：它把"代码有没有在跑"变成了可粘贴的事实，并指出了守卫那一行。现在账本经真机验证可用，界面上只留判读结论：

```
dsh-skill-router v1.9.0 · 第 43 页 · 已读完 · 可翻页 是
```

（计数仍在代码里、由测试守着，只是不再占据界面。）

## 顺手修掉一个一帧级的谎话

新增的表头断言让一条旧缺陷现形：**当首屏快照已经是 `hasMore: false`（账本完整）时，标签页仍会先显示"正在读取更早的记录…"，直到 effect 把截至时间退掉。**

明明已经知道读完了，却说还在读——哪怕只有一帧，也是这个标签页存在的意义所禁止的那类话。现在 `reading` 同时看**截至时间**和**窗口自己的答案**：`hasMore` 为假就不再声称在读取。

## 收尾状态

| 能力 | 状态 |
|---|---|
| 读到本次会话**全部**技能调用 | ✅ 43 页回填，`已读完` |
| 计数正确（调用数 / 技能数 / 行数） | ✅ 三者互不矛盾，行数与调用数差异有解释 |
| 会话顺序（不是读到顺序） | ✅ 第 1 轮 → 第 67 轮 |
| 实时尾部（新调用立刻出现） | ✅ 有断言 |
| 窗口挤出后不丢记录 | ✅ 有断言 |
| 读不到账本时只说这一件事 | ✅ 三种缺座位情形各有文案 |
| 零模型 token | ✅ 纯客户端渲染 |

## English

The instrumentation paid off again, in one shot: `多名调用 call_01_FXMgObOiouEzJcHwYSoL8447[code-review-and-quality|gh-cli]` — **one `skill_load` at turn 5 named both skills**, so rows 6 and 7 belong to the same call and `17 calls / 18 rows` are **both correct**. Not double counting, not an off-by-one: a single call naming two skills.

**So the user should not have to reconcile it.** The combination is right but *reads* like a contradiction — which cost a full round trip. The fix is not an explanation in the docs but the header saying so itself (`…其中 1 次调用一次点名了多个技能，故按技能名分行列出；`), and only when the two numbers actually differ (asserted in both directions).

**The developer diagnostics retired.** `尝试/收尾 · effect · 心跳 · 记录 N 行` did its job: it turned "is the code even running" into a pasteable fact and pointed at the guard line. With the ledger now verified live, the UI keeps only the verdict: `dsh-skill-router v1.9.0 · 第 43 页 · 已读完 · 可翻页 是`. The counters remain in the code, guarded by tests, no longer occupying the interface.

**And one one-frame lie fixed on the way.** The new header assertion exposed it: when the very first snapshot already reports `hasMore: false`, the tab still said "正在读取更早的记录…" until an effect retired the deadline. Claiming to still be reading a history already known to be complete is exactly the kind of sentence this tab exists to prevent, even for a frame. `reading` now consults the window's own answer as well as the deadline.

**Where it stands:** full history read (43 pages, `已读完`), counts mutually consistent with the row/call difference explained, session order rather than arrival order, live tail, records surviving eviction, honest copy for all three missing-seat cases, and zero model tokens.
