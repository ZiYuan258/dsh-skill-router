# v1.5.1 — README 重写：先讲"你需不需要"，再讲"怎么用"

[English](#english) | 中文

两份 README 按同一个结构重写。前一版是功能清单，回答不了读者真正的第一个问题——**我需要它吗**，也没讲清**库该怎么放**。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

## 新增：定位（放在最前面）

一次工作通常只用到几个技能，所以**技能少的时候常驻反而更省**。这个插件是为相反的情况设计的：**技能多到装不进目录**。

开头直接给出判断表和门槛（**~30 个技能**以下不需要），并注明反向结论：如果你已把常用技能都常驻了，装它的收益是负的。

## 新增：使用方法（七节）

| 节 | 内容 |
|---|---|
| 一、库放到哪里 | `.skill-src` 的目录树示例 + 三条硬性约定（**名字必须是 `.skill-src`**、必须在会话 cwd 的同级或上级、内部结构随意） |
| 二、库在别处 | 目录链接方案，**已实测可用**；并明确警告**不要**用 DSH 的 `customSkillDirs`（那会把技能注册成常驻，与插件目标相反） |
| 三、生成索引 | 完整参考实现 + "必须用真正的 CSV 写入器"的原因 |
| 四、验证装好了 | 四步核对（工具在不在 → 索引找没找到 → 加载通不通 → 库有没有被塞进目录），以及用 `library`/`error` 两个字段区分三种失败 |
| 五、日常怎么用 | 不需要记技能名；想自动触发才装进常驻区，并说明代价 |
| 六、库变了怎么办 | 四种改动 × 该做什么；过期条目的表现是"搜得到但加载失败" |
| 七、备份与隔离 | 备份什么；可疑技能移出库根即从索引消失；审计命令 |

**为什么 `.skill-src` 这个名字重要**：前导点让它对 DSH 的 skill 扫描器不可见——这正是"库不占目录成本"的机制。命名成 `skills/` 或放进 `.dsh/skills/`，DSH 会把里面全部技能注入每轮上下文，插件就白装了。这一点原文没写清。

## 附带修掉的两处结构问题

- `### skill_ref` 一节里混进了 `skill_load` 的返回说明（早先编辑的残留），"查找顺序/上限"也漂到了错误的标题下。
- 中文侧曾出现**重复的"三、生成索引"**，英文侧的 `## Usage` 一度被误删；两者都已核对修复，现在两份标题序列**逐项对齐**（35 = 35）。

## 新增：`tools/check-link-support.mjs`

文档里"库可以放在别处"这条主张的依据。它在一个临时工作区里建 junction 并**真跑一遍**搜索与加载，所以那条说法可复验，而不是推测。

## 一致性检查加强

`docs-parity.mjs` 现在同时钉住**定位主张**（`~30`、`150k`、`3,603 B`、`1,001`、`1,541`、`agent/pre-step`、`ctx.skills.list()`），所以改一种语言不会悄悄丢掉另一种语言提出的论点。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

---

## English

Both READMEs were rewritten to one structure. The previous version was a feature list: it never answered the reader's first question — **do I need this** — and never explained **where the library goes**.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

### New: positioning, first thing in the file

A single task uses only a few skills, so **a small set is cheaper kept resident**. This plugin exists for the opposite case: **more skills than will fit in the catalog**.

The opening now carries a decision table and a threshold (**under ~30 skills, you do not need it**), plus the counter-conclusion: if your frequently used skills are already resident, installing this has negative value.

### New: a seven-step usage guide

| Step | Content |
|---|---|
| 1. Where the library lives | a `.skill-src` tree, plus three rules (**the name matters**, it must be at or above the session cwd, the internal layout is free) |
| 2. The library lives elsewhere | the directory-link approach, **tested**; and an explicit warning **not** to use DSH's `customSkillDirs`, which would register the skills as resident — the opposite of the goal |
| 3. Generate the index | the full reference implementation, and why a real CSV writer is required |
| 4. Verify it works | four checks (tools present → index found → loading works → the catalog did not grow), and how `library`/`error` separate three failure modes |
| 5. Day to day | no need to remember skill names; make a skill resident only if you want auto-triggering, and at what price |
| 6. When the library changes | four kinds of change and what each requires; a stale entry looks like "searchable but unloadable" |
| 7. Backup and quarantine | what to back up; moving a directory out of the library root removes it from the index; the audit command |

**Why the `.skill-src` name matters:** the leading dot keeps it invisible to DSH's skill scanner — that is the mechanism that makes the library free. Name it `skills/`, or place it under `.dsh/skills/`, and DSH injects every skill into every turn, defeating the install. The previous version never said this.

### Two structural defects fixed along the way

- The `### skill_ref` section had absorbed `skill_load`'s return-value paragraph (an earlier edit's residue), and "lookup order and limits" had drifted under the wrong heading.
- The Chinese side briefly carried a **duplicated "3. Generate the index"**, and the English side lost its `## Usage` heading outright; both were repaired, and the two heading sequences are now **aligned item for item** (35 = 35).

### New: `tools/check-link-support.mjs`

The evidence behind "the library can live elsewhere". It creates a junction in a throwaway workspace and **runs a real search and load through it**, so the claim is reproducible rather than assumed.

### Stronger consistency checking

`docs-parity.mjs` now pins the **positioning claims** as well (`~30`, `150k`, `3,603 B`, `1,001`, `1,541`, `agent/pre-step`, `ctx.skills.list()`), so rewriting one language cannot quietly drop the argument the other one makes.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
