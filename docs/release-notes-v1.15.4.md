# v1.15.4 — 候选提示显示真实描述，而不是命中的字段名

[English](#english) | 中文

**这是一次渲染错误的修复，不是新功能。** discovery 算法、tokenizer、常见词阈值、去重、HIGH 阈值、分臂方式、`firstEligible` 定义**全部没动**——只有提示怎么渲染改了。

## 修的是什么

注入的提示原本长这样：

```
Maybe relevant skills for this task: semgrep (name, description, path); code-review-and-quality (name, description, path); …
```

代码是这么写的：

```js
const parts = result.candidates.map((c) =>
  c.fields.length === 0 ? c.name : c.name + ' (' + c.fields.join(', ') + ')')
```

`c.fields` 是**命中的字段名**。实测 467 个候选里 **304 个**的三个字段全部命中（`["name","description","path"]`），于是几乎每一行都渲染成同一个括号——**一个写在括号里的字面量**。

模型拿到五个陌生技能名 + 一句"三个字段都命中了"，判断相关性的依据是**零**。

## 证据链

| 观测 | 数值 |
|---|---|
| 同一会话里原生 `skill` 工具（常驻目录）调用 | 4 次，全部成功 |
| 同一会话里 `skill_search` / `skill_load` | 14 / 11 次，其中绝大多数是我自己的调试探针 |
| 那 11 次 `skill_load` 里加载**只有库里有**的技能 | **0 次** |
| 遥测：63 个结算回合里 `skill_search` / `skill_load` | 2 / 0 |
| 遥测：插件注入过候选提示 | 14 次，事后**零次**库加载 |

最后两行不能单独证明"提示无效"（其中 13 次发生在 v1.15.0 之前，`arm=undefined`），但它们和"提示信息量为零"这个事实一致：**模型没有理由点开一个只有名字、没有说它是干什么的陌生技能。**

## 改成什么

```
Maybe relevant skills for this task: semgrep — Runs a Semgrep security scan over a codebase: detects langu…; code-review-and-quality — Conducts multi-axis code review. Use before merging any cha….
```

名字 + 截到 **60 字符**的真实描述。空描述退化成只有名字，不会出现空破折号。

真库实测（`D:\Vibe coding\.skill-src`，1028 行索引）：

| 任务 | 旧 | 新 |
|---|---|---|
| `Run a semgrep security audit on this repo` | 344 B | **549 B** |
| `review my code before merging this PR` | 329 B | **534 B** |
| `fix a rendering bug in a plugin hint string` | 327 B | **532 B** |

三个任务的候选描述都非空。**代价约 57 字节/注入回合**，换来的是提示从"零信息"变成"有信息"。

## 一个必须记下的东西：这次要重起 T0

`hint wording` 原本在冻结清单里，**这一版把它解冻了**。所以：

- v1.15.4 之前的所有读数，其 treatment 臂的提示与之后的**不是同一个刺激**；
- 重新计时的起点是**装上 v1.15.4 之后新建的会话**，不是重启；
- 旧数据不删除——它记录的是"零信息量提示"下的行为，那本身是一个有效读数。

## 测试

新增 3 条断言（`test/discovery-injection.mjs`），判据是**描述文本本身出现在提示里**，而不是"提示非空"：

- 提示含候选的真实描述；
- 不再出现 `(name, description, path)`，也不再出现裸字段名 `(name` 或 `whenToUse`；
- 名字与描述之间是可见分隔符 `—`，不是靠括号。

写这几条时我又踩了一次夹具坑：第一版同时断言夹具里**两个**技能的描述，而任务是 `semgrep security audit`，只有 `semgrep` 是候选——`Evidence before claims`（另一个技能）从来不在这一行里。**那个红是夹具错了，不是代码错了**，断言现在只断实际出现的候选。

## English

**This is a rendering-bug fix, not a feature.** The discovery algorithm, tokenizer, common-token threshold, dedupe, HIGH threshold, arm assignment and `firstEligible` definition are all untouched — only how the hint renders changed.

**What was wrong.** The injected hint read `semgrep (name, description, path)`. The code mapped `c.fields`, which holds the **names of the fields that matched**. In a measurement over 467 candidates, **304** matched all three fields, so nearly every line rendered the same parenthetical: a literal. Five unfamiliar skill names plus "all three fields matched" gave the model **nothing** to judge relevance by.

**The evidence.** In one real session the native `skill` tool (resident catalog) was called 4 times and succeeded every time, while `skill_search`/`skill_load` were called 14/11 times — mostly by my own debugging probes. Of the 11 loads, **zero** loaded a skill that exists only in the library. Telemetry agrees: across 63 settled turns, 2 searches and 0 loads; across 14 injected hints, **zero** library loads followed. Those last two numbers cannot on their own prove the hint was ineffective (13 of the 14 predate v1.15.0 and carry `arm=undefined`), but they are consistent with a hint that carried no information: the model has no reason to open a strange name that never says what it does.

**What it says now.** The name plus a real description capped at 60 characters, measured on the real 1028-row library: 329–344 bytes becomes 532–549 bytes across three tasks, costing ~57 bytes per injected turn.

**One thing worth recording: this restarts T0.** `hint wording` was on the freeze list and this release unfreezes it. Every readout taken before v1.15.4 had a different stimulus in its treatment arm; the new clock starts at sessions **created** after v1.15.4 is installed, not at the restart. The old data is not deleted — it is a valid readout of behaviour under a zero-information hint.

**Three new assertions** in `test/discovery-injection.mjs`, whose criterion is that the description text itself appears in the hint rather than merely that the hint is non-empty: the real description is present; `(name, description, path)` and bare field names are gone; and a visible `—` separates name from description. Writing them I tripped over the fixture again — the first version asserted both skills' descriptions while only `semgrep` was a candidate for that task, so **the red was the fixture's fault, not the code's**, and the assertion now covers only the candidate that actually appears.
