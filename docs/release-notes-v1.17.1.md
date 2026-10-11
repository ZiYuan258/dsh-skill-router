# v1.17.1 — 技能看板显示搜索结果：让"库是活的"看得见

[English](#english) | 中文

**一个改动，纯客户端半。** 技能看板（「技能」标签页）以前只追踪加载类工具
（`skill` / `skill_load` / `skill_ref`），一次成功的 `skill_search` 完全不可见——
搜索是"找"不是"用"，不计入加载计数。但搜索成功恰恰是"库是活的"的唯一证据，
这个事件在标签页里缺席，等于库的存在感为零。

## 改了什么

`client.js` 的 `buildLedger` 增加第二轮遍历，处理 `tool/result` 事件：

1. **第一轮**（已有）：遍历 `tool/call` 事件，索引 `skill_search` 的 `callId → {seq, eventKey, turn, step}`，
   同时照旧处理加载类工具的调用参数。
2. **第二轮**（新增）：遍历 `tool/result` 事件，用 `callId` 配对到第一轮索引的搜索调用，
   从结果文本解析技能名，每个命中技能加一行，`tool` 字段标 `'skill_search'`。

结果文本是 `skill_search` 的 `render()` 输出（`host.js`），每条命中是一行 `- skillName  [repo]`。
解析只取 `- ` 后的第一个空白分隔 token（技能名是 kebab-case，不含空格）。描述行缩进 4 空格不匹配。

**不动 `host.js`。** 搜索行为、渲染格式、返回 JSON 全部不变——只改了客户端半怎么读结果。

## 为什么搜索不算加载，但结果应该入列

搜索本身不是加载（`skill_search` 不读技能正文），所以它不计入"加载调用"计数——
这个契约不变。但搜索*找到*的技能名是真实信息：它告诉用户"agent 搜了什么、库里有什
么匹配"。以前这个信息只在对话流里一闪而过，标签页里看不到。现在标签页把它留下来，
标 `skill_search` 以区别于 `skill_load`，让用户一眼看到"搜过、找到了这些"。

## 边界

- 搜索无结果 → 不产生行（`0 match(es)` 没有 `- ` 行）。
- 搜索有 `tool/call` 但 `tool/result` 已被窗口挤出 → 不产生行（无法配对）。
- `tool/result` 在数组中排在 `tool/call` 前面（newest-first）→ 仍能配对（第一轮先建索引）。
- 跨页重复投递 → 不产生重复行（`take()` 按 `eventKey::skill` 去重）。
- `MAX_NAMES = 8` 同样限制搜索结果（与加载类工具一致）。
- 0.1.6 和 0.1.7 两种 `tool/result` 事件 shape 都支持。

## 测试与版本

- `test/usage-ledger.mjs` 新增第 11、12 节（25 条断言）：搜索+结果配对、0.1.6/0.1.7 shape、
  无结果、无 result、newest-first 顺序、混合、跨页去重、MAX_NAMES 截断、`parseSearchHits` /
  `resultTextOf` / `resultCallIdOf` 单元。
- 版本 1.17.0 → 1.17.1（`package.json` + `client.js`）；README 版本示例与标签页说明同步。

---

## English

**One change, Client half only.** The skill usage tab (the 技能 tab) used to track only load tools
(`skill` / `skill_load` / `skill_ref`); a successful `skill_search` was completely invisible —
searching is "finding" not "using", so it was not counted as a load. But a successful search is the
one piece of evidence that "the library is alive", and its absence from the tab meant the library had
zero presence there.

## What changed

`buildLedger` in `client.js` gains a second pass over `tool/result` events:

1. **Pass 1** (existing): iterate `tool/call` events, index `skill_search` calls by
   `callId → {seq, eventKey, turn, step}`, and process load-tool calls as before.
2. **Pass 2** (new): iterate `tool/result` events, pair by `callId` to the indexed search call,
   parse skill names from the result text, and add a row per hit with `tool: 'skill_search'`.

The result text is `skill_search`'s `render()` output (`host.js`); each hit is a line
`- skillName  [repo]`. Parsing takes the first whitespace-delimited token after `- `
(skill names are kebab-case, no spaces). Description lines are indented 4 spaces and do not match.

**`host.js` is untouched.** Search behaviour, render format, and return JSON are all unchanged —
only the Client half's reading of results changed.

## Why a search is not a load, but its results belong in the tab

A search is not a load (`skill_search` never reads a skill body), so it does not count as a "load
call" — that contract is unchanged. But the skills a search *found* are real information: they tell
the user "the agent searched, and here is what the library matched". That used to flash by in the
conversation stream and never appear in the tab. Now the tab retains it, labelled `skill_search` to
distinguish from `skill_load`, so "searched and found these" is visible at a glance.

## Edge cases

- Search with no results → no rows (`0 match(es)` has no `- ` lines).
- Search with `tool/call` but `tool/result` evicted from the window → no rows (cannot pair).
- `tool/result` preceding `tool/call` in the array (newest-first) → still pairs (pass 1 indexes first).
- Cross-page re-delivery → no duplicate rows (`take()` deduplicates by `eventKey::skill`).
- `MAX_NAMES = 8` caps search results too (consistent with load tools).
- Both 0.1.6 and 0.1.7 `tool/result` event shapes are supported.

## Tests and version

- `test/usage-ledger.mjs` gains sections 11–12 (25 assertions): search+result pairing, 0.1.6/0.1.7
  shapes, no-result, no-result-event, newest-first ordering, mixed, cross-page dedup, MAX_NAMES cap,
  and unit tests for `parseSearchHits` / `resultTextOf` / `resultCallIdOf`.
- Version 1.17.0 → 1.17.1 (`package.json` + `client.js`); README version examples and tab description
  updated in lockstep.