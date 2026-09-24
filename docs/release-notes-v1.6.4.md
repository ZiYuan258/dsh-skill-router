# v1.6.4 — CodeQL 报的多项式回溯是真的，而且同一行在客户端半还有一份

[English](#english) | 中文

CodeQL 告警 `js/polynomial-redos`（**high**）指向 `host.js:121`。**这次它是对的**，而且我没有靠"它可能误报"就略过——我把它测了。

## 先说结论：告警成立，且可测量

`normName` 里原本是：

```js
text.replace(/\/+$/, '')
```

锚定在 `$` 上，正则引擎会**从每个起点重试**：吃掉剩余斜杠、再回退去比较锚点。于是"N 个斜杠但结尾不是斜杠"的输入是 **O(N²)**。实测：

| 输入长度 | `replace(/\/+$/)` | 循环实现 | 比值 |
|---|---|---|---|
| 1,000 | 0.52 ms | 0.02 ms | 28× |
| 4,000 | 7.93 ms | ~0 ms | 9,914× |
| 16,000 | 126 ms | ~0 ms | 63,231× |
| 64,000 | **2,015 ms** | ~0 ms | 775,145× |

长度翻 4 倍、耗时翻约 16 倍——教科书式二次增长，而且能到**秒级**。修法是去掉正则，改成一个循环：

```js
function stripTrailingSlashes(text) {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1
  return end === text.length ? text : text.slice(0, end)
}
```

循环不只是更快——它**根本无法回溯**。全部用例上结果与正则一致。

## 同一行在客户端半还有一份，CodeQL 看不到

`client.js` 里的 `normName` 是**重复实现**（客户端半不能 import 宿主半，这是刻意的）。那一份**带着同样的正则**，而 CodeQL 只分析入口文件，**根本看不到它**。

修复后实测：20 万个斜杠的输入渲染耗时 **2.52 ms**。

这是重复代码的代价：一个修复必须落两处，而分析工具只盯其中一处。

## 顺带：另外两处 `+$` 形式经核对是安全的

- `host.js` 的 `/^[a-z0-9][a-z0-9-]*$/` —— 量词在**字符类**上，每个字符只有一种匹配方式，**没有可回退的余地**。
- `test/workflow-config.mjs` 的 `/@v\d+(\.\d+)*$/` —— 只作用于 CI 配置里的固定字符串。

区别在于：`/\/+$/` 的重复可以**在同一段输入上重新划分**，字符类不能。

## 把这类检查固化

CodeQL 这次报了是对的，但**它发现得靠运气**，而且漏掉了客户端半那一份。所以新增两条常驻断言（都在 `test/package-contract.mjs`）：

1. **可回溯的量词紧邻行尾锚**——扫 `host.js` 与 `client.js` 的代码（剥注释），报出 `+$`/`*$` 形式，**放行字符类**（`]*$/`，安全）。已验证：把 `/\/+$/` 放回去 → `FAIL client.js ... line 254 /\/+$/`。
2. **两半的 `normName` 行为一致**——在各自沙箱里**求值后跑 11 个用例比对结果，而不是比对源码文本**。这一点重要：文本比对会因为一半用 `??`、一半用显式 null 判断而误报（我第一版就是这么写的，然后被自己的检查打回）。

## 为什么"实测"而不是"相信工具"或"相信直觉"

我一开始对这条告警是怀疑的：输入来自本机索引文件，没有网络路径，实践暴露很小。**但怀疑不是结论**——我把它计时，量出了 O(N²) 与秒级耗时。告警成立，修它几乎是零成本。

反过来也成立：同一批扫描里另外两处 `+$` 形式我**没有**跟着改，因为核对后确认它们不可回溯。**既不盲从告警，也不凭直觉驳回。**

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`
- 客户端半需要 Web 界面（`dsh.client.platform: web`）

## 测试

十九个，CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

CodeQL reported `js/polynomial-redos` (**high**) at `host.js:121`. **It was right**, and I did not wave it away as a possible false positive — I measured it.

### The finding holds, and it is measurable

`normName` contained:

```js
text.replace(/\/+$/, '')
```

Anchored at `$`, the engine **retries from every start position**: it eats the remaining slashes, then backtracks to compare the anchor. So N slashes that do **not** end in a slash cost **O(N²)**. Measured:

| Input length | `replace(/\/+$/)` | The loop | Ratio |
|---|---|---|---|
| 1,000 | 0.52 ms | 0.02 ms | 28× |
| 4,000 | 7.93 ms | ~0 ms | 9,914× |
| 16,000 | 126 ms | ~0 ms | 63,231× |
| 64,000 | **2,015 ms** | ~0 ms | 775,145× |

Quadrupling the length multiplied the time by about sixteen — textbook quadratic, and it reaches **seconds**. The fix drops the regex for a loop:

```js
function stripTrailingSlashes(text) {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1
  return end === text.length ? text : text.slice(0, end)
}
```

The loop is not merely faster — it **cannot backtrack at all**. It agrees with the regex on every case.

### The same line existed in the Client half, where CodeQL cannot see it

`client.js` carries a **duplicate** `normName` (a Client bundle cannot import from the Host half; the duplication is deliberate). That copy held **the same regular expression**, and CodeQL analyses entry points, so it **never looked at it**.

After the fix, feeding it 200,000 slashes renders in **2.52 ms**.

That is the price of duplicated code: one fix has to land twice, and the analyser watches only one of them.

### Two other `+$` shapes were checked and are safe

- `host.js`'s `/^[a-z0-9][a-z0-9-]*$/` — the quantifier sits on a **character class**, which matches each character one way only, so there is nothing to backtrack into.
- `test/workflow-config.mjs`'s `/@v\d+(\.\d+)*$/` — it only ever sees fixed strings from the CI config.

The difference: `/\/+$/`'s repetition can be **re-divided over the same input**; a character class cannot.

### The check is now permanent

CodeQL being right this time arrived by luck, and it missed the Client copy entirely. So `test/package-contract.mjs` gained two assertions:

1. **A backtrackable quantifier immediately before an end anchor** — scans the code (comments stripped) of both `host.js` and `client.js` for `+$`/`*$`, **exempting character classes** (`]*$/`, safe). Verified: putting `/\/+$/` back fails with `client.js ... line 254 /\/+$/`.
2. **The two `normName` copies behave identically** — by **running both in their own sandbox over eleven cases, not by comparing their source text**. That distinction matters: a text diff trips over one copy using `??` and the other an explicit null check, which is exactly how my first attempt at this check failed, caught by the check itself.

### Why measure rather than trust the tool or my instinct

I was initially sceptical of this alert: the input is a local index file, there is no network path, and the practical exposure is small. **But scepticism is not a conclusion** — I timed it and found quadratic growth and seconds of stall. The alert holds, and fixing it costs almost nothing.

The converse held too: I did **not** change the other two `+$` shapes in the same sweep, because checking them showed they cannot backtrack. **Neither deferring to the scanner nor dismissing it from instinct.**

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
- The Client half needs the web UI (`dsh.client.platform: web`)

### Tests

Nineteen, green on Linux and Windows × Node 20 / 22 / 24.
