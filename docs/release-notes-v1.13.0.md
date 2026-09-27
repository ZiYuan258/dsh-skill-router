# v1.13.0 — 两个测量层修复：token 文本不再默认落盘、配对键改为 (会话, 回合)

[English](#english) | 中文

候选生成器在 v1.12.1 已经可以做实验了。这一版**不改候选质量**，只修测量层——因为这两处会让实验结果算错。

## 修复一：被过滤的 token 曾经无条件落盘（隐私）

**缺陷是真的。** `discoveryRecord()` 里：

```js
// v1.12.1 的写法：没有 debug 门
ignoredTokens: ignored.map((item) => ({ token: String(item.token), ratio: … }))
```

只有 `tokensUsed` 受 `debugTokens` 控制。而被过滤的词**不一定是** `skill`/`skills`——它可能是项目名、客户名、漏洞编号，**恰恰是"在一个组织的语料里到处都是"的那类词**（否则也不会被频率过滤器盯上）。"不是完整原文"不等于"无害"，我自己的代码注释就承认了这一点。

**现在**：

```json
{
  "tokenCount": 5,
  "effectiveTokenCount": 2,
  "filteredCommonTokens": 3,
  "ignoredTokenRatios": [1, 0.94, 0.83]
}
```

比例**始终**写（仍然能解释过滤器："丢了 3 个词，都在 83% 以上"），**文本只在 `debugTokens: true` 时写**。关闭时字段是 `undefined` 而不是 `[]`，这样能分辨"没记"与"记了但为空"。

### 一个必须说清的事实：缺陷存在，但还没造成泄露

真机遥测里唯一那条带 `ignoredTokens` 的记录，**数组是空的**——过滤器在真机上还从未丢过任何词。所以没有泄露发生。

**但这是运气，不是保护**：区别在于"还没触发"和"有防护"。它随时会在下一条中文或含项目名的任务上触发。所以现在修，而不是等它触发之后再解释。

## 修复二：配对键改为 `(会话标签, 回合)`

分析脚本第一版按 `turn` 配对。而遥测里**没有会话标识**——多会话写同一个日志时，两个会话各自的 `turn 12` 是同一条记录。**实测**：

```
同一个 turn 号出现多次的: 14 个
  turn 1 出现 3 次
  turn 2 出现 3 次
  …
turn=1 的记录（三个不同会话各自的第 1 回合）:
  2026-09-25T07:53  tier=HIGH  候选=add-task,add-task
  2026-09-25T07:58  tier=HIGH  候选=agent-framework-azure-ai-py,…
  2026-09-25T14:08  tier=HIGH  候选=add-task,add-task
```

按 `turn` 配对会把**不同会话合并**——足以把结论算反。

**修复**：计数状态从模块级改成**按会话**（并发会话不再互相污染），两类记录都带 `sessionKey`：会话 id 的 **sha256 前 8 位**。用哈希前缀而不是 id 本身，因为配对只需要相等、不需要身份，而日志没有理由带上宿主的会话标识。

**旧记录不会被假装成可配对的**：没有 `sessionKey` 的记录用 `(none)` 兜底并**单独报出条数**。读数脚本现在直接说：

```
无会话标签：  118 条旧记录（v1.12.1 之前写的，配对不可靠，已排除）
```

## 修复三：读数脚本本身（`tools/discovery-report.mjs`）

三件事，都是为了让"未知"不被当成"0"：

**① 右截断必须显式处理。** 按回合的计数天生如此：

```
回合 10 开始 → 累计调用
回合 11 开始 → 才把回合 10 的数落盘
```

所以最后一个已完成的回合、以及中止/崩溃的回合**没有** turn-calls 记录。若把"没有记录"当成 `search=0`，**5 个未配对的回合混进 50 个样本，足以把上升的搜索率算成没变化**。脚本只统计 **paired**，并把 unpaired 报成 unknown：

```
可配对：   36 个回合（**下面所有比率的分母**）
不可配对：  82 个回合 → **unknown，不是 0**
```

**② 字段名不能有歧义。** `injected.turns` 实际是"可配对的注入回合数"，名字却像"所有注入回合"。改名为 `pairedTurns`——在一个用来定结论的脚本里，这种歧义本身就是缺陷。

**③ `indexRows` 多个取值要报警**：那意味着语料换过，跨这些回合的对比不可靠。

## 顺手修掉的过期证据数字

`host.js` 的注释里还写着 `a five-name hint measures ~57`。真库实测是 **329–341 字节（~91–95 token）**。这个项目已经证明过：**错误的证据数字比没有数字更危险**。现在那处注释写的是实测值，并注明旧数字来自短样本名。

## 一个次要发现：1025 不是 bug，是我的口径错了

我先前说"遥测的 1025 vs 磁盘的 1028 是缓存不同步"。**核实后是我错了**：

```
索引文件行数（不含表头）:  1028
插件解析器数出的数据行:    1025   ← 正确
被跳过的行: 3
  {"repo":"microsoft-skills","relpath":"…/azure-app-onboard/deploy","name":""}
  {"repo":"microsoft-skills","relpath":"…/azure-app-onboard/prepare","name":""}
  {"repo":"microsoft-skills","relpath":"…/azure-app-onboard/scaffold","name":""}
```

`build-index.mjs` 给这 3 行用目录名兜底了 `name`，而插件的索引契约会**跳过缺 `name` 的行**。所以 **1025 是可用技能数，1028 是行数**，遥测一直是对的。

（这三条是否该从索引侧补上 `name`——那是库质量问题，不是插件逻辑问题，**留给你决定**，本版不动。）

## 测试

新增 `test/discovery-report.mjs`（25 条断言），全部围绕那一个陷阱：

- 未配对的回合**不进分母**，并断言"错误算法会把它算成 33%、正确是 100%"这组反例；
- 两个会话的同号回合各自配对、计数不互相污染；
- 无会话标签的旧记录被单独报出，且能配对的仍然配对；
- 坏行被计数而不是抛出，也不影响其余记录；
- `--json` 输出**不含 token 文本**。

写这个测试时我又踩了三次**夹具**坑（`legacy` 只数发现记录、`injected` 两边不一致、`sessionKey` 两边不一致），三次都是我改测试而不是改产品。同一个模式重复出现，值得记下：**夹具与被测语义不一致，会造出看起来像产品缺陷的失败**。

## 现在可以开始实验了

这一版之后测量边界是干净的：候选有判别力、token 文本不落盘、配对有会话标签、未知不被当成 0。

按你定的四档看 50 个**可配对**的回合里 HIGH 的 top-5 至少含一个明显相关技能的比例（<30% 不可信 / 30–50% 有信号 / 50–70% 可用 / >70% 值得测触发），以及四种结果各自指向的下一步。

## English

The candidate generator became experiment-ready in v1.12.1. This version changes **no candidate quality** — it fixes the measurement layer, because both defects could make the experiment's numbers wrong.

**Fix one: filtered tokens were written unconditionally.** `discoveryRecord()` recorded `ignoredTokens` with no debug gate; only `tokensUsed` was gated. A filtered word is not necessarily `skill` or `skills` — it can be a project name, a customer name, a vulnerability id, which is precisely the kind of word that is everywhere inside one organization's corpus (and therefore the kind the frequency filter targets). "Not the whole task text" is not the same as "harmless", as my own code comment admitted. Ratios are now **always** written (they still explain the filter: "three words dropped, all above 83%") and the words **only** under `debugTokens: true`, `undefined` rather than `[]` when off.

**One fact that has to be stated precisely: the defect existed but nothing leaked.** The single live record carrying `ignoredTokens` had an **empty** array — the filter has never actually discarded a word in production. That is luck, not protection, and the distinction matters: it was one Chinese task or one project name away from firing. Fixed now rather than explained later.

**Fix two: the pairing key is `(sessionKey, turn)`, not `turn`.** Telemetry carried no session identity, so two sessions that both reached turn 12 were the same row. Measured on the live log: **14 turn numbers were duplicated**, `turn` 1 appearing three times across three different conversations. Pairing by `turn` alone merges conversations, which is enough to invert a conclusion. Counting state is now **per session** (concurrent sessions cannot pollute each other) and both record types carry `sessionKey` — the first 8 hex characters of a sha256 of the session id, because pairing needs equality and not identity. Legacy records without the label are counted and reported rather than passed off as pairable: *"118 legacy records, pairing unreliable, excluded"*.

**Fix three: the readout script itself** (`tools/discovery-report.mjs`). Per-turn counting is right-truncated by design — a turn settles at the next turn — so the last completed turn and any aborted turn have no `turn-calls` record. Treating "no record" as `search=0` means **five unpaired turns among fifty can turn a rising search rate into no change**, so the script counts only **paired** turns and reports the rest as unknown. The ambiguous field `injected.turns` (which meant "pairable injected turns") is now `pairedTurns`, because an ambiguous name in a script that decides conclusions is itself a defect. Multiple `indexRows` values raise a warning: the corpus changed and comparisons across it are unreliable.

**Also corrected a stale evidence number**: a comment still claimed a five-name hint measures ~57 tokens; the real library measures 329–341 bytes (~91–95 tokens). This project has already established that a wrong evidence number is more dangerous than no number.

**A secondary finding: 1025 was not a bug — my framing was wrong.** I had called it a cache mismatch. The plugin's parser yields **1025** data rows from a 1028-row file and skips exactly 3 whose `name` is empty (three Microsoft monorepo entries), because the index contract drops rows without a name. So 1025 is the usable skill count and 1028 is the line count, and telemetry was right all along. Whether those three should get a name from the index side is a library-quality question, not plugin logic, and is left to the owner.

**25 new assertions** in `test/discovery-report.mjs`, all aimed at the one trap: unpaired turns stay out of the denominator (with an explicit counter-example showing the wrong arithmetic yields 33% where the right one yields 100%), same-numbered turns in two sessions pair separately without polluting each other, legacy records are reported separately while still pairable ones pair, malformed lines are counted rather than thrown, and `--json` output carries no token text. Writing it I tripped over my own **fixtures** three times (legacy counted only discovery records, `injected` and `sessionKey` inconsistent between the two fixtures) and fixed the test rather than the product each time — the same pattern repeating, and worth recording: a fixture that disagrees with the semantics under test manufactures failures that look like product defects.

**The experiment can start now.** After this version the measurement boundary is clean: discriminative candidates, no token text on disk, session-labelled pairing, and unknown never counted as zero.
