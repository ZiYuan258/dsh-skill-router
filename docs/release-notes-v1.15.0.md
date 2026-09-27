# v1.15.0 — 分臂单位改为**会话**，测量单位改为**每会话第一个 HIGH**

[English](#english) | 中文

v1.14.0 的随机分臂方向是对的，但**在干预会持久化的情况下，按回合分臂会用污染自己对照组的方式给出一个看起来很合理的数字**。这一版改的是实验单位，不是 discovery 算法。

## 污染是机制事实，不是推测

`dsh-agent-loop` 把这一步的消息这样落到会话上：

```js
if (firstAttempt) for (const message of decision.messages)
  this.session.append('user/message', message, { surfaceOp: 'append' });
```

`surfaceOp: 'append'` 意味着提示进入会话 **surface**，之后每一步的历史都由它派生。实测也直接可见——注入的提示在会话投影里是一个 `skill-router` 的 surface 节点：

```
"cat": "inject", "tokens": 90, "name": "skill-router",
"text": "Maybe relevant skills for this task: implement-task (name, description, path); i…"
```

所以按回合分臂的污染**是单向的**：

```
turn 10  treatment  →  提示进入会话 surface
turn 11  control    →  没有新提示，但 turn 10 的提示仍在上下文里
```

treatment 污染它之后的所有 control，反之不成立 → 汇总后朝一个已知方向偏，**而数字看起来完全正常**。这正是最危险的一类错误。

## 改法

**分臂单位 → 会话**：

```
sha256(sessionKey) → 约 50/50
   ↙                    ↘
control               treatment
该会话所有 HIGH         该会话所有 HIGH
都不注入                都注入
```

control 会话**从头到尾没有提示**，干预无法泄漏进它的任何机会。

**测量单位 → 每会话第一个 eligible HIGH**：即使分臂按会话，同一会话的后续机会也不是独立样本（Agent 搜过一次、学到一个技能，之后行为已被塑形）。第一个 HIGH 是**唯一可证明"先于本实验任何提示"**的观测。

插件在每条记录上写 `firstEligible`。读数脚本因此分三层，并明确标注哪一层能用：

```
主指标        每会话第一个 eligible opportunity（一 session 一个独立观测）
探索性        同会话后续机会（不独立）
全量汇总      含非首观测（**不能用来下因果结论**）
```

另加 `duplicateFirsts`：同一会话被记了多次 `firstEligible` 时报警——那会让主指标分母不可信。

## 代价变重了，必须说清

v1.14.0 是"一半的 HIGH 机会拿不到提示"。现在是**一半的会话从头到尾拿不到提示**。

这是干预持久化之后必须付的代价：**"同一会话内匹配上下文"只有在两臂仍然独立时才值得要**，而按回合分臂并不独立。这两者不能同时满足，必须选一个——选独立性。

## 样本量门槛的单位也变了

```
≥50 个会话，每个恰好一个可配对的首观测（约各半）
```

不是"50 个回合"。这比 v1.14.0 要求的样本更贵，但因果解释干净。

## 测试：两条**恒真断言**已修

你逐行读出来的两条，我先确认它们确实什么都没测：

```js
new Set([...]).size >= 1                                  // 任何集合都满足
armOf(A) !== armOf(B) || true                             // \`|| true\` 让整条永真
```

现在改成**预先算好的固定夹具** + 明确的两臂断言：

```js
const CONTROL_FIXTURE = 'fixture-session-1'     // 必定落 control
const TREATMENT_FIXTURE = 'fixture-session-0'   // 必定落 treatment
```

一旦哈希或阈值被改动，夹具就失配——那正是它该做的事。另外补了"换会话标签会改变分配"（用真实存在的异臂对断言，而不是 `|| true`）和"同会话的臂不随回合变化"。

读数测试也按新结构重写：主指标分母、探索性/全量分层的区分、`duplicateFirsts` 报警、以及"分臂冲突能被抓出"。

## 自己踩的坑（记录）

- 重写英文实验节时，我的区块替换**把"遥测记两件事"整节挪到了后面**——`docs-parity` 的标题骨架检查没红（标题数没变），是我逐节比对围栏数才发现的。**顺序变了但数量没变，这类损坏只能靠结构比对，不能靠计数。**
- 一次转义替换把英文的 JSON 示例块的围栏吃掉了，同样是计数才发现。
- 夹具又错两次（用 session id 而非哈希后的 `sessionKey`；`legacyDisc` 裸 JSON 没带 `firstEligible`，而主指标只收带该字段的记录）。

## English

v1.14.0 randomised the right thing, but **with an intervention that persists, per-turn arms contaminate the control group while producing a number that looks entirely reasonable.** This release changes the experimental unit, not the discovery algorithm.

**The contamination is a mechanism fact, not a guess.** `dsh-agent-loop` lands the step's messages on the session with `this.session.append('user/message', message, { surfaceOp: 'append' })`, so the hint joins the session **surface** and every later step derives its history from it — observed directly as a `skill-router` surface node carrying about 90 tokens. Per-turn arms therefore contaminate in one direction only: a treatment turn at turn 10 leaves its hint in context for a control turn at turn 11. Treatment pollutes every later control opportunity, control never pollutes treatment, and the pooled comparison is biased in a known direction while still looking normal — the most dangerous kind of error.

**The change.** The arm belongs to the **session** (`sha256(sessionKey)`, roughly 50/50): a control session never receives a hint at all, so nothing of the intervention can leak into any of its opportunities. And the unit of **measurement** is each session's **first eligible opportunity**, because later opportunities in one session are not independent samples once the agent has searched and learned something; the first is the only observation that provably precedes any hint the experiment could have shown. The plugin writes `firstEligible` on every record, and the readout separates a primary metric (one independent observation per session) from exploratory and pooled numbers that it labels as unusable for causal conclusions. `duplicateFirsts` warns when one session was marked first more than once, which would make the primary denominator untrustworthy.

**The cost got heavier and is stated plainly**: v1.14.0 withheld the hint from half the turns; this withholds it from half the **sessions, for their entire length**. That is the price of a persistent intervention — matching context within one conversation is only worth having if the arms remain independent, and per-turn arms are not independent. The two cannot both be had, and independence is the one that was chosen. The sample gate moves with it: **50 sessions, each with exactly one pairable first observation**, not 50 turns.

**Two tautological assertions were removed.** Both of the ones the owner read out tested nothing (`new Set([...]).size >= 1`, and `... || true`). They are replaced with pre-computed fixture sessions that must land in a known arm — so a change to the hash or the threshold breaks the fixture, which is what a fixture is for — plus a real cross-arm pair asserting that the session label participates, and an assertion that a session's arm does not vary by turn.

**My own mistakes, recorded**: rewriting the English experiment section moved the telemetry section out of order, and the heading-skeleton check stayed green because the *count* of headings did not change — only per-section structural comparison caught it. An escaping step ate a JSON block's fences, again caught only by counting. And two fixtures were wrong again (a session id where a hashed `sessionKey` was required; a bare JSON record missing `firstEligible`, which the primary metric requires).
