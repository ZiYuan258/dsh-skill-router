# v1.6.2 — 补上真正的注册：客户端半必须自己调用 `__ModuleLoader__.load`

[English](#english) | 中文

v1.6.1 修掉了语法错误，但**没有修好加载**。这一版才是能用的那个，并且把两次都漏掉的那条约定写进了测试。

## 真实加载机制

浏览器把所有客户端半取成**一个拼接的经典脚本**：

```html
<script src="/plugins/??a/client.js,dsh-skill-router/client.js,…">
```

打包器**把每个文件的内容原样插入**——没有 per-file 包装。所以注册必须由文件自己完成：

| 约定 | 作用 |
|---|---|
| 顶层调用 `window.__ModuleLoader__.load({ id, factory })` | **注册**。`load()` 只是入队，factory 稍后在 `create()` 里执行——`require` 就是那时提供的 |
| 在 factory 内部 `require('react')` | 这里**没有** `React` 全局 |

## 两次失败，各错一半

| 版本 | 写法 | 结果 |
|---|---|---|
| v1.6.0 | 顶层 `return` | 经典脚本里是 **SyntaxError** → **整个 bundle** 崩 → 所有客户端半都不注册（包括报告失败的 HMR）→ 启动失败 |
| v1.6.1 | 裸顶层 `module.exports` | 语法错误没了，但**仍然从不注册**：它只给一个没人读的局部 `module` 赋值 → 启动干净，**标签页静默不存在** |
| **v1.6.2** | `__ModuleLoader__.load({ id, factory })`，factory 内 `require('react')`，并导出 `inject: ['slots']` | 与 `dsh-context`、cost-meter、skill-center **三者的既有写法一致** |

## 还有一条漏掉的：`inject: ['slots']`

客户端 runner 是**按每个插件自己声明的 `inject`** 激活服务的，不是全局可用。缺了这行，`ctx.get('slots')` 返回 undefined，`apply` 提前返回，**什么都不注册，且没有任何报错**。

对照 `dsh-context` 的导出：

```js
module.exports = { name: "dsh-context", inject: ["slots", "locale"], apply }
```

本插件只需要 `slots`——中文名是静态术语表，不走 locale 词典。

## 测试这次才对准真实接缝

`test/client-half.mjs` 现在**插桩 `window.__ModuleLoader__`**，像 `create()` 那样把 factory 物化出来，并断言：

- 作为经典脚本可编译、且**确实调用了一次 `load()`**（这条能抓住 v1.6.1 那个"能跑但不注册"的形态）；
- 注册的 `id` 正确；
- factory 能物化、`require('react')` 被调用、返回带 `apply` 的对象；
- **导出了 `inject: ["slots"]`**——这条是这次故障的正因，而此前的测试在 `apply` 时无条件把 `slots` 塞进 ctx，所以**即使插件忘了声明也照样通过**；
- 标签页真的渲染出中文名与英文原名。

反向验证过：移除 `inject: ['slots']` → 测试立刻失败并指名这一条；恢复 → 通过。

## 三次返工的共同点

| 版本 | 我假定的加载方式 | 真实方式 |
|---|---|---|
| v1.6.0 | 函数体（`return` 合法） | 经典脚本拼接 |
| v1.6.1 | 赋值 `module.exports` 即完成注册 | 必须调用 `load()` 入队 |
| v1.6.2 | — | **插桩真实 `__ModuleLoader__` 并物化 factory** |

三次都是**测试用了自己假想的接缝**。这次的检查之所以有效，是因为它不再模拟加载器，而是**把加载器的行为搬进测试**：插桩 `load`、按 `create()` 的方式跑 factory。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`
- 客户端半需要 Web 界面（`dsh.client.platform: web`）

## 测试

十八个，CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

v1.6.1 removed the syntax error but **did not fix loading**. This is the version that works, and it puts the convention both earlier attempts missed into the test.

### The real loading mechanism

The browser fetches every Client half as **one concatenated classic script**:

```html
<script src="/plugins/??a/client.js,dsh-skill-router/client.js,…">
```

The bundler **inserts each file's content verbatim** — there is no per-file wrapper. So registering is the file's own job:

| Convention | What it does |
|---|---|
| a top-level `window.__ModuleLoader__.load({ id, factory })` | **registration**. `load()` only queues; the factory runs later inside `create()`, which is when `require` is supplied |
| `require('react')` inside the factory | there is **no** `React` global here |

### Two failures, each half right

| Version | What it did | Result |
|---|---|---|
| v1.6.0 | top-level `return` | a **SyntaxError** in a classic script → the **whole bundle** fails → no Client half registers (the reporting HMR client included) → startup failure |
| v1.6.1 | bare top-level `module.exports` | syntax error gone, but it **still never registers**: the assignment populates a local `module` nothing reads → clean startup, and **the tab silently does not exist** |
| **v1.6.2** | `__ModuleLoader__.load({ id, factory })`, `require('react')` inside the factory, and an exported `inject: ['slots']` | matches what **all three** of `dsh-context`, cost meter and skill center already do |

### One more thing that was missing: `inject: ['slots']`

The Client runner activates services **per plugin**, from that plugin's own `inject` list — they are not globally available. Without this line `ctx.get('slots')` returns undefined, `apply` returns early, and **nothing is registered, with no error anywhere**.

For comparison, `dsh-context` exports:

```js
module.exports = { name: "dsh-context", inject: ["slots", "locale"], apply }
```

This plugin needs only `slots` — its Chinese names are a static glossary, not a locale dictionary.

### Only now does the test match the real seam

`test/client-half.mjs` now **instruments `window.__ModuleLoader__`**, materializes the factory the way `create()` does, and asserts:

- it compiles as a classic script and **calls `load()` exactly once** (this is the assertion that catches the v1.6.1 shape — runs fine, registers nothing);
- the registered `id` is right;
- the factory materializes, `require('react')` is called, and the result carries `apply`;
- it **exports `inject: ["slots"]`** — the actual cause of this failure, which the previous test could not see because it handed `slots` to `ctx` unconditionally before calling `apply`;
- the tab really renders the Chinese name and the English original.

Verified the other way: removing `inject: ['slots']` fails the test on exactly that line, and restoring it passes.

### What the three attempts had in common

| Version | The loading model I assumed | The real one |
|---|---|---|
| v1.6.0 | a function body (where `return` is legal) | concatenated classic script |
| v1.6.1 | assigning `module.exports` completes registration | the file must call `load()` to enqueue |
| v1.6.2 | — | **instrument the real `__ModuleLoader__` and materialize the factory** |

All three were **tests written against a seam I had imagined**. This check works because it no longer simulates the loader — it moves the loader's behaviour into the test: stub `load`, then run the factory the way `create()` runs it.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
- The Client half needs the web UI (`dsh.client.platform: web`)

### Tests

Eighteen, green on Linux and Windows × Node 20 / 22 / 24.
