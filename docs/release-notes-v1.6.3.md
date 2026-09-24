# v1.6.3 — 第三次隐患：样式注入能在四种 document 时序下打死整个标签页

[English](#english) | 中文

这一版是"再检查一遍"的产物，而且**确实又查出一个**——和前两次同类：都不报错、只是功能不出现。

## 查出的隐患：未加防护的 `document.head.appendChild`

`apply()` 在 bundle 被求值时**立刻**执行，而那时 `document` 未必就绪。我按三种时序各跑一遍：

| 时序 | 修复前 | 修复后 |
|---|---|---|
| `head` 已存在 | ok | ok |
| **`head` 为 null** | **apply() 抛 `TypeError: Cannot read properties of null (reading 'appendChild')`** | ok |
| **`document` 不可用** | **apply() 抛错** | ok |

关键在于后果：`apply()` 里抛异常 → **下面的槽位注册根本不会执行** → 标签页不存在，而且**用户看不到任何可操作的错误**。为了一张样式表丢掉整个标签页，这个交换不值得。

现在按 `head` → `documentElement` → `body` 依次回退，并对 `document` 做 `typeof` 判断；都拿不到就跳过样式，**不影响标签页**。

`head` 为 null 是真实场景：脚本标签就在 `<head>` 内执行、iframe、shadow root，或任何不带 document 求值客户端半的 harness。

## 顺带修掉两处"检查器报文档"的误报

1. **全量普查漏掉了它要查的目标。** 我写的普查脚本用 `entry.isDirectory()` 过滤，而 Windows 上 **junction 的 `isDirectory()` 为 false**（它是 reparse point）——于是 `dsh-skill-router` 和 `hono` 这两个**链接包**被静默跳过。**一个静默跳过自己目标的检查，比没有检查更糟，因为它会报告"全部通过"。** 改成只问"这里有没有可读的 package.json"。
2. **契约核对把注释算成了代码。** 它数 `__ModuleLoader__.load(` 的出现次数，而本文件顶部注释里引用了两次（在解释两次失败）。现在计数在**剥掉注释的代码**上做——会报告文档的检查器，人们会靠删文档来满足它。

## 新增两个检查（这是重点）

前两次启动失败**十八项测试一个都没抓到**，因为它们测的是 `host.js` 的行为，而失败发生在加载器读 `package.json`、拼接客户端半的时候。所以补上：

**`test/package-contract.mjs`**（进 `npm test`）——核对**加载器会读的每一样东西**：

- `exports` / `main` / `dsh.client.platform` / `dsh.bundle.patch` / `files` 是否齐全且指向真实文件
- 客户端半是否作为**经典脚本**可编译（顶层 `return` 会让整个 bundle 崩）
- 代码里是否**恰有一次** `window.__ModuleLoader__.load(`（缺失 = "能跑但不注册"）
- 注册 id 是否与包名一致、factory 是否 `require('react')`、是否导出 `inject`
- `host.js` 的导出形状与组合行

**`tools/audit-client-halves.mjs`**（**不进** `npm test`）——扫本机 profile 里**所有**插件的客户端半，并排列出，让差异一眼可见：

```
包                           经典脚本       load()  inject              require
dsh-context                 ok         1       "slots", "locale"   react
dsh-skill-router            ok         1       'slots'             react
…
```

**为什么它不进 CI**：它扫的是**你本机**的 profile，不具备自包含性。装了别人的坏插件时它**应该**报出来（那是诊断价值），但不该让本仓库的测试无故变红。这个判断写进了 README。

## 客户端半测试现在按真实机制验证

`test/client-half.mjs` 不再模拟加载器，而是**把加载器的行为搬进测试**：插桩 `window.__ModuleLoader__`、像 `create()` 那样物化 factory、断言 `inject` 声明、并在**四种 document 时序**下确认 `apply()` 不抛错且槽位仍然注册。

34 项断言（原 27 项 + 时序 8 项）。

## 三次返工的同一个病根

| 版本 | 我假定的加载方式 | 真实方式 |
|---|---|---|
| v1.6.0 | 函数体（顶层 `return` 合法） | 拼接经典脚本 → SyntaxError 崩整包 |
| v1.6.1 | 赋值 `module.exports` 即注册 | 必须自己调 `load()` 入队；且服务要声明 |
| v1.6.3 | `apply()` 时 document 必然就绪 | 未必；未加防护就打死标签页 |

**三次都是"我验证了自己想象的那个世界"。** 现在留下的三件工具（`package-contract.mjs`、`client-half.mjs` 的真实接缝、`audit-client-halves.mjs`）针对的正是这一类。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`
- 客户端半需要 Web 界面（`dsh.client.platform: web`）

## 测试

十九个（原十八个 + `package-contract.mjs`），CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

This release is the product of "check it again", and it **did find a third one** — the same class as the previous two: no error, the feature merely does not appear.

### What it found: an unguarded `document.head.appendChild`

`apply()` runs the moment the bundle is evaluated, which is not necessarily when a document is ready. Running it under three timings:

| Timing | Before | After |
|---|---|---|
| `head` present | ok | ok |
| **`head` is null** | **apply() threw `TypeError: Cannot read properties of null (reading 'appendChild')`** | ok |
| **no `document` at all** | **apply() threw** | ok |

The consequence is what matters: an exception inside `apply()` means the **slot registration below it never runs**, so the tab does not exist — and there is no actionable error for the user to report. Losing an entire tab to a stylesheet is not a trade worth making.

It now falls back through `head` → `documentElement` → `body`, guards `document` with a `typeof` check, and simply skips the stylesheet when none is reachable — **the tab is unaffected**.

A null `head` is a real case: a script tag evaluating inside `<head>` itself, an iframe, a shadow root, or any harness that evaluates Client halves without a document.

### Two false positives in the checkers, fixed too

1. **The audit dropped the target it existed to check.** It filtered with `entry.isDirectory()`, and on Windows a **junction reports `isDirectory()` as false** (it is a reparse point) — so the two *linked* packages, `dsh-skill-router` and `hono`, were silently skipped. **A check that quietly drops its own target is worse than no check, because it reports "all clear."** It now asks only whether a readable `package.json` is there.
2. **The contract check counted documentation as code.** It counted occurrences of `__ModuleLoader__.load(`, and this file's own header comment quotes that sequence twice while explaining the two failures. Counting now happens on comment-stripped code — a checker that reports documentation is a checker people satisfy by deleting the documentation.

### Two new checks (the point of this release)

The first two startup failures were caught by **none** of the eighteen tests, because those test `host.js` behaviour while the failures happened in the loader reading `package.json` and concatenating Client halves. So:

**`test/package-contract.mjs`** (in `npm test`) verifies **everything the loader reads**:

- `exports` / `main` / `dsh.client.platform` / `dsh.bundle.patch` / `files` present and pointing at real files
- the Client half compiling as a **classic script** (a top-level `return` takes the whole bundle down)
- exactly one `window.__ModuleLoader__.load(` in code (its absence means "runs but never registers")
- the registered id matching the package name, `require('react')` inside the factory, `inject` exported
- the Host exports and the composed row

**`tools/audit-client-halves.mjs`** (**not** in `npm test`) scans the Client halves of **every** plugin installed in this machine's profile and lays them side by side so a difference is obvious:

```
package                     classic     load()  inject              require
dsh-context                 ok         1       "slots", "locale"   react
dsh-skill-router            ok         1       'slots'             react
…
```

**Why it is not in CI**: it scans **your** profile, so it is not self-contained. A broken third-party plugin *should* be reported (that is the diagnostic), but it must not turn this repository's suite red for someone else's defect. That reasoning is written into the README.

### The Client test now verifies the real mechanism

`test/client-half.mjs` no longer simulates the loader — it **moves the loader's behaviour into the test**: it instruments `window.__ModuleLoader__`, materializes the factory the way `create()` does, asserts the `inject` declaration, and confirms across **four document timings** that `apply()` does not throw and the slot still registers.

Thirty-four assertions (27 before, plus 8 for the timings).

### The same root cause, three times

| Version | The loading model I assumed | The real one |
|---|---|---|
| v1.6.0 | a function body (top-level `return` is legal) | a concatenated classic script → SyntaxError kills the bundle |
| v1.6.1 | assigning `module.exports` registers | the file must call `load()` itself, and declare its services |
| v1.6.3 | a document is ready when `apply()` runs | it need not be; unguarded, it kills the tab |

**All three times I verified a world I had imagined.** The three artefacts left behind — `package-contract.mjs`, the real-seam `client-half.mjs`, and `audit-client-halves.mjs` — exist for exactly this class.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
- The Client half needs the web UI (`dsh.client.platform: web`)

### Tests

Nineteen (eighteen plus `package-contract.mjs`), green on Linux and Windows × Node 20 / 22 / 24.
