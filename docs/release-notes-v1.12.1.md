# v1.12.1 — 候选生成器的判别力修复：语料频率过滤、按名字去重、tier 重算

[English](#english) | 中文

v1.12.0 开了 HIGH 注入，然后**实验失败了**——但失败的证据指向的不是触发层，而是**候选生成器本身**。

## 实测到的两个缺陷

**缺陷一：零判别力的词在参与评分。** 真库实测：

```
skill    1028 / 1028 条命中  (100%)
skills   1028 / 1028 条命中  (100%)
```

一个**全库都有的词**给每一行都加分，等于没加分——但它能赢下排序。于是注入的候选是：

```
turn 83（任务："我要更新 DSH"）
  azure-identity-py, entra-agent-id, gke-workload-identity, secure-workflow-guide, academy-guide
```

`tier=HIGH` 成立，而候选集不含任何信息。**HIGH 当时只意味着"命中了一个高分词，而那个词可能是 `skill`"。**

**缺陷二：同一技能的多份副本占多个名额。**

```
turn 69  implement-task, implement-task, implement-task, huggingface-llm-trainer, add-task
```

5 个名额里 3 个被同一个技能占掉。真机上也发生了——用户贴出来的提示里 `finding-google-skills` 出现了两次。

**因此 v1.12.0 的实验结论无效**：`turn 69/83` 的工具计数都是 `search=0 load=0`，但用一组被证明是噪声的干预去测"Agent 会不会响应提示"，零响应证明不了 Agent 不响应——只能证明这个提示不值得响应。**这批数据不再用于判断。**

## 三个修复

### ① 语料频率过滤（只作用于 discovery）

```
出现率 > 80%  →  丢弃（判别力 < 20%）
```

**为什么是算出来的而不是写进 `STOP_WORDS`**：`skill` 不是语言噪声，它对这个**具体语料**零信号——而哪些词零信号，随库变化。静态表列不出来（这张表本来就是为 `make`/`a` 那次事故建的，仍然漏了 `skill`/`skills`）。所以从索引算 `document frequency`。

**只作用于 discovery，`skill_search` 一个字节不改。** 过滤那里会悄悄改变用户显式调用的既有行为。

`corpusFrequency()` 返回完整统计（不只是过滤），所以遥测能说清**哪些词被丢了、有多常见**——"skill 占语料 100%"是解释，短一截的候选列表不是。

新增 `reason: "no-discriminating-token"`：全部关键词都太常见时，诚实地报"没有判别力"，而不是拿它们硬排一个榜。

### ② 按技能名去重

```
rows → score → **按规范化名分组，每组保留最高分** → 排序 → top 5
```

同名多份的消歧是 `skill_load` 已有的机制（`copies` / `repo` 提示），discovery 不该把同一个名字当成三个候选。

### ③ tier 在去重后、且只在有效 token 上计算

两个半句都重要：

- 在**原始 hits** 上算，同一技能的三个副本可以互相充当 best/runner-up；
- 在**原始 token** 上算，`skill`（100% 词）可以充当"两个独立命中"之一——这正是噪声集能拿到 HIGH 的路径。

所以 HIGH 现在的语义是：**两个不同的、对语料有判别力的词支持这个候选**。

### ④ 调试开关：任务 token 默认不落盘

默认只记数量（`tokenCount` / `effectiveTokenCount` / `filteredCommonTokens` / `ignoredTokens` 的比例）。要排查候选质量时才打开，两条路都留着：

```yaml
config:
  discovery:
    debugTokens: true
```

或 `DSH_SKILL_ROUTER_DEBUG_TOKENS=1`（两条路都留，因为"cordis 是否把 config 交给挂载的行"本仓库还没验过）。打开后多一个 `tokensUsed` 字段。

**为什么默认关**：token 不是完整原文，但仍可能带着项目名、客户名、漏洞编号。关掉时该字段是 `undefined` 而不是 `[]`，这样读日志的人能分辨"没记"与"记了但为空"。

## 修复效果（真库实测）

| 任务 | 修复前 | 修复后 |
|---|---|---|
| `Run a semgrep security audit…` | 噪声候选 | **`semgrep`** 第一（score 226，命中 5 个词） |
| `review my code before merging this PR` | 噪声候选 | **`code-review-and-quality`** 第一（score 308） |
| 含 `skill`/`skills` 的任务 | 候选重复、HIGH 污染 | 两词被丢弃并登记（各 100%），候选去重 |

## 测试：新增 29 条断言，而且它们是**先失败过**的

`test/discovery-ranking.mjs` 覆盖语料过滤、去重、tier 语义、以及"修复不能把所有东西压成 NONE"。有几条断言的失败是**我自己的判据错了**，值得记下来：

- **`恰好 80% 该丢还是该留`**：我先写了断言、才去核语义。代码是 `<= 0.8` 保留（丢弃条件是**严格大于** 0.8）。语义是对的——出现率 80% 仍有 20% 判别力，翻成 `>= 0.8 丢` 会让 80% 与 100% 一样被当成零信号。改的是断言。
- **`semgrep 必须排第一`**：夹具里 `security-audit` 两个词都命中**名字**（`nameHits=2`，权重 100/个），分数高于只命中一个名字的 `semgrep`。两个候选都相关，排序合理。**断言"必须第一"是我的判据错了，不是代码错了**；真库上 `semgrep` 确实第一，那条断言单独成立。
- **边界夹具**：第一版每个描述都写了 `'skill z'`，于是两个词都 100%、全被丢弃——测的是"全丢"而不是"边界"。

## 一个旁证：索引缓存不需要重启

遥测里 `indexRows` 仍是 1025，磁盘索引已是 1028。核实了缓存键：`<root>|<version>`，而 `version` 是文件的 mtime——**索引一变缓存就失效**。所以不必为了换语料而重启，也不会拿两个版本的语料做 A/B。

## 这一版仍然**不碰**

严格 AND（`skill_search` 的第二瓶颈）、中文 aliases、embedding、常驻目录、MEDIUM 注入。下一个实验的问题只有一个：

> **当系统给 Agent 一个真正有判别力的候选提示时，它会不会开始主动 `skill_search` → `skill_load`？**

质量门槛（下一轮实验用，不是产品 KPI）：50 个 eligible turns 里，人工抽样 HIGH 的 top-5 **至少含一个明显相关技能** 的比例：

| 比例 | 判断 |
|---|---|
| < 30% | discovery 仍不可信 |
| 30–50% | 有信号，但不能放心注入 |
| 50–70% | 开始有实用价值 |
| > 70% | 可以认真测触发效果 |

## English

v1.12.0 turned injection on and **the experiment failed** — but the evidence pointed not at the trigger layer but at the **candidate generator itself**.

**Two measured defects.** First, tokens with zero discriminative power were scoring: on a 1,028-row library `skill` and `skills` each appear in **1,028 of 1,028 rows (100%)**. A word every row contains adds the same score to every row, which is to say nothing — but it wins the ranking. So discovery injected `azure-identity-py / entra-agent-id / gke-workload-identity` for the task "I am about to update DSH", at `tier=HIGH`. HIGH meant only "a high-scoring word matched, and that word may have been `skill`". Second, several copies of one skill took several of the five slots: `implement-task ×3` in one real hint, and a live duplicate of `finding-google-skills` in the hint a user pasted.

**The v1.12.0 conclusion is therefore void.** Both injected turns counted `search=0 load=0`, but measuring "does the agent respond to a hint" with a provably noisy intervention cannot show the agent does not respond — only that this hint was not worth responding to. That batch is no longer used for judgement.

**Three fixes.** A **corpus-frequency filter** in discovery only (> 80% of rows → dropped, under 20% discrimination), computed from the index rather than added to `STOP_WORDS`, because `skill` is not language noise — it is zero signal *for this corpus*, and which words those are changes with the library. `skill_search` is untouched: filtering there would silently change an explicit tool call. A **dedupe by skill name** keeping each name's best-scoring copy, since disambiguating copies is already `skill_load`'s job. And **tier computed over the deduped effective tokens** — over raw hits, three copies of one skill vouch for each other as best and runner-up; over raw tokens, a 100%-frequency word counts as one of the two independent matches, which is exactly how a noise set reached HIGH.

Tokens are **not written to disk by default** — only counts, plus the discarded words and their ratios, so the filter is legible instead of a silent subtraction. A `debugTokens` switch (config or environment variable) adds a `tokensUsed` field, `undefined` rather than `[]` when off so "not recorded" is distinguishable from "recorded and empty".

**Measured effect on the real library:** `Run a semgrep security audit…` now ranks `semgrep` first (score 226, five tokens matched) and `review my code before merging this PR` ranks `code-review-and-quality` first (score 308), where both previously produced noise.

**29 new assertions**, several of which failed first because *my criteria* were wrong, not the code: I wrote the "80% should be dropped" assertion before checking the semantics (the drop condition is strictly greater than 0.8, which is the defensible reading — 80% still carries 20% discrimination); and I asserted `semgrep` must rank first in a fixture where `security-audit` matches both words in its **name** (`nameHits=2`), which legitimately outscores it. On the real library `semgrep` does rank first, and that assertion holds there.

**Index caching needs no restart**, incidentally: the cache key is `<root>|<version>` where version is the file's mtime, so a changed index invalidates it — no risk of A/B-ing two different corpora.

**Still untouched:** the strict-AND policy, Chinese aliases, embeddings, the resident catalog, and MEDIUM injection. The next experiment asks one question: **when the system offers a genuinely discriminative hint, does the agent start calling `skill_search` → `skill_load`?** Quality gate for the next round (not a product KPI): of 50 eligible turns, the share where a HIGH top-5 contains at least one clearly relevant skill — under 30% means discovery is still untrustworthy, 30–50% is signal without confidence, 50–70% is becoming useful, above 70% is worth testing the trigger seriously.
