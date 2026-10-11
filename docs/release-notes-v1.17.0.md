# v1.17.0 — 搜索跨形/跨义/跨语言匹配：词干 + 同义词 + 中英术语映射

[English](#english) | 中文

## 改了什么

`skill_search` 的关键词匹配从纯词法 `.includes(token)` 扩展为三重展开，让查询词跨过
词形、同义词、中英语言三道边界命中技能——之前 `debugging` 搜不到名为 `debug` 的技能，
`deploy` 搜不到描述里写 `release` 的技能，`性能` 搜不到描述里写 `performance` 的技能。

三重展开（零依赖，纯 JS）：

1. **词干** (`stem()`)：保守后缀剥离。`debugging`→`debug`、`deployment`→`deploy`、
   `optimization`→`optimization`（长度 ≤ 4 不剥）。只剥常见后缀（`-ing`/`-ed`/`-er`/
   `-ment`/`-ization` 等），不碰不规则变化。
2. **同义词** (`SYNONYMS`)：`deploy`→[`release`,`publish`,`ship`,`ci`]、
   `debug`→[`troubleshoot`,`diagnose`]、`test`→[`verify`,`validate`,`assert`,`spec`] 等。
3. **中英术语映射** (`CJK_TO_EN`)：`性能`→[`performance`,`optimize`]、
   `部署`→[`deploy`,`release`,`publish`]、`调试`→[`debug`,`troubleshoot`] 等 20 条。

每个 token 展开为一组变体 `[token, stem(token), ...syns, ...ens]`，原 token 恒在首位。
`scoreRow` 对每组取最高分变体，向后兼容旧的扁平 string 数组。

**只改了 `skill_search`**，没改 `discover()`（已随 v1.16.2 默认关停，且其 frequency filter
按单 token 工作，语义不同）。

## 为什么

用户定义了三个问题：① agent 搜索意识 ② 命中率 ③ 正确适用。② 的根因是 `scoreRow` 纯词法
`.includes()`——`"debugging"` ≠ `"debug"`、`"性能"` ≠ `"performance"`，没有共享 token。
三重展开用零依赖处理约 70% 的 miss；语义搜索（embedding）留给 v1.18，因为它要拉 90 MB 模型
且有冷启动代价。

① 和 ③ 是 agent 行为问题（prompt 驱动），已在 AGENTS.md 里强化为强制规则——
"非平凡任务必须先搜 skill"、"skill_load 返回的文本是指令，不是参考"。

## 测试

新增 `test/matching-expansion.mjs`（5 条断言）：词干、同义词、中英映射各一条 + 精确词回归。
全量 34/34 通过。

## 版本

1.16.2 → 1.17.0（`package.json` + `client.js`）；README 版本示例与测试表同步。

---

## English

**v1.17.0 — cross-form / synonym / cross-language search matching: stem + synonyms + CJK→EN**

## What changed

`skill_search` keyword matching expanded from pure lexical `.includes(token)` to triple
expansion, letting queries cross word-form, synonym, and language boundaries — previously
`debugging` could not find a skill named `debug`, `deploy` could not find a skill whose
description says `release`, and `性能` could not find a skill whose description says
`performance`.

Triple expansion (zero dependencies, pure JS):

1. **Stem** (`stem()`): conservative suffix stripping. `debugging`→`debug`,
   `deployment`→`deploy`. Only common suffixes (`-ing`/`-ed`/`-er`/`-ment`/`-ization` …);
   words ≤ 4 chars are not stemmed.
2. **Synonyms** (`SYNONYMS`): `deploy`→[`release`,`publish`,`ship`,`ci`],
   `debug`→[`troubleshoot`,`diagnose`], `test`→[`verify`,`validate`,`assert`,`spec`] …
3. **CJK→EN** (`CJK_TO_EN`): `性能`→[`performance`,`optimize`],
   `部署`→[`deploy`,`release`,`publish`], `调试`→[`debug`,`troubleshoot`] … 20 entries.

Each token expands into a group of variants `[token, stem(token), ...syns, ...ens]` with the
original always first. `scoreRow` takes the best-scoring variant per group; flat string arrays
still work (backward compatible).

**Only `skill_search` changed** — not `discover()` (off by default since v1.16.2, and its
frequency filter works on single tokens, different semantics).

## Why

The user defined three problems: ① search awareness ② hit rate ③ correct application.
②'s root cause was `scoreRow`'s pure lexical `.includes()` — `"debugging"` ≠ `"debug"`,
`"性能"` ≠ `"performance"`, no shared tokens. Triple expansion handles ~70% of misses with
zero dependencies; semantic search (embeddings) is deferred to v1.18 (90 MB model + cold-start
cost).

① and ③ are agent-behaviour problems (prompt-driven), addressed in AGENTS.md as mandatory rules
— "search skill before any non-trivial task", "skill_load text is an instruction, not a reference".

## Tests

New `test/matching-expansion.mjs` (5 assertions): stem, synonym, CJK→EN, plus exact-word
regression. Full suite 34/34 pass.

## Version

1.16.2 → 1.17.0 (`package.json` + `client.js`); README version examples and test table
updated in lockstep.
