# v1.4.0 — `explain` 诊断、可选的宿主 API、诚实标注 schema 开销

[English](#english) | 中文

三个动作都是对同一类批评的回应：**这个插件的代价要讲清楚，出问题时要有办法看清原因**。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

## 新增：`skill_search` 的 `explain` 参数

在此之前，"搜不到"或"搜出一堆不相关"是无法诊断的——不知道是模型没调工具、调了但描述不匹配、还是技能库结构有问题。现在：

```
skill_search  query: "widgets beta"  explain: true
```

每条命中带上分数与**逐关键词、逐字段**的构成：

```
- beta-gadgets  [beta-skills]
    why: widgets: -; beta: +130 (name+description+path)
- alpha-widgets  [alpha-skills]
    why: widgets: +130 (name+description+path); beta: -
```

`-` 表示该关键词未命中（只有降级到部分匹配时才会出现）。默认不开，所以正常路径不为它付任何成本。

## 新增：可选宿主 API 的降级保证

一个最小宿主测试（`test/minimal-host.mjs`）**立刻抓到一个真 bug**：`ctx.get` 不存在时 `skill_load` 直接崩（`ctx.get is not a function`）。`ctx.get` 是可选 API，我却在未确认存在的情况下调用它。

现已改为：`ctx.get` / `ctx.effect` / `ctx.skills` 缺席时**降级而不是崩溃**，并由测试钉住——只注入 `ctx.fs` 时，三个工具全部正常工作。

## 变更：版本门槛的表述基于证据

`dsh.engines.dsh: >=0.1.5-rc.1` 是**已验证可用的版本**，不是"需要这么新"。本插件只用到 `ctx.tools.register` 与 `ctx.fs.*` 这一小组 API，**无事件钩子、无 import**。更早版本没验证过，而**过度声明兼容性比保守更糟**，所以不改门槛，改说明。`package.json` 里同时列出 `dsh.requires` 与 `dsh.optional` 两组 API，让读者自己判断。

## 变更：把 schema 开销写进 README

工具驱动不是免费的，之前只讲了省下的那笔。现在两份 README 都有实测数字：

| 开销 | 实测 |
|---|---|
| 常驻 schema（三个工具） | **3,603 B ≈ 1,001 token/轮**，固定，不随库增长 |
| 一次检索往返 | 一次 tool call + 约 **1,533 B ≈ 426 token**（`limit=12`） |

并给出对照与**反向建议**：常驻 28 个技能时实测 1,541 token/轮；**如果你的库只有十几个技能，这个插件不划算**，直接用常驻目录更省。

## 测试：12 个脚本

新增 `minimal-host.mjs`（可选 API 降级）；`robustness.mjs` 增加 `explain` 的 7 条断言，覆盖"未命中记为 `-`"这一细节。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

---

## English

All three changes answer one class of criticism: **state this plugin's cost, and make failures diagnosable**.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

### New: `explain` on `skill_search`

Until now "nothing found" or "found the wrong thing" was undiagnosable — was the tool never called, did the description not match, or is the library structured badly? Now:

```
skill_search  query: "widgets beta"  explain: true
```

Every hit carries its score and a **per-keyword, per-field** breakdown:

```
- beta-gadgets  [beta-skills]
    why: widgets: -; beta: +130 (name+description+path)
- alpha-widgets  [alpha-skills]
    why: widgets: +130 (name+description+path); beta: -
```

A `-` marks a keyword that did not match, which only appears in the partial-match pass. It is off by default, so the normal path pays nothing for it.

### New: degradation guarantees for optional host APIs

A minimal-host test (`test/minimal-host.mjs`) **immediately caught a real bug**: with no `ctx.get`, `skill_load` crashed with `ctx.get is not a function`. `ctx.get` is an optional API and it was being called without checking.

Now `ctx.get`, `ctx.effect` and `ctx.skills` **degrade instead of crashing** when absent, pinned by tests: injecting only `ctx.fs` leaves all three tools fully working.

### Changed: the version floor is stated with evidence

`dsh.engines.dsh: >=0.1.5-rc.1` is the **verified** floor, not a demand for something newer. The plugin uses only `ctx.tools.register` and `ctx.fs.*`, with **no event hooks and no imports**. Older versions are unverified, and **over-claiming compatibility would be worse than being conservative** — so the floor stays and the explanation changes. `package.json` now lists `dsh.requires` and `dsh.optional` separately so a reader can judge for themselves.

### Changed: the schema cost is documented

Tool-driven retrieval is not free, and the READMEs previously described only the cost it saves. Both now carry measured numbers:

| Cost | Measured |
|---|---|
| Resident schemas (three tools) | **3,603 B ≈ 1,001 tokens/turn**, fixed, independent of library size |
| One search round-trip | one tool call + about **1,533 B ≈ 426 tokens** (`limit=12`) |

Plus the comparison and the counter-recommendation: a 28-skill resident catalog measured 1,541 tokens/turn, and **if your library holds only a dozen or two skills this plugin is not worth it** — a resident catalog is cheaper.

### Tests: 12 scripts

New `minimal-host.mjs` (optional-API degradation); `robustness.mjs` gains seven `explain` assertions, including the detail that a miss is recorded as `-`.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
