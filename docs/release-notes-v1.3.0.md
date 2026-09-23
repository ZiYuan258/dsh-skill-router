# v1.3.0 — 索引支持可选的 `whenToUse` 列

[English](#english) | 中文

索引格式新增一个**可选的第 7 列** `whenToUse`，并在检索时给它高于 `description` 的权重。6 列索引继续照常工作。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

## 为什么加这一列（先量化，再动手）

DSH 的技能 frontmatter 允许 `whenToUse` 字段，它按定义就是**触发措辞**，比描述性散文更贴近"用户会怎么说"。

但实测参考库（1025 个 `SKILL.md`）：**带 `whenToUse` 的：0 个。覆盖率 0%。**

所以：

- 对**当前**这套数据，按 `name + description` 匹配不是缺陷，而是唯一可选——上游把触发语义写进了 `description`（大量 `Use when …` 开头）。
- 但对**格式**而言，支持该列仍是正确的：零成本、前向兼容，且作者一旦写了就能得到应有的权重，而不是被丢掉。

## 改了什么

| 位置 | 变化 |
|---|---|
| 索引格式 | 第 7 列为可选 `whenToUse`；6 列索引照常解析，缺列读作空字符串 |
| 检索评分 | `name +100`、**`whenToUse +40`**、`description +24`、路径 `+6`；完全命中 `+400` |
| 搜索结果 | 命中里多一个 `whenToUse` 字段；工具卡片只在它**与描述不同**时额外显示 `when: …` 一行，避免重复信息占两遍 |
| 生成脚本 | `scan-skills.ps1` 从 frontmatter 提取 `whenToUse`，并报告有多少行带上它 |

权重顺序体现的是信息密度：名称 > 触发措辞 > 描述散文 > 路径。

## 迁移是无损的

参考索引（1028 行）已重新生成。逐行比对确认：**前 6 列 1028 行零差异**，只是多了一列。旧格式仍可用，所以别处生成的索引不必立刻重建。

## 测试：11 个脚本

新增 `index-format.mjs`，把索引格式当成**契约**来钉：

- 6 列索引可解析，缺列读作空字符串（而不是 `undefined`）
- 7 列索引可解析，触发措辞能返回
- 表头按形状识别，行不会被误判成表头
- 机器上有真实库时，额外验证真索引仍可解析、每个命中都返回字符串类型的 `whenToUse`

夹具里的 TSV 用正确的 CSV 引号规则生成——本项目早先就被"手工拼制表符"坑过一次，测试夹具不该重犯。

## 环境要求

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`

---

## English

Adds an **optional 7th index column**, `whenToUse`, scored above the description. A 6-column index keeps working unchanged.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

### Why this column, measured before building it

DSH skill frontmatter may carry `whenToUse`, which is trigger phrasing by definition and therefore closer to how a user phrases a task than descriptive prose is.

Measured on the reference library (1025 `SKILL.md` files): **0 carry `whenToUse`. Coverage 0%.**

So:

- For **today's** data, matching on `name + description` is not a shortcoming but the only option — upstream puts trigger semantics in `description` (frequently `Use when …`).
- For the **format**, supporting the column is still right: zero cost, forward compatible, and a writer that fills it gets the weight it deserves instead of being dropped.

### What changed

| Where | Change |
|---|---|
| Index format | Optional 7th column `whenToUse`; 6-column indexes still parse, a missing column reads as an empty string |
| Scoring | `name +100`, **`whenToUse +40`**, `description +24`, path `+6`; exact name match `+400` |
| Search results | Hits carry `whenToUse`; the tool card adds a `when: …` line only when it **differs** from the description, so a library filling both does not pay for the duplication twice |
| Generator | `scan-skills.ps1` extracts `whenToUse` from frontmatter and reports how many rows carry it |

The weight order reflects information density: name > trigger phrasing > descriptive prose > path.

### The migration is lossless

The reference index (1028 rows) was regenerated. A row-by-row comparison confirms **zero differences across the first six columns of all 1028 rows** — only the new column was added. The old format still works, so indexes generated elsewhere need not be rebuilt immediately.

### Tests: 11 scripts

New `index-format.mjs` pins the index format as a **contract**:

- a 6-column index parses, and the missing column reads as an empty string rather than `undefined`
- a 7-column index parses and returns the trigger phrasing
- the header is recognised by shape, so data rows are never mistaken for it
- when a real library is reachable, it additionally checks the live index still parses and every hit returns a string `whenToUse`

The fixture TSV uses correct CSV quoting — this project was already bitten once by hand-joined tabs, and a test fixture should not repeat it.

### Requirements

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`
