# v1.15.1 — 会话创建时间闸：重启不是实验 reset

[English](#english) | 中文

v1.15.0 把分臂单位改成了会话，但还剩一个**协议级**污染源。这一版只加一道闸，不改任何算法。

## 剩下的污染：跨进程，而不是跨回合

`firstEligibleSeen` 是**插件进程内存**，重启 DSH 即清空。而 DSH 的 session 是**持久、可 resume** 的：

```
实验开始前   session A 已经被注入过 skill-router 提示
     ↓
重启 DSH     firstEligibleSeen 清空
     ↓
继续用 session A
     ↓
它的下一个 HIGH  →  firstEligible = true   ← 但 A 已有干预历史
```

**污染没有消失，只是从跨回合变成了跨进程。** 我先前把"重启 DSH"写进协议，那是**错的**——真正的 reset 是**新建会话**。

尤其这个干预本来就是 durable session history（上一版已用真实投影证实），所以这条必然成立。

## 闸门：`sessionCreatedAt >= T0`

插件现在在每条记录上写 `sessionCreatedAt`，从 `session.header.createdAt` 取。真机实测那个字段是 **epoch 毫秒数字**（`1790323044128`），所以：

**归一化成 ISO 再落盘。** 原因是可比的硬要求——日志里若混着 `1789…` 和 `"2026-09-27T…"`，它们**无法排序**，`--since` 会静默给出错误结果。

**拿不到就是 `null`，不伪造时间。** 一个猜出来的创建时间会**恰好放行这道闸要排除的那些会话**——失败方向必须是"可见"，不能是"看起来合理"。

读数脚本把它当准入条件：

```
主指标 = 唯一 sessionKey
       ∩ firstEligible === true
       ∩ paired
       ∩ sessionCreatedAt >= T0
       ∩ armViolations === 0
       ∩ duplicateFirsts === 0
       ∩ indexRows 单一
```

**创建时间无法确认的会话一律排除**（不放行）。被排除的分两类报出（T0 前创建 / 时间未知），**但不从探索性与全量里藏掉**——数据不该被隐藏，只是不能进主指标。

没给 `--since` 时闸门是关的，报告**明确报警**。

## 测试

读数侧 7 条：T0 后新建的进主指标、T0 前创建的被排除、时间未知的被排除、闸门开/关标记、闸门关时三个会话都进（证明它真的关着）、以及**被排除的会话仍出现在全量里**。

插件侧 3 条：`sessionCreatedAt` 以 ISO 落盘（不是 epoch 数字）、等于夹具的毫秒时间、拿不到时记 `null`。

## 我又踩了一个夹具坑（同类第三次）

```js
const agentFor = (id, createdAt = 1789000000000) => …
agentFor('session-no-birth', undefined)   // ← undefined 触发默认参数，拿到的不是"缺失"
```

于是"测拿不到创建时间"的用例其实拿到了默认值——**夹具自己把被测场景换掉了**。改成显式传 header：

```js
const agentFor = (id, header) => …   // 传 { cwd: workspace } 才真的是"没有 createdAt"
```

这和前几轮的夹具错误（session id vs 哈希 key、`injected` 两侧不一致）**是同一个模式**：夹具与被测语义不一致，会造出看起来像产品缺陷的失败。已写进测试注释。

## 冻结清单（这一版之后不再动）

```
固定：skill index = 1025 · discovery algorithm · tokenizer · common-token threshold
      dedupe · HIGH threshold · hint wording · session-level arm · firstEligible 定义
只观察：HIGH relevance · treatment → skill_search · control → skill_search
        skill_search → skill_load
```

## English

v1.15.0 moved the arm to the session, but one **protocol-level** contamination source remained. This release adds a single gate and changes no algorithm.

**The remaining contamination is across processes, not across turns.** `firstEligibleSeen` is plugin process memory and is empty after a DSH restart, while a DSH session is durable and resumable. A session that already received a hint before the experiment can therefore resume after the restart and present its next HIGH opportunity as "this session's first". The contamination did not disappear — it moved from across turns to across processes. Writing "restart DSH" into the protocol was **my error**: the real reset is **a new session**, especially since the intervention is durable session history by construction (proven from a real projection in the previous version).

**The gate is `sessionCreatedAt >= T0`.** The plugin records the creation time from `session.header.createdAt`, which is an **epoch-millisecond number** on this machine, and **normalises it to ISO before writing**, because a log mixing `1789…` with `"2026-09-27T…"` cannot be ordered at all and `--since` would silently produce a wrong window. An unparseable value is written as `null` rather than a fallback timestamp: a fabricated creation time would silently admit exactly the sessions the gate exists to exclude, so the failure direction must be visible, never plausible.

The readout applies it as an admission condition on top of the existing ones (unique session, first eligible, paired, no arm violation, no duplicate first, single `indexRows`). **A session whose creation time cannot be established is excluded** rather than admitted on a guess; exclusions are reported in two classes and are not hidden from the exploratory and pooled numbers, which stay visible as reference. With no `--since`, the gate is off and the readout says so explicitly.

**Tests**: seven on the readout side (post-T0 admitted, pre-T0 excluded, unknown excluded, both gate states, all three sessions admitted when the gate is off — proving it really is off — and excluded sessions still present in the pooled numbers), and three on the plugin side (ISO rather than epoch on disk, equal to the fixture's milliseconds, and `null` when unavailable).

**And I tripped over a fixture the same way for the third time**: `agentFor(id, createdAt = 1789…)` called with `undefined` triggers the *default parameter*, so the "creation time unavailable" case was silently handed a default value — the fixture replaced the very scenario under test. It is now `agentFor(id, header)` so that `{ cwd: workspace }` genuinely means "no `createdAt`". This is the same pattern as the earlier fixture errors (a session id where a hashed key was required; `injected` inconsistent across two fixtures): **a fixture that disagrees with the semantics under test manufactures failures that look like product defects.** It is recorded in the test file.

**The freeze list, after this version**: skill index at 1025, the discovery algorithm, the tokenizer, the common-token threshold, the dedupe, the HIGH threshold, the hint wording, the session-level arm, and the `firstEligible` definition all stay as they are. What gets observed is HIGH relevance, treatment → `skill_search`, control → `skill_search`, and `skill_search` → `skill_load`.
