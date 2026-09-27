# v1.14.0 — 随机分臂：把"未注入"换成真正的对照组

[English](#english) | 中文

这一版**不改 discovery 算法**，只改实验设计本身。因为先前那个实验问不出因果问题。

## 问题：`notInjected` 不是对照组

读数脚本原来这样算对照：

```js
notInjected = paired.filter((t) => t.injected !== true)
```

而注入与否由 `tier` 决定（`INJECT_TIERS = new Set(['HIGH'])`），所以两组在**构造上**就是不同的任务总体：

```
注入组： 做 Semgrep 安全审计     → 候选明确 → injected=true
"对照"： 今天天气怎么样          → 没有候选 → injected=false
```

两组的搜索率之差**说明不了提示的作用**——任何差异都可以归因于任务本身不同。这不是统计偏差，是**无法回答因果问题**。

## 改法：`HIGH` 之后随机分臂

真正要回答的问题窄得多：

> **在系统已经认为候选质量很高的同一类任务里，仅仅把候选摆出来，会不会改变 Agent 的行为？**

```
HIGH opportunity
      ↓
sha256(sessionKey + ":" + turn) → 约 50/50
   ↙                    ↘
control               treatment
不注入                 注入提示
```

遥测两类记录都新增 `arm` 字段（`treatment` / `control` / `not-eligible`）。**`arm` 是分配，`injected` 是实际发生的事**——两个字段分开，这样一个"control 却带了提示"的回合是**可见的**，而不是不可见的。

读数脚本同时新增 `armViolations`：分配与实际注入不一致的回合数。**非零即为 bug，这批数据不能用来判断效果。**

## 为什么用哈希而不是随机数

```js
sha256(sessionKey + ':' + turn) → 前 8 位十六进制 → 约 50/50
```

- 同一会话在**重试或重放**时不会翻臂；
- **没有 RNG 状态**要持久化；
- **没有任何关于用户或任务的信息**参与选择——只有一个已经哈希过的标识符；
- 分臂**可以从日志完全复现**，读数脚本不必依赖记录里的字段。

**实测分布**：1000 个 `(sessionKey, turn)` → control 478 / treatment 522（47.8% / 52.2%）。

**按回合而不是按会话**：两臂因此抽自**同一个会话**，能力、工具、上下文都匹配，只有提示这一项在变。按会话随机会让分臂与"这个会话恰好有多强"混在一起。

## 代价必须说清

**一半的 HIGH 机会拿不到提示。** 这是一个真实的取舍：

- 如果提示确实有效，这个实验就是在运行期间**主动对那一半回合扣掉一个有效帮助**；
- 换来的是**因果答案而不是相关答案**。

所以它是所有人明示的决定，不是悄悄设的默认值——README 里也这样写。

## 样本量：实测出来的时间表

HIGH 的基准发生率是 **29.2%**（120 个发现记录里 35 个 HIGH），按每天约 30 回合：

```
50 个 HIGH opportunity  ≈  171 个回合  ≈  6 天
```

这个数字值得先说：它决定了实验值不值得做。**6 天可接受。**

## 旧记录的排除必须靠分析窗口

`pairTurns()` 对无 `sessionKey` 的旧记录用 `(none)#turn` 兜底，所以它们**仍然可能被配对**——而报告文字却写"已排除"。这两句不一致。

正确的做法是**靠分析窗口**排除：

```sh
node tools/discovery-report.mjs --since <T0>
```

`--since` 之后，旧记录才真正落在分母之外。这条写进了实验协议，也写进了 README。

## 实验协议

```
① 重启 DSH，记下开始时间 T0
② 固定 skill-index（可用技能数应保持 1025；中途变了这批作废重来）
③ 收集 ≥50 个唯一、可配对的 HIGH opportunity（约各半）
④ node tools/discovery-report.mjs --since <T0>
```

## 结果解释矩阵

| 结果 | 说明 |
|---|---|
| HIGH 相关性低 | 继续修 discovery |
| 相关性高，treatment ≫ control | 原始 trigger 假设成立 |
| 相关性高，treatment ≈ control ≈ 0 | Agent 看到候选也不想搜，问题在 hint 措辞/位置/agent 行为 |
| treatment 搜索高但 load 低 | `skill_search → skill_load` 这一段有问题 |
| treatment 搜索高、load 也高 | 发现层基本成功，再考虑中文/AND/成本优化 |

## 测试

- `test/discovery-injection.mjs`：新增分臂函数本身的断言（**确定性**、值域、约 50/50、会话标签参与分臂），并断言 **treatment 回合被替换、control 回合原样返回**——后者就是"真正的对照组"这件事的可执行定义。
- `test/discovery-report.mjs`：重写为按 `arm` 断言（treatment/control 分别统计、control 是合格对照而不与 not-eligible 混、NONE 回合的搜索不计入任何一臂、`armViolations` 能抓出两种冲突、`--since` 确实排除窗口外记录）。

写这两组断言时我又错了两次**夹具**（用 session id 而不是 sessionKey 去算分臂、回合号写死 11 而实际是动态的）——`experimentArmOf` 吃的是哈希后的 `sessionKey`，测试必须用同一个哈希。修的是测试。

## English

This version changes **no discovery algorithm** — only the experiment design, because the previous one could not answer a causal question.

**The problem.** The readout computed its control as `injected !== true`, while injection is decided *by* the tier. The two groups were therefore different task populations by construction: "run a semgrep security audit" against "what is the weather". A difference in search rate between them is attributable to the tasks being different, so it says nothing about the hint. That is not a statistical bias; it is an unanswerable question.

**The change.** After `tier === HIGH`, `sha256(sessionKey + ':' + turn)` assigns the opportunity to `control` or `treatment` at roughly 50/50, and only that decides whether the hint goes out. Both record types now carry `arm` alongside `injected`, because **`arm` is the assignment and `injected` is what actually happened** — keeping them separate makes a control turn that somehow carried a hint *visible* rather than invisible. The readout reports `armViolations`; a non-zero value means the batch cannot be used to judge the effect.

**Why a hash rather than a random number**: a conversation cannot flip arms on a retry or a replayed step, there is no RNG state to persist, nothing about the user or the task enters the choice, and the split is reproducible from the log alone — measured on 1,000 `(sessionKey, turn)` pairs: 478 control / 522 treatment (47.8% / 52.2%). Per turn rather than per session, so both arms draw from the *same* conversation and only the hint varies; session-level randomisation would confound the arm with how capable that conversation happened to be.

**The cost, stated plainly**: half of all HIGH opportunities get no hint. If the hint works, the experiment actively withholds a working aid from those turns for as long as it runs. That buys a causal answer instead of a correlated one, and it is the owner's explicit decision rather than a silent default.

**The timeline, measured rather than guessed**: HIGH runs at **29.2%** of discovery records (35 of 120), which at roughly 30 turns a day puts 50 HIGH opportunities about **6 days** out. Worth stating before committing to the experiment.

**Legacy records are excluded by the analysis window, not by a label.** `pairTurns()` falls back to `(none)#turn` for records without a `sessionKey`, so they can still pair — while the report said they were excluded. The two statements disagreed; `--since <T0>` is what actually keeps them out of the denominator, and that is now part of the protocol. The result-interpretation matrix is unchanged from the plan: low HIGH relevance sends you back to discovery; high relevance with treatment far above control confirms the trigger hypothesis; high relevance with both near zero moves the question to hint wording and agent behaviour; high search with low load points at the `skill_search → skill_load` gap; high both ways means the discovery layer works.

**Tests.** The injection test now asserts the arm function itself — determinism, value range, the ~50/50 split, the session label participating — and asserts that a treatment turn is rewritten while a control turn comes back untouched, which is the executable definition of "a real control group". The readout test was rewritten around `arm`: per-arm counts, control counting as eligible rather than as not-eligible, NONE turns staying out of both arms, both kinds of arm violation caught, and `--since` actually excluding out-of-window records. Writing them I got my own **fixtures** wrong twice (using a session id where a hashed sessionKey was required, and hard-coding turn 11 when the turn is now dynamic); the fix was to the tests each time.
