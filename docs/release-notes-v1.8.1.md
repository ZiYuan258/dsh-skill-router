# v1.8.1 — 它能用了。以及真机报告暴露的一个顺序缺陷

[English](#english) | 中文

刷新后的界面：

```
技能调用清单
本会话共 17 次技能调用，涉及 10 个技能。

1  写作·规划 (writing-plans)   skill_load  第 31 轮
...
已读到本会话最早一条记录，上面的数字是完整的。
```

而底部那行版本号说明了一切：

```
dsh-skill-router v1.8.0 · 第 42 页 · 已读完 · 尝试 42/收尾 42 · effect 46 · 可翻页 是
```

**`尝试 42/收尾 42`、`第 42 页`、`已读完`** —— 翻页真的跑了，一路回读到会话最早一条，还翻出了此前完全看不到的更早记录（第 1 轮、第 5 轮、第 26 轮那些技能调用）。这是这个标签页第一次真正完成它的工作。

## 顺带暴露的缺陷：列表是倒序的

那份报告里 `第 31 轮` 排在最前，`第 5 轮` 排在最后。原因是我的累积策略：事件本来就以"最新在前"到达（第 0 页是近端），而更早的页是**前插**进来的，于是"读到的先后"恰好是**会话顺序的反面**。

修法：每条记录带上事件自己的 `seq`（会话的单调计数器），按 `seq` 升序排列。插桩顺序无关紧要，列表读起来就是时间线。缺 `seq` 的记录排在最后，而不是插到最前。

这个缺陷**只有真机能发现**：测试里的夹具页数少、又是我自己按顺序造的数据，永远造不出"页到达顺序与会话顺序相反"这件事。这是这个项目第六次栽在夹具与现实不一致上——而这次是**真实使用**替我发现的，不是测试。

## 诊断行拆成两行

判读用的字段留在结论行：

```
dsh-skill-router v1.8.1 · 第 42 页 · 已读完 · 可翻页 是
尝试 42/收尾 42 · effect 46 · 心跳 0 · 记录 18 行/17 次调用/10 个技能
```

这样引用结论时不必把计数器一起带上，而需要排查时它们仍在。

## 断言

`ledger` 48 → **53**（新增 5 条钉住顺序：页 0 是最新在前、回填后按会话顺序、同 seq 稳定、缺 seq 排最后），`tab` 78 → **80**（结论行必须写明"可翻页"、诊断字段齐全）。

## English

The refreshed tab:

```
本会话共 17 次技能调用，涉及 10 个技能。
1  写作·规划 (writing-plans)   skill_load  第 31 轮
...
已读到本会话最早一条记录，上面的数字是完整的。
```

and the version line explains it:

```
dsh-skill-router v1.8.0 · 第 42 页 · 已读完 · 尝试 42/收尾 42 · effect 46 · 可翻页 是
```

**42 pages, 42 attempts, 42 conclusions, "已读完"** — paging actually ran, back to the oldest record in the session, surfacing skill calls from turns 1, 5 and 26 that had been invisible before. This is the first time the tab has done its job.

**The defect the same report exposed:** the list was in reverse. Turn 31 sat above turn 5, because events arrive newest-first (page 0 is the recent end) while older pages are **prepended**, so insertion order is the reverse of the session's. Each record now carries the event's own `seq` — the conversation's monotonic counter — and the list sorts ascending by it, so it reads as a timeline regardless of the order pages arrive in. Records with no numeric `seq` sort last rather than jumping the queue.

**Only a live session could find this one.** The fixtures hold few pages, in the order I wrote them, so they can never produce "pages arrive in the opposite order to the session" — the sixth time a fixture has disagreed with reality here, and this time real use found it instead of a test.

**The diagnostics moved to their own dimmer line**, leaving the verdict readable on its own: `dsh-skill-router v1.8.1 · 第 42 页 · 已读完 · 可翻页 是`, with `尝试 42/收尾 42 · effect 46 · 心跳 0 · 记录 18 行/17 次调用/10 个技能` beneath it. Quoting the verdict no longer drags the counters along, and the counters are still there when something needs debugging.

Assertions: `ledger` 48 → **53** (page 0 is newest-first, backfill reorders to session order, equal `seq` stays stable, missing `seq` sorts last), `tab` 78 → **80**.
