# v1.2.0 — 新增 skill_ref、搜索部分匹配降级、诚实的截断上报

[English](#english) | 中文

新增第三个工具、让关键词搜索在无精确命中时降级而不是失败，并修掉一个让截断告警**永远无法触发**的边界 bug。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

## 安装

```sh
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router
```

从 v1.1.0 升级需要重启，任何插件改动都一样。

## 新增：`skill_ref` —— 只读捆绑的单个文件，而不是整个目录

`SKILL.md` 经常指向 `references/`、`scripts/`、`assets/` 里任务根本用不到的内容，而 `skill_load` 过去只能列出它们的名字。`skill_ref` 精确读取指令里提到的那一个文件：

```
skill_ref  name: "semgrep"  path: "references/rulesets.md"
skill_ref  name: "semgrep"  list: true
```

路径在**任何 I/O 之前**先做包含性校验，所以 `../` 无法越出技能目录——这条规则由**解析器本身的单测**覆盖，而不是只靠一次实跑。真正的 token 节省就在这里。

## 新增：`skill_search` 的部分匹配降级

关键词搜索原本是严格 AND，所以一个两词查询只要没有任何单个技能同时命中，就会返回空。现在会重试部分匹配并**如实标注**：

```
fallback: "or"          // 之前恒为 "none"
matchCount: 1           // 共 2 个关键词，本条命中 1 个
```

近似命中永远不会被当成真命中呈现；单个关键词的查询不会降级——没有可降级的余地。

## 修复：截断告警曾永远无法触发

`clampBody` 替换掉的那个辅助函数，其调用方在**截断之后**判断 `text.length > cap`——这个条件永远为假，于是超长 `SKILL.md` 被静默截短却报告为完好；恰好等于上限的正文还会被悄悄砍掉一个字符。

现在截断函数把事实和文本一起返回：

```
truncated: true
error: "content truncated at 120000 of 130095 characters; read the full file at …/SKILL.md"
```

两个边界情况都有测试钉住。

## 修复：`host.js` 确立单一真源

这个文件曾被**在两个位置同时编辑**（已部署的包与开发检出），两份副本静默分叉——一份落后了整整一次编辑，而针对它的测试运行"通过"了一个包内从未存在的状态。`tools/sync-host.mjs` 现在负责让第二份检出保持同步，`--check` 在漂移时退出 1，CI 或 hook 据此可以拒绝脑裂。

```sh
SKILL_ROUTER_DEV_DIR=/path/to/other/checkout npm run check:host
```

## 测试：9 个脚本、零依赖

新增两个：`robustness.mjs`（降级标注、两种截断边界）与 `skill-ref.mjs`（路径包含性含越界尝试、列目录、文件缺失）。两者都自建夹具库，所以裸克隆仍能跑完整套件。CI 在 Node 20 / 22 / 24 上跑，无安装步骤。

## 环境要求

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`

---

## English

Adds a third tool, makes keyword search degrade instead of failing, and fixes a boundary bug that made the truncation warning impossible to trigger.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

### Install

```sh
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router
```

Upgrading from v1.1.0 needs a restart, like any plugin change.

### New: `skill_ref` — read one bundled file instead of a whole directory

A `SKILL.md` routinely points at `references/`, `scripts/` and `assets/` that the task never needs, and `skill_load` only listed them by name. `skill_ref` reads exactly the file the instructions asked for:

```
skill_ref  name: "semgrep"  path: "references/rulesets.md"
skill_ref  name: "semgrep"  list: true
```

Paths are resolved with a containment check **before any I/O**, so `../` cannot reach outside the skill directory — covered by unit tests on the resolver itself, not just through a live call. This is where the token saving actually lives.

### New: partial-match fallback in `skill_search`

Keyword search was a strict AND, so a two-word query that no single skill matched returned nothing at all. Search now retries with a partial match and says so:

```
fallback: "or"          // was "none"
matchCount: 1           // out of 2 keywords, per hit
```

A near-miss is never presented as a real hit, and a single-keyword query never falls back — there is nothing to degrade to.

### Fix: the truncation warning could never fire

`clampBody` replaces a helper whose callers tested `text.length > cap` **after** clamping, which can never be true — so an oversized `SKILL.md` was silently shortened and reported clean. A body of exactly the cap was also quietly shortened by one character.

Now the clamp returns the truncation fact alongside the text:

```
truncated: true
error: "content truncated at 120000 of 130095 characters; read the full file at …/SKILL.md"
```

Both boundary cases are pinned by tests.

### Fix: one source of truth for `host.js`

The plugin file had been edited in two places at once (the deployed package and a dev checkout) and the copies silently diverged — one went a whole edit behind, and a test run against it "passed" a state the package never had. `tools/sync-host.mjs` now keeps a second checkout in step, with `--check` exiting 1 on drift so CI or a hook can refuse a split brain.

```sh
SKILL_ROUTER_DEV_DIR=/path/to/other/checkout npm run check:host
```

### Tests: 9 scripts, no dependencies

Two new ones: `robustness.mjs` (fallback labelling, both truncation boundaries) and `skill-ref.mjs` (path containment including traversal attempts, listing, missing files). Both build their own fixture library, so a bare clone still runs the whole suite. CI covers Node 20, 22 and 24 with no install step.

### Requirements

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`
