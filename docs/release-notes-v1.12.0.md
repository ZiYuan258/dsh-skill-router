# v1.12.0 — 只改一个变量：HIGH 注入 + 每回合工具计数

[English](#english) | 中文

这一版**只做两件事**，而且是为同一个因果假设服务的：**Agent 不是不会用技能，而是从没人告诉它有哪些技能值得考虑。**

## 开注入之前的实测状态

```
273 个回合 / 13 个会话
skill_search 的输出特征总数: 4    ← 其中 2 次是诊断时我自己主动调的
有调用证据的会话: 1 / 13
平均每回合检索次数: 0.0147
```

而同一个会话的 `contextTimeline` 投影显示，技能正文只注入过 **2 次**，且都是 DSH 自带的（`cordis-plugin-development`、`editing-cordis-compositions`）——那是目录机制，不是库。

**所以问题不在检索，在触发：库（1028 条）从未被检索过。**

## 改动一：`tier === HIGH` 时把候选摆到模型面前

```
Maybe relevant skills for this task: semgrep (name, whenToUse); code-review (name).
Load any that fit with skill_load, or ignore this and continue without one.
```

**只有名字与命中字段，没有描述正文。** 并且明确写着"可以都不用"——这一层负责发现，选择仍在 Agent 手里。

### 为什么只开 HIGH（而不是把 tier 系统一次调完）

测一个因果假设需要**只改一个变量**。所以本版检索侧**一行没动**：严格 AND、tokenizer、tier 阈值全部原样。这样"Agent 开始搜了"才能归因到提示，而不是"同时改了两处，不知道哪一项起作用"。

### 成本对照（这是值得一试的理由）

| 每轮已付出 | token |
|---|---|
| 常驻技能目录 | ~3,238 |
| 三个工具 schema | ~1,001 |
| **注入 5 个候选（本版新增）** | **329–341 字节 ≈ 91–95（真库实测，不是估算）** |

### 两处取证过的实现细节

**放进 `decision.messages`，不是 `agent.inject()`。** `preStep` 在派发瀑布**之前**就调用了 `inbox.claim()`，`inject()` 的东西要等到**下一步**才被取走——而这一层必须在第一步生效。

**注入的消息带唯一 `id`。** 形状是照框架自己的 `createUserMessage` 抄的，不是猜的：

```js
{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'skill-router' } }
```

`source` 是开放的 `{ kind }` 标签（官方的 hooks 插件写自己的名字，kind 不是枚举）；`id` 不是装饰——框架消息总是带一个，两条注入共享 id 会让下游无法区分。测试里有一条断言专门盯它。

## 改动二：每回合的工具调用计数

**这个问题的答案不可能在 `step === 1` 拿到**——那一刻谁也不知道这一回合会不会去搜。所以调用从会话事件流（`session/event` 里的 `tool/call`）累积，在回合结束后结算，写成第二类记录：

```json
{"at":"…","kind":"turn-calls","turn":3,"tier":"HIGH","injected":true,
 "skillSearchCalls":1,"skillLoadCalls":1,"skillRefCalls":0,"residentSkillCalls":0,"otherToolCalls":7}
```

只记**计数**：没有工具参数、没有技能正文、没有用户原文。原生 `skill` 工具（常驻目录）**单独记**——"用了常驻技能"和"用了库"是两个不同的问题。

### 我没有用 `agent/turn-stopping`，因为它在这个版本里不存在

原本打算挂在那里，先查了再写：**`agent/turn-stopping` 在 `0.1.7-rc.2` 里全盘 0 命中**。这个 harness 只声明 `turn/start` 与 `turn/end`，且没有暴露给插件的回合结束瀑布。

如果按计划写下去，那会是一个**永不执行的埋点**——而这个仓库已经为"跨接缝写代码但从未验证它执行"栽过四次。

实际做法：回合计数在**下一个回合的第一步**结算。因中止/崩溃而未结算的回合，其数字是**丢失**而不是错记——对一次测量来说这是正确的失败方向。

## 测试：旧的干跑测试已删除，新增 32 条断言

`test/discovery-dry-run.mjs` 里有两条断言是"干跑不改变决策"和"`injected: false`"。**它们现在会红，而且应该红**——行为按设计变了，一个不会因为行为改变而变红的测试等于没有在测行为。

新文件 `test/discovery-injection.mjs`（32 条）覆盖了旧文件的全部内容，另加：

- 注入只发生在 `tier === HIGH` 且 `step === 1`（`step=2` 与 NONE 都不注入）；
- 注入消息形状合法、带**唯一** id、两次注入 id 不同、原文消息未被改动；
- 遥测里的 `hintBytes` 是**实测**值（与真实提示字节数一致），未注入时为 0；
- 工具调用按回合计数、三个技能工具各记、原生 `skill` 单独记、其它工具只汇总、**计数按回合归零**。

写这个测试时我自己踩了一个坑：把 tool call 投递在 flush **之后**，于是一整轮计数被记到下一回合——测试显示"计数为 0"，看起来像产品缺陷。修的是测试的时序，不是产品。**测试自己制造假象，比测试漏测更费时间**，这一条我记下了。

## 这一版**不做**的事（一次只验证一个变量）

| 不做 | 原因 |
|---|---|
| 改 `skill_search` 的严格 AND | 实测 `systematic debugging failing test root cause` 归零、`debugging` 命中 21 条——真实的第二瓶颈，但同时改就无法归因 |
| 中文 aliases / 双语 `whenToUse` | 24.4% 的回合是 `no-searchable-token`，属于库/索引语言覆盖，不是触发问题 |
| 砍常驻目录的 3.2k token | "没有 skill 工具调用" ≠ "常驻技能没被使用"——它们本来就在上下文里，可能以潜在知识的形式起作用 |
| embedding | 与这个项目的产品哲学（本地、零依赖、可解释、确定性）不符 |

## 下一步看什么

三个指标，按因果顺序：**① HIGH 提示后 Agent 是否开始 `skill_search`** → **② 搜到之后是否真的 `skill_load`** → **③ 加载的技能与任务是否真的相关**（人工抽样）。

① 若明显上升，说明假设成立，那时才值得放宽到 MEDIUM；② 若高而 ① 低，问题在提示的措辞或位置；③ 若低，才该回头改 `scoreRow` 的权重。

## English

This release does **two things**, both in service of one causal hypothesis: **the agent does not fail to use skills — it is never told which ones are worth considering.**

**The measured state before this.** Across 273 turns in 13 sessions, the library was searched essentially never (4 output signatures total, 2 of them the diagnostic calls I made myself). The session's own `contextTimeline` projection shows skill *bodies* injected twice, both DSH built-ins — the catalog mechanism, not the library. So the failure is at **trigger**, not retrieval: 1,028 skills were never looked at.

**Change one: put HIGH candidates in front of the model.** Names and matched fields only, never descriptions, and the hint says explicitly that ignoring it is fine — this layer discovers, the agent chooses. Only HIGH (`nameHits > 0`, at least two tokens landed), because testing a causal claim needs **one changed variable**: the strict-AND policy, the tokenizer and the tier thresholds are all untouched, so a behaviour change is attributable to the hint. The cost is why it is worth trying: the resident catalog is ~3,238 tokens per turn and the three tool schemas ~1,001, while a five-name hint measures **329–341 bytes ≈ 91–95 tokens** on the real library — measured, not estimated, and recorded as `hintBytes` in every record. (The first figure I wrote, ~57, came from my own short sample names; the real hint is larger because each name carries its matched fields.)

Two details verified rather than assumed: it goes into `decision.messages` (not `agent.inject()`, which is claimed at the *next* step because `preStep` claims the inbox before dispatching the waterfall), and the injected message carries a **unique `id`** in the shape the framework's own `createUserMessage` produces — `{ id, role, content, source }`, copied rather than guessed, with an assertion because two injections sharing an id would be indistinguishable downstream.

**Change two: count tool calls per turn.** That question cannot be answered at `step === 1` — nobody yet knows whether the turn will search — so calls accumulate from the session event stream and settle when the turn is over, as a second record joined by `turn`: counts only, no arguments, no skill bodies, no user text, with the native `skill` tool counted separately because "used a resident skill" and "used the library" are different questions.

**I did not use `agent/turn-stopping`, because it does not exist here.** I checked before writing it: zero hits anywhere in `0.1.7-rc.2`. This harness declares `turn/start` and `turn/end` and exposes no end-of-turn waterfall to plugins — writing it as planned would have been an instrumentation hook that never runs, which this repository has been burned by four times. Counting therefore settles at the **next** turn's first step; a turn abandoned mid-flight loses its numbers rather than misattributing them, the right failure direction for a measurement.

**The old dry-run test is gone, and 32 new assertions replace it.** Its two assertions — "the decision is untouched" and "`injected: false`" — go red now, and **should**: the behaviour changed by design, and a test that cannot go red when behaviour changes is not testing behaviour. While writing the new one I made my own mistake worth recording: I delivered tool calls *after* the flush, so a whole turn's counts landed in the next turn and the test reported counters stuck at zero — it looked like a product defect. The fix was to the test's ordering, not the product. A test that manufactures its own false evidence costs more than a test that merely misses something.

**What this version deliberately does not do**, one variable at a time: the strict-AND retrieval policy (a real second bottleneck — `systematic debugging failing test root cause` returns nothing while `debugging` returns 21 — but changing it now would make the result unattributable); Chinese aliases or a bilingual `whenToUse` (24.4% of turns are `no-searchable-token`, which is index language coverage, not a trigger problem); trimming the 3.2k-token resident catalog (no `skill` tool call is not the same as the resident skills going unused — they are already in context); and embeddings, which contradict this project's local, dependency-free, explainable, deterministic philosophy.

**What to watch**, in causal order: ① does the agent start calling `skill_search` after a HIGH hint; ② does it then actually `skill_load`; ③ is the loaded skill relevant (manual sampling). If ① rises, the hypothesis holds and relaxing to MEDIUM becomes the next question. If ② is high while ① is low, the hint's wording or placement is wrong. If ③ is low, the answer is in `scoreRow`'s weights.
