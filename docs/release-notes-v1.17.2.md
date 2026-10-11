# v1.17.2 — 搜索查询兜底：eventSource 没有 tool/result 时的可见性

[English](#english) | 中文

**一个改动，纯客户端半。** v1.17.1 让技能看板显示 `skill_search` 找到的技能，但实
际在生产里看不到——因为 `eventSource` 窗口只含 `tool/call` 事件，不含 `tool/result`
（dsh-better-sidebar 的 `changes.ops` 路由正是为此而建）。v1.17.1 的第二轮遍历找不
到任何 `tool/result` 事件，所以搜索仍然不可见。v1.17.2 加了第三轮：对结果不在窗口
里的搜索，显示查询本身（前缀 🔍），让"搜过"这件事至少看得见。

## 改了什么

`client.js` 的 `buildLedger` 从两遍变三遍：

1. **第一轮**（已有）：遍历 `tool/call` 事件，索引 `skill_search` 的
   `callId → {seq, eventKey, turn, step, query}`——现在多存了 `query`。
2. **第二轮**（v1.17.1）：遍历 `tool/result` 事件，配对、解析命中、加行；配对成功
   时标记 `meta.resolved = true`。
3. **第三轮**（新增）：遍历 `searchCalls`，对 `resolved !== true` 且 `query` 非空
   的搜索，加一行 `skill: '🔍 ' + query`、`tool: 'skill_search'`。

**不动 `host.js`。** 搜索行为、渲染格式、返回 JSON 全部不变。

## 为什么需要第三轮

`eventSource`（`sessions.binding(key).eventSource`）是客户端侧的
`ObservableSnapshot<SessionEventWindow>`，它的快照条目只含 `tool/call` 事件。
`tool/result` 事件在会话日志里存在（实测 49950 事件中 `tool/result` = 9156），
但不通过 `eventSource` 暴露——dsh-better-sidebar 插件为此单独建了 `changes.ops`
API 路由（`src/index.ts:924`），用 `ctx.sessions.get(id)?.snapshotEvents()` 在
host 侧取全量事件再过滤。

本插件的技能看板走的是 `eventSource`（客户端侧），所以第二轮在生产里永远找不到
`tool/result`。第三轮是兜底：没有结果时，查询本身就是"搜过"的证据。

## 边界

- 搜索有 `tool/result` → 第二轮加命中行，标记 `resolved`，第三轮跳过（不重复）。
- 搜索无 `tool/result`（生产常态）→ 第三轮加查询行 `🔍 query`。
- 搜索有 `tool/result` 但 0 命中 → 第二轮标记 `resolved`，第三轮跳过（不显示查询）。
- 跨页重复投递 → 不产生重复行（`take()` 按 `eventKey::search:query` 去重）。
- 查询为空或非字符串 → 不产生行。

## 测试与版本

- `test/usage-ledger.mjs` 更新：第 1 节"skill_search 不算加载"改为"无 result 时显示
  查询行"；第 11 节"无 result 时不产生行"改为"无 result 时显示查询行"；新增查询行
  跨页去重 + 有 result 时不显示查询行两条断言。
- 版本 1.17.1 → 1.17.2（`package.json` + `client.js`）；README 版本示例与标签页
  说明同步。

---

## English

**One change, Client half only.** v1.17.1 made the skill usage tab show which skills a
`skill_search` found, but it was invisible in production — because the `eventSource`
window carries only `tool/call` events, not `tool/result` (dsh-better-sidebar's
`changes.ops` route exists precisely because of this). v1.17.1's second pass found no
`tool/result` events, so searches remained invisible. v1.17.2 adds a third pass: for
searches whose result is not in the window, the query itself is shown (prefixed 🔍), so
"a search happened" is at least visible.

## What changed

`buildLedger` in `client.js` goes from two passes to three:

1. **Pass 1** (existing): iterate `tool/call` events, index `skill_search` calls by
   `callId → {seq, eventKey, turn, step, query}` — now also stores `query`.
2. **Pass 2** (v1.17.1): iterate `tool/result` events, pair, parse hits, add rows;
   mark `meta.resolved = true` when a result is found.
3. **Pass 3** (new): iterate `searchCalls`; for any with `resolved !== true` and a
   non-empty `query`, add a row `skill: '🔍 ' + query`, `tool: 'skill_search'`.

**`host.js` is untouched.** Search behaviour, render format, and return JSON are all unchanged.

## Why a third pass is needed

`eventSource` (`sessions.binding(key).eventSource`) is the client-side
`ObservableSnapshot<SessionEventWindow>`; its snapshot entries carry only `tool/call`
events. `tool/result` events exist in the session log (verified: 9156 of 49950 events)
but are not exposed through `eventSource` — dsh-better-sidebar built a separate
`changes.ops` API route (`src/index.ts:924`) that calls
`ctx.sessions.get(id)?.snapshotEvents()` host-side to get all events and filter.

This plugin's skill tab reads from `eventSource` (client-side), so pass 2 never finds
`tool/result` in production. Pass 3 is the fallback: without a result, the query itself
is the evidence that a search happened.

## Edge cases

- Search with `tool/result` → pass 2 adds hit rows, marks `resolved`, pass 3 skips (no duplicate).
- Search without `tool/result` (production default) → pass 3 adds the query row `🔍 query`.
- Search with `tool/result` but 0 hits → pass 2 marks `resolved`, pass 3 skips (no query row).
- Cross-page re-delivery → no duplicate rows (`take()` deduplicates by `eventKey::search:query`).
- Empty or non-string query → no row.

## Tests and version

- `test/usage-ledger.mjs` updated: section 1 "skill_search is not a load" → "shows query row
  when no result"; section 11 "no result event → no rows" → "no result event → shows query row";
  added cross-page dedup for query rows + "result present → no query row" assertions.
- Version 1.17.1 → 1.17.2 (`package.json` + `client.js`); README version examples and tab
  description updated in lockstep.
