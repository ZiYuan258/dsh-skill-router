# v1.10.0 — 发现层（干跑）：先测"Agent 会不会想到去找"

[English](#english) | 中文

三个工具解决的是"技能很多，怎么让 Agent 找到"。它们解决不了另一半：

> **Agent 会不会想到该去找？**

库里的技能对模型不可见，所以用上一个的前提是**模型自己先想起可以搜**。用户说"帮我做一次 Semgrep 安全审计"，如果模型决定直接回答，`skill_search` 根本不会发生。这一版为这个缺口加了一层，但**只测量，不注入**。

## 挂在哪、怎么算

```
agent/pre-step（DSH 的瀑布事件，在请求组装之前）
   ↓
只在 step === 1（每回合一次，不是每步一次）
   ↓
与 skill_search 同一个 tokenizer、同一个 scoreRow（权重只写一份）
   ↓
但**不继承那个工具的查询策略**：不做严格 AND、不做 all-but-one 回落
   ↓
top 5 → 写一行遥测 → 原样返回决策
```

**为什么共享 scorer 却不共享查询语义**：`skill_search` 的严格 AND 是为**模型写出来的短查询**设计的；任务句子是散文，"分析这个 React 项目的性能问题"在严格 AND 下没有任何解释，那会让这一层静默失效。所以差异留在调用方，权重留在函数里。

为此把评分从 `apply` 内部的闭包抽成了模块级纯函数 `scoreRow(row, context)`。这是这个仓库第四次遇到"同一份逻辑两处实现"（`normName`、`loadOlder` 的对象、调用计数），所以这次从一开始就只留一份。

## 干跑记录了什么

`~/.dsh/skill-router/discovery.jsonl`，一行一次，**没有用户原文**：

```json
{"at":"…","turn":3,"step":1,"tier":"HIGH","reason":"ok","tokenCount":7,"indexRows":1029,"elapsedMs":11,
 "candidateCount":1,"candidates":[{"name":"semgrep","score":210,"matched":3,"nameHits":1,"fields":["name","whenToUse"]}],"injected":false}
```

只记命中数量、候选名与分数——一个观察功能不该顺手制造新的会话内容存储。日志有字节上限并轮转。

`tier` 是这一阶段的核心读数：**HIGH**（命中 name 且 ≥2 个不同 token 落地）、**MEDIUM**（只有 description、或单个弱关键词）、**NONE**（区分度不够，或与第二名咬得太近）。阈值等几天数据之后再定，不凭感觉。

## 两个已知边界（现在不修，先量）

- **索引只认 Latin script**：tokenizer 是 `[^a-z0-9+#._-]`，所以"帮我做一次安全审计"产出 0 个关键词。这不是缺陷需要掩盖，而是索引的性质——记成 `reason: "no-searchable-token"`，让数据告诉你它占多少。
- **`no-library` 与"没有匹配"分开记**：否则一个坏掉的索引会看起来像一个安静的、表现良好的路由器。

## 一处纠正：正式注入时不能用 `agent.inject()`

我原本以为 `agent.inject()` 是"把 hint 变成会话里真实存在的一条"的正解。查实现之后是**半个错**：

```js
inject(input) { this.send(input, "next-step", false) }   // 追加到 next-step 队列
// 而 preStep 的第一行就是：
const claimed = this.inbox.claim(target, position.turn)  // 先把 next-step 整批取走
```

`claim` 在瀑布**之前**执行，所以在 pre-step 里 `inject()` 的东西要到**下一步**才被取走——而这一层必须在第一步就生效。`decision.messages` 才是当前步骤真正进入请求的权威批次。这条已经写进 README 和源码注释，等启用注入时直接照办。

## 顺带修掉一个安装即坏的 bug

新模块 `discovery.js` **一开始不在 `package.json` 的 `files` 里**——发布包会缺文件，`apply` 一加载就抛错。已加入。这类错误测试抓不到（本地开发目录里文件总是在），但用户装上就炸。

## 测试

新增 `test/discovery-dry-run.mjs`（第 22 个脚本，17 条断言），它**真的调用 `apply(ctx)`，并像 agent-loop 一样触发 `agent/pre-step`**：

- 三个工具照旧注册、监听已挂；
- **干跑不改变决策**（本阶段的硬约束）；
- 写出遥测、只在第一步记录、`reject` 原样返回；
- 中文任务记 `no-searchable-token`；
- **遥测里没有用户原文**（逐片段断言）。

写这个测试时，桩 `ctx.fs.resolve` 第一版返回了字符串路径，而真实契约是 `{ targetKey, displayPath }`，于是 `resolveRoot` 抛 `Cannot read properties of undefined (reading 'slice')`。**又是桩比现实简单**——这次它帮我把"宿主里到底跑不跑得起来"验掉了，而不是留到安装后。

## English

The three tools solve "there are many skills — how does the agent find one". They do not solve the other half: **will the agent think to look at all?** A library skill is invisible to the model, so using one requires the model to *first* remember that searching is possible. If the user says "run a Semgrep security audit" and the model just answers, `skill_search` never happens. This release adds a layer for that gap — and it **only measures; it does not inject**.

It hooks `agent/pre-step`, runs **only at step 1**, and ranks the library locally with **the same tokenizer and the same `scoreRow`** the search tool uses — while deliberately **not** inheriting that tool's query policy (no strict AND, no all-but-one rescue). Strict AND is built for a short model-written query; a task is prose, and "分析这个 React 项目的性能问题" has no interpretation under strict AND, which would make this layer fail silently. To make that sharing real rather than aspirational, the scorer moved out of `apply`'s closure into a module-level pure function — this repository has now hit "one piece of logic in two places" four times, so this time there is one.

The dry run appends one line per task to `~/.dsh/skill-router/discovery.jsonl` **with no user text in it** — only match counts, candidate names and scores, because a feature that observes the router should not also start accumulating session content. `tier` (HIGH / MEDIUM / NONE) is the reading that matters now; thresholds get chosen from a few days of data, not from intuition.

**Two boundaries are left unfixed on purpose**, because measuring them is the point: the index matches Latin script only, so a Chinese task yields zero keywords and is recorded as `no-searchable-token` (that share is a measurement, not a bug to hide); and `no-library` is recorded separately, so a broken index cannot masquerade as a quiet, well-behaved router.

**One correction, verified in the harness rather than assumed:** when injection is switched on, the hint must go into `decision.messages`, not through `agent.inject()`. `preStep` calls `inbox.claim()` before dispatching the waterfall, so anything injected lands in `next-step` and is only claimed at the **next** step — while this layer has to work on the first one.

**And an install-breaking bug fixed on the way:** the new `discovery.js` was not in `package.json`'s `files`, so the published package would have been missing it and `apply` would have thrown on load. Local development never notices; a user's install would.

New: `test/discovery-dry-run.mjs` (22nd script, 17 assertions) really calls `apply(ctx)` and drives `agent/pre-step` the way the agent loop does — asserting the decision is untouched, telemetry is written, only step 1 is recorded, a Chinese task records `no-searchable-token`, a `reject` passes through, and **no user text reaches the log**. The first version of its fs stub returned a string where the real contract is `{ targetKey, displayPath }` — a stub simpler than reality again, and this time it caught the failure in a test instead of at install.
