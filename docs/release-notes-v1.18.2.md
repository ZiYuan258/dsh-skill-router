# v1.18.2 — 适配 DSH 0.2.2-rc.1：引擎范围补上 0.2.2 tuple

[English](#english) | 中文

**运行代码不变。** 这一版只做一件事：让 `dsh.engines.dsh` 的声明继续对得上事实。

## 背景

DSH 从 0.2.1-rc.5 升到 **0.2.2-rc.1**。插件照常加载、`skill_search` / `skill_load` / `skill_ref` 三个工具照常可用，全套测试里只有一条变色：`test/engine-range.mjs` 的「本机已装的 harness 0.2.2-rc.1 落在范围内」报 FAIL。

这条不是回归，是 v1.18.1 里写下的那条**已知边界**到期了。原文：「注意 0.2.2+ 的**预发布**不在范围内（semver 的 tuple 规则要求逐一列举），这是已知边界；一旦它成为真实安装版，下面那条『已装版本在范围内』会报出来。」现在它确实报出来了——断言按设计工作。

## 改了什么

### `dsh.engines.dsh` 补 0.2.2 这一格

node-semver 的预发布规则要求：只有某个比较符的 major.minor.patch 元组与目标完全相同、且该比较符自身也带预发布标签时，带预发布标签的版本才被接纳。旧范围最后一段是 `>=0.2.1-0 <0.3.0-0`，它覆盖 0.2.1 的预发布，但 0.2.2 的 tuple 没有对应的预发布分支，于是 `0.2.2-rc.1` 落空。现在末段按 tuple 拆成两格：

```
... || >=0.2.1-0 <0.2.2-0 || >=0.2.2-0 <0.3.0-0
```

用真实 semver（7.8.6，DSH 自带的那份）交叉验证：旧范围对 `0.2.2-rc.1` 判 false，新范围判 true；`published` 全 17 个版本一个不漏，`rejected` 三个越界版本一个不误纳。

`test/engine-range.mjs` 同步：`published` 加入 `0.2.2-rc.1`（17 个），tuple 覆盖断言由五个扩到六个，已知边界的注释从 0.2.2+ 改成 0.2.3+。

### 版本与文档

`package.json` 与 `client.js` 的版本号升到 1.18.2；`README.md` / `README.en.md` 里引擎范围的说明与测试表（tuple 列表、已发布版本计数、版本示例）同步更新。

## 实测

| 检查 | 结果 |
| --- | --- |
| `npm test` | 全部通过 |
| `test/engine-range.mjs` | 本机已装的 harness 0.2.2-rc.1 落在范围内 |
| 真实 semver 交叉验证 | 接纳 17 / 17，拒绝 3 / 3 |

## 没有改什么

`host.js` 行为、`client.js` 行为（只动了版本号常量）、搜索算法、注入层开关——都没动。新增依赖：无。

（顺带说明两件事。其一：DSH 0.2.2 仍不强制 `dsh.engines.dsh`——bundle 加载期读的是**顶层** `engines.dsh`，本插件把范围写在嵌套的 `dsh.engines.dsh` 里，所以这条声明今天唯一的外部读者是插件市场。其二：市场那边调用的还是同一个闸门，而闸门内部用的是 `includePrerelease: true` 的语义；用官方 `evaluatePluginCompatibility` 对 0.2.2-rc.1 实测，**旧范围同样判 `compatible: true`**。也就是说旧范围没有在任何门控上失败过，唯一按默认语义（不带 `includePrerelease`）判它的是本仓库自己的 `test/engine-range.mjs`。这一版修的是「声明与事实一致」，不是「通不过门控」。）

---

## English

**No runtime behavior change.** One thing only: keep `dsh.engines.dsh` telling the truth.

## Background

DSH moved from 0.2.1-rc.5 to **0.2.2-rc.1**. The plugin still loads, `skill_search` / `skill_load` / `skill_ref` still work, and exactly one test turned red: `test/engine-range.mjs`'s "installed harness 0.2.2-rc.1 is inside the range" reported FAIL.

That is not a regression; it is the known boundary documented in v1.18.1 coming due: prereleases of 0.2.2+ were outside the range because the semver tuple rule requires enumerating each tuple, and the check was written to report it once such a build became the installed one. It now has.

## What changed

`dsh.engines.dsh` gains the 0.2.2 slot. node-semver admits a prerelease only when a comparator's major.minor.patch tuple matches it exactly and that comparator itself carries a prerelease tag; the old final branch `>=0.2.1-0 <0.3.0-0` covered 0.2.1 prereleases but had no prerelease branch for the 0.2.2 tuple, so `0.2.2-rc.1` fell through. The final branch is now split per tuple: `... || >=0.2.1-0 <0.2.2-0 || >=0.2.2-0 <0.3.0-0`.

Cross-checked against the real semver (7.8.6, the copy DSH ships): the old range says false for `0.2.2-rc.1`, the new one says true; all 17 published versions are admitted and none of the 3 out-of-range versions is.

`test/engine-range.mjs` follows: the `published` list gains `0.2.2-rc.1`, the tuple-coverage assertion grows from five tuples to six, and the known-boundary comment now reads 0.2.3+. `package.json` and `client.js` move to 1.18.2, and both READMEs get the matching range description, tuple list, version count and version examples.

## What did not change

`host.js` behavior, `client.js` behavior (only the version constant), the search algorithm, the injection flag. New dependencies: none.

(Two notes for the record. First: DSH 0.2.2 still does not enforce `dsh.engines.dsh` — the bundle-load gate reads a **top-level** `engines.dsh`, while this plugin nests the range under `dsh.engines.dsh`, so the plugin market is its only external reader today. Second: the market calls that same gate, and the gate evaluates with `includePrerelease: true`; measured with the official `evaluatePluginCompatibility` against 0.2.2-rc.1, the **old range also reported `compatible: true`**. The old range therefore never failed any gate — the only thing reading it under default semantics (no `includePrerelease`) is this repository's own `test/engine-range.mjs`. This release fixes declaration accuracy, not a gate.)
