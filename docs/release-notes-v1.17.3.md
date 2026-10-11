# v1.17.3 — run_code 内嵌调用解析

[English](#english) | 中文

**根因修复。** v1.17.1 和 v1.17.2 让技能看板显示 `skill_search` 找到的技能，但在生产里
始终看不到。诊断发现：agent 用 `run_code` 作唯一工具接口——它写 TypeScript 代码包含
`await tools.skill_search(...)`，由 `run_code` 执行。`eventSource` 只记录 `run_code` 的
`tool/call` 事件，内嵌的 `skill_search`/`skill_load` 不是独立事件。前三遍全部找不到。

v1.17.3 在第一遍里增加 `run_code` 分支：解析 `arguments.code` 字段，用正则提取内嵌的
`tools.skill_search({query:…})` 和 `tools.skill_load({name:…})` 调用。搜索加入
`searchCalls`（第三遍显示查询行），加载直接入列（标 `skill_load`）。

## 改了什么

- **`parseRunCodeCalls(code)`**（新 helper）：用两个正则从代码字符串提取内嵌调用。
  支持 `tools.skill_search` 和 `tools["skill_search"]` 两种访问形式，单引号/双引号/
  反引号三种字符串字面量。变量引用（非字面量）不可见——这是可接受的假阴性，不是假阳性。
- **`buildLedger` pass 1**（`client.js`）：`tool === 'run_code'` 分支解析 `args.code`，
  搜索加入 `searchCalls`（合成 callId `runcode:<原callId>:<索引>`），加载直接 `take()` 入列。
- **不动 `host.js`。** 搜索行为、渲染格式、返回 JSON 全部不变。

## 为什么需要

agent 的工具调用模式是写 TypeScript 代码传给 `run_code` 执行，而不是直接调用工具。
实测一个会话 791 条事件、77 个 `tool/call`，全部是 `run_code`，0 个 `skill_search`。
但代码体里有 `tools.skill_search({ query: "plugin security review" })` 等调用。这些调用
在会话日志里存在（另一个会话 6565 个 `run_code` 调用中有 8 个含 `skill_search`），但
不作为独立 `tool/call` 事件出现——它们是 `run_code` 的参数，不是事件。

## 边界

- 代码体含 `tools.skill_search({query: "..."})` → 提取查询，第三遍显示 `🔍 query`。
- 代码体含 `tools.skill_load({name: "..."})` → 提取技能名，直接入列标 `skill_load`。
- 代码体含 `tools.skill_load({names: "a,b,c"})` → 拆分逗号，每个入列。
- 查询/名称是变量（非字面量）→ 不可见（假阴性，可接受）。
- 正则匹配代码字符串里的 `tools.skill_search` 文本 → 可能假阳性（如注释/日志里提到），
  但实践中代码体是要执行的 TypeScript，这类匹配是真实调用。

## 测试与版本

- `test/usage-ledger.mjs` 新增 §13 run_code 解析断言：含 skill_search 的 run_code 事件
  产生查询行；含 skill_load 的 run_code 事件产生加载行；变量引用不产生行。
- 版本 1.17.2 → 1.17.3（`package.json` + `client.js`）；README 版本示例与描述同步。

---

## English

**Root cause fix.** v1.17.1 and v1.17.2 made the skill tab show `skill_search` hits, but it
was always invisible in production. Diagnosis revealed: the agent uses `run_code` as its sole
tool interface — it writes TypeScript containing `await tools.skill_search(...)`, which
`run_code` executes. `eventSource` records only the `run_code` `tool/call` event; the embedded
`skill_search`/`skill_load` calls are NOT separate events. The first three passes all missed them.

v1.17.3 adds a `run_code` branch in pass 1: parse `arguments.code`, use a regex to extract
embedded `tools.skill_search({query:…})` and `tools.skill_load({name:…})` calls.
Searches go into `searchCalls` (pass 3 shows the query row); loads are added directly as rows
(labelled `skill_load`).

## What changed

- **`parseRunCodeCalls(code)`** (new helper): two regexes extract embedded calls from the code
  string. Supports `tools.skill_search` and `tools["skill_search"]` access forms, and single/
  double/backtick string literals. Variable references (non-literals) are invisible — an
  acceptable false negative, not a false positive.
- **`buildLedger` pass 1** (`client.js`): `tool === 'run_code'` branch parses `args.code`,
  searches go into `searchCalls` (synthetic callId `runcode:<origCallId>:<index>`), loads are
  added directly via `take()`.
- **`host.js` is untouched.** Search behaviour, render format, and return JSON are all unchanged.

## Why it's needed

The agent's tool-calling pattern is to write TypeScript code passed to `run_code`, not to call
tools directly. Verified: one session had 791 entries, 77 `tool/call` events, all `run_code`,
0 `skill_search`. But the code bodies contain `tools.skill_search({ query: "plugin security
review" })` etc. These calls exist in the session log (another session: 6565 `run_code` calls,
8 containing `skill_search`), but they appear as `run_code` arguments, not as independent
`tool/call` events.

## Edge cases

- Code body with `tools.skill_search({query: "..."})` → query extracted, pass 3 shows `🔍 query`.
- Code body with `tools.skill_load({name: "..."})` → name extracted, row added as `skill_load`.
- Code body with `tools.skill_load({names: "a,b,c"})` → comma-split, each added as a row.
- Query/name is a variable (non-literal) → invisible (false negative, acceptable).
- Regex matches `tools.skill_search` text in code → possible false positive (e.g. in comments),
  but in practice the code body is TypeScript meant to be executed, so such matches are real calls.

## Tests and version

- `test/usage-ledger.mjs` adds §13 run_code parsing assertions: run_code with skill_search
  produces query rows; run_code with skill_load produces load rows; variable references produce
  no rows.
- Version 1.17.2 → 1.17.3 (`package.json` + `client.js`); README version examples and
  descriptions updated in lockstep.
