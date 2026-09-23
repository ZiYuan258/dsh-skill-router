# v1.1.0 — 首个公开版本

[English](#english) | 中文

一个 DeepSeek Harness **Host 插件**，新增 `skill_search` 与 `skill_load` 两个工具，让 agent 能从分级技能库里找到并加载任意技能，而不是为会话目录里挂着的每个技能都付 token。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

## 安装

```sh
# 从 git 安装（推荐）
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# 或用本 Release 附带的 tarball
dsh plugin --profile <profile> add /path/to/dsh-skill-router-1.1.0.tgz
```

重启一次 DSH，然后在工具列表里确认 `skill_search` 与 `skill_load` 都在。

**不发布到 registry**：DSH 只要能把包装上就组合得出插件，git URL 或本地路径已经足够，所以本包 `private: true` 是有意为之。

## 它做什么

| 工具 | 作用 |
|---|---|
| `skill_search` | 在分级索引上做 AND 关键词检索（技能名 / 描述 / 上游仓库），返回名字、仓库、重名份数与 `SKILL.md` 绝对路径 |
| `skill_load` | 把一个或多个技能正文以 `<skill_content>` 块加载进上下文并附 base directory，使 `scripts/`、`references/`、`assets/` 能正确解析 |

索引是 `<工作区>/.skill-src/skill-index.tsv`（列为 `repo`、`relpath`、`name`、`description`、`files`、`KB`），由会话工作目录向上查找定位——没有任何盘符或路径是写死的。两份 README 都记录了这几列并附参考生成脚本。

## 亮点

- **零依赖、零导入。** 没有 `node_modules`，不需要安装，没有构建步骤。
- **零目录成本。** 工具只占几百字符的 schema；技能库从不注入上下文。
- **由 agent 选。** 路由规则写在工具描述里，由模型决定用哪些技能——不把选择推给用户。
- **批量加载健壮。** `skill_load` 接受真数组、JSON 编码的数组、逗号/换行分隔的字符串，因为数组参数可能以字符串形式到达。
- **重名处理确定。** `skill_search` 报 `copies`，`skill_load` 用 `repo` 消歧；不给提示时路径最浅者胜——`repo` 过滤没命中时会说明哪些仓库真的有，而不是悄悄回退。
- **双语文档由测试保证同步**，不靠自觉。

## 本版本修掉的两个 bug（各带回归测试）

早先一次本地构建把 DSH host 弄到启动失败：包里一个仅开发用的替身位于包自身的 `node_modules`，遮蔽了 `@deepseek-ai/dsh-tools`，于是作者 DSL（`output.schema: { type: 'json' }`）未经编译就进了工具注册表，整棵插件树拒绝加载：

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

现在工具定义在本地按标准 JSON Schema 构建，并且 `test/boot-safety.mjs` 会在包再次携带 `node_modules`、或再次把 DSH 宿主包写进 `dependencies` 时失败。

第二个：`skill_load` 最初把 `name` 声明为 `oneOf: [string, array]`，schema 上好看、实际会坏——被字符串化的数组悄悄变成了一个不存在的技能名。

## 测试

```sh
npm test
```

七个零依赖脚本。机器上能定位到真实技能库时就直接对真库跑，否则生成一次性夹具库，所以这个 tarball 自带测试能力。CI 在 Node 20 / 22 / 24 上跑，无安装步骤。

## 环境要求

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`

---

## English

A DeepSeek Harness **Host plugin** that adds two tools, `skill_search` and `skill_load`, so an agent can find and load any skill from a staged library instead of paying for every skill in the session catalog.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md)

### Install

```sh
# from git (recommended)
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# or from the tarball attached to this release
dsh plugin --profile <profile> add /path/to/dsh-skill-router-1.1.0.tgz
```

Restart DSH once, then confirm `skill_search` and `skill_load` appear in the tool list.

No registry publication: DSH composes a plugin from any package it can resolve, so a git URL or a local path is enough. The package is `private: true` on purpose.

### What it does

| Tool | Purpose |
|---|---|
| `skill_search` | AND-ed keyword lookup over a staged index (skill name / description / upstream repo), returning names, repos, a duplicate count and absolute `SKILL.md` paths |
| `skill_load` | Loads one or more skill bodies into context as `<skill_content>` blocks with their base directories, so `scripts/`, `references/` and `assets/` resolve correctly |

The index is `<workspace>/.skill-src/skill-index.tsv` (`repo`, `relpath`, `name`, `description`, `files`, `KB`), located by walking up from the session working directory — nothing is hard-coded to a drive or path. Both READMEs document the columns and include a reference generator.

### Highlights

- **Zero dependencies, zero imports.** No `node_modules`, nothing to install, no build step.
- **Zero catalog cost.** The tools are a few hundred characters of schema; the library is never injected.
- **Agent-driven selection.** The routing rules live in the tool descriptions, so the model decides which skills to use — the user is not asked to pick.
- **Robust batch loading.** `skill_load` accepts a real array, a JSON-encoded array, or a comma/newline-separated string, because array arguments can arrive stringified.
- **Deterministic duplicate handling.** `skill_search` reports `copies`, `skill_load` takes `repo` to disambiguate, and without a hint the shallowest path wins — a `repo` filter matching nothing says which repos do have the skill instead of silently falling back.
- **Bilingual docs kept in sync** by a test, not by discipline.

### Two bugs this release fixes, each with a regression test

An earlier local build took the DSH host down at startup. A dev-only stub in the package's own `node_modules` shadowed `@deepseek-ai/dsh-tools`, so the author DSL (`output.schema: { type: 'json' }`) reached the tool registry uncompiled and the whole plugin tree refused to load:

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

Definitions are now built locally in standard JSON Schema, and `test/boot-safety.mjs` fails if the package ever ships a `node_modules` or declares a DSH host package as a dependency again.

The second: `skill_load` originally accepted `name` as `oneOf: [string, array]`, which reads well and fails in practice — a stringified array quietly became one nonexistent skill name.

### Tests

```sh
npm test
```

Seven dependency-free scripts. They run against a real staged library when one is reachable and otherwise generate a throwaway fixture, so this tarball is self-testing. CI runs them on Node 20, 22 and 24 with no install step.

### Requirements

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`
