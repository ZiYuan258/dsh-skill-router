# v1.5.4 — 一次实测把两个真 bug 挖出来了（评审只说对了一半的那些）

[English](#english) | 中文

这一版来自对插件的第三次外部评审。评审的结论方向没错，但它指出的问题里，**有的不成立、有的被低估了**。凡是能测的我都测了——而实测的结果比评审的描述更严重。

## 真 bug 一：一条过期索引记录会让整个检索**抛异常**

评审说"删除的技能搜得到但加载失败"。实际比这重：**`skill_search` 直接抛 `ENOENT`**。

```
Error: ENOENT: no such file or directory, access '…\beta-skills\skills\beta-gadgets\SKILL.md'
    at resolveRow (host.js:337:20)
    at Object.execute (host.js:634:25)      ← skill_search 的 execute
```

原因是 `resolveRow` 无条件调用 `ctx.fs.resolve()`，而它在路径不存在时会抛。触发条件恰好就是评审描述的运维场景：**删掉一个技能目录、忘了重跑索引**。一条坏记录拖垮整个检索——而检索是只读查询，它没有理由因为索引里的一行过时而失败。

现在过期条目标 `stale: true`，模型看到 `STALE: SKILL.md is missing — regenerate the index`，`skill_load` 报的是 **"the index is stale"** 而不是一个读起来像权限问题的原始 fs 错误。`test/stale-and-duplicates.mjs` 钉住这一组行为。

## 真 bug 二：模型看不到 `copies`，却被要求据此行动

搜索结果的脚注写着 **"pass repo too when copies > 1"**，而 render 出来的文本里**没有 copies**——它在 JSON 里有，但模型读的是文本。同时重名候选只显示 `[repo]`，同名同 repo 的多份副本在文本里完全一样。现在重名时会列出候选 repo：

```
note: 5 of these are copies of a name that exists in several repos
      (addyosmani-skills, context-eng-kit, superpowers); pass repo to skill_load to choose.
```

## 评审没提但实测撞上的：退化查询把全库当命中返回

在 1026 行的参考库上：

| 查询 | 改前 | 改后 |
|---|---|---|
| `make a movie` | **total=1026**，命中全是含 `make`/`a` 的无关技能 | total=0 |
| `test setup config helper` | **total=1026**，绝大多数只共享一个常见词 | **total=7** |

`a` 这种词单独贡献 **+130**（权重对"名字/路径命中"一视同仁）。三处修改：

1. **停用词**：`a`、`the`、`make`、`use` 这类无区分度的词在分词阶段丢弃（`STOP_WORDS`）。词表刻意保持短——按"哪都出现"过滤会砸掉 `test`、`config` 这种常见但有用的词，那是另一种错误。
2. **部分匹配的准入阈值**：候选必须命中"除一个以外的全部"关键词，否则宁可直接回答"没找到"（`fallback: "weak"`）。
3. **头部不再伪装**：`0 exact match(es); 7 partial match(es) — no entry contained every keyword`，并在 JSON 里给出 `strict: 0`。

## 评审说错的几条

| 评审的说法 | 实际情况 |
|---|---|
| "没有声明依赖哪些 DSH 内部 API，也没有声明兼容版本范围" | `package.json` 里有 `dsh.engines.dsh = ">=0.1.5-rc.1"`、`dsh.requires`（5 个 API）、`dsh.optional`（3 个）；README 第 125 行整段专门讲这件事，包括"这是已验证下限，不是过度声明" |
| "用户说'做视频'，描述写'生成动态影像'，搜不到" | 中文根本不进分词器：**零关键词**。原因不是词不匹配。现在报错会说明"索引按拉丁字符匹配，请传英文关键词" |
| "纯关键词匹配"暗含可用性低 | 1025 个 `SKILL.md` 的 description 几乎都是英文。agent 面向的模型本来就会把用户的语言翻成英文关键词 |
| "可疑技能如何判断没有标准" | `tools/audit-library-risk.mjs` 就是那个标准，且可重跑；`SECURITY.md` 有威胁模型；README 第七节讲隔离 |
| "索引文件本身是泄露面" | 索引与库在同一个文件系统里，同级可达。隔离出库目录的时刻，索引也一起隔离了 |

## 评审说对的、但仍然没解决的

这些我没动，也不打算假装解决了：

- **固定成本是真实的**：工具 schema 约 **1,001 token/轮**，不随库增长但也不消失。这个数字 README 里一直写着（评审也是从这里读到的）。
- **临界点依赖检索频率**，而频率无法在部署前预估。README 给的是实测对照（1,541 vs 3,603 B），不是公式。要算自己的账，只能拿自己的库去量。
- **关键词检索没有语义**：同义词、改写表述都不命中。这是设计取舍，不是缺陷——换来的是零依赖、无网络、可预测、可复现。
- **`whenToUse` 在参考库里的使用率是 0/1025**：机制存在，数据里没人用。README 已如实标注。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

## 测试

十五个（原十四个 + `stale-and-duplicates.mjs`），CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

This release comes from a third external review of the plugin. The review's direction was fair, but of the problems it named, **some do not hold and some are understated**. Everything checkable was checked — and the measurements came out worse than the review described.

### Real bug 1: one stale index row made the whole search **throw**

The review said a deleted skill is "searchable but fails to load". It is worse than that: **`skill_search` throws `ENOENT`**.

```
Error: ENOENT: no such file or directory, access '…\beta-skills\skills\beta-gadgets\SKILL.md'
    at resolveRow (host.js:337:20)
    at Object.execute (host.js:634:25)      ← skill_search's execute
```

`resolveRow` called `ctx.fs.resolve()` unconditionally, and that throws when the path does not exist. The trigger is exactly the operational scenario the review described: **delete a skill directory and forget to regenerate the index**. One bad row took down the entire retrieval — and retrieval is a read-only lookup with no business failing because a row is out of date.

Stale rows are now flagged `stale: true`, the model sees `STALE: SKILL.md is missing — regenerate the index`, and `skill_load` reports **"the index is stale"** rather than a raw fs error that reads like a permissions problem. `test/stale-and-duplicates.mjs` pins the whole group.

### Real bug 2: the model could not see `copies` while being told to act on it

The search footer says **"pass repo too when copies > 1"**, and the rendered text carried **no copies count** — it was in the JSON, but the model reads the text. Duplicated candidates also showed only `[repo]`, so several copies inside one repo were indistinguishable. Duplicates now list the repos to choose between:

```
note: 5 of these are copies of a name that exists in several repos
      (addyosmani-skills, context-eng-kit, superpowers); pass repo to skill_load to choose.
```

### Not in the review, found by measuring: degenerate queries returned the whole library

On the 1026-row reference library:

| Query | Before | After |
|---|---|---|
| `make a movie` | **total=1026**, all of it ranked on `make`/`a` | total=0 |
| `test setup config helper` | **total=1026**, nearly all sharing one common word | **total=7** |

A word like `a` alone scored **+130** (the weights reward any name/path hit equally). Three changes:

1. **Stop words**: `a`, `the`, `make`, `use` and similar carry no signal and are dropped during tokenization (`STOP_WORDS`). The list is deliberately short — filtering by "appears everywhere" instead of "means nothing" would break `test` and `config`, which is the opposite mistake.
2. **An admission threshold for partial matches**: a candidate must hit every keyword but one, otherwise the honest answer is "nothing found" (`fallback: "weak"`).
3. **The header stops dressing it up**: `0 exact match(es); 7 partial match(es) — no entry contained every keyword`, with `strict: 0` in the JSON.

### What the review got wrong

| Claim | Reality |
|---|---|
| "does not declare which DSH internal APIs it depends on, nor a compatible version range" | `package.json` declares `dsh.engines.dsh = ">=0.1.5-rc.1"`, `dsh.requires` (5 APIs) and `dsh.optional` (3); the README devotes a full paragraph to it, including "this is the verified floor, not over-claiming" |
| "a user says 做视频, the description says 生成动态影像, no match" | Chinese never reaches the tokenizer: **zero keywords**. The cause is not wording. The error now explains that the index matches Latin script and asks for English keywords |
| "pure keyword matching" implies poor usability | The descriptions across 1025 `SKILL.md` files are almost entirely English, and the model the agent runs on translates the user's language into English keywords anyway |
| "no stated criteria for what counts as suspicious" | `tools/audit-library-risk.mjs` is that criterion and is re-runnable; `SECURITY.md` carries the threat model; README section 7 covers quarantine |
| "the index file is itself a leak surface" | The index sits beside the library on the same filesystem. Quarantining the library directory quarantines the index with it |

### What the review got right and remains unaddressed

Not touched here, and not pretended otherwise:

- **The fixed cost is real**: about **1,001 tokens/turn** for the tool schemas, which does not grow with the library but does not disappear either. The README has always said so — that is where the review read it.
- **The break-even point depends on retrieval frequency**, which cannot be estimated before deployment. The README gives a measured comparison (1,541 vs 3,603 B), not a formula. Working out your own figures means measuring your own library.
- **Keyword retrieval has no semantics**: synonyms and rephrasings miss. That is a design trade, not a defect — it buys zero dependencies, no network, and predictable, reproducible results.
- **`whenToUse` is used 0 times in 1025 files**: the mechanism exists, the data does not use it. The README says so plainly.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`

### Tests

Fifteen (fourteen plus `stale-and-duplicates.mjs`), green on Linux and Windows × Node 20 / 22 / 24.
