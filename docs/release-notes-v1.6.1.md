# v1.6.1 — 修复我造成的启动失败：客户端半必须是经典脚本

[English](#english) | 中文

**v1.6.0 会让 DSH 启动失败。** 这一版修它，并且补上那个本该拦住它的检查。

## 症状

```
Failed to load plugins
failed to import loader entry 068d52b0 (@deepseek-ai/dsh-client-hmr):
  client-modules: bundle /plugins/??…,dsh-skill-router/client.js,… 
  loaded without registering "@deepseek-ai/dsh-client-hmr" via __ModuleLoader__.load
```

报错指向 HMR 客户端，但 **HMR 是无辜的**——它在加载列表最前面，只是第一个撞上错误的人。

## 根因

我给客户端半写了**顶层 `return`**。浏览器把**所有**客户端半拼成**一个经典脚本**加载：

```html
<script src="/plugins/??a/client.js,dsh-skill-router/client.js,…">
```

在经典脚本里，顶层 `return` 是**语法错误**（只有函数体里才合法）。**一条这样的语句让整个 bundle 解析失败**，于是**所有**客户端半都注册不上——包括负责报告失败的那个。

修复就是那一行：改成顶层 `module.exports` 赋值。这是本环境里三个已发布客户端半（`dsh-context`、cost-meter、skill-center）**全部**采用的写法，也是拼接脚本模型要求的写法。

## 真正的问题在测试，不在代码

我写了一个测试，用 `(function () { … })()` 包住源码再求值——**在函数体里，顶层 `return` 完全合法**。所以测试验证的是**一个不存在的接缝**，于是它对一个根本无法加载的文件亮了绿灯。

现在它用 `new Script(source)` 按经典脚本编译，这正是会对这个错误报错的检查；另外扫一遍未缩进的顶层 `return`，让失败**指名行号**而不是只说 "SyntaxError"。

反向验证过：把 `return` 塞回去，测试立刻失败，并报出正确的行：

```
FAIL compiles as a classic script — SyntaxError: Illegal return statement
FAIL no unindented top-level return statement — line 42
```

## 顺带修掉检查器自身的误报

那个"代码里不得出现 `@deepseek-ai/*`"的检查，把**我记录这条故障的注释**也当成了违规——因为注释里引用了报错原文。**会报告文档的检查器，人们会靠删文档来满足它**，而那段注释是这条症状唯一的记录处。现在检查器先剥掉注释再扫代码。

## 同类交叉验证

顺手确认了本机四个客户端半（`dsh-context`、cost-meter、skill-center、本插件）**都**是合法经典脚本。所以这个检查对标的是加载器，而不是某一个文件。

## 恢复被临时关掉的功能

启动恢复后，`package.json` 里的 `exports["./client"]` 与 `dsh.client` 被移除了——那让 **启动正常，但技能标签页其实没装**（功能被静默关掉）。这一版把它们恢复。

## 启动失败这件事，这是第二次

第一次是 2026-09-23 的开发用 `node_modules` 替身遮蔽真包；这次是客户端半的接缝搞错。**共同点是我在没有验证真实接缝的情况下就发布了。** 第一次之后加的 `test/boot-safety.mjs` 守住了服务端那一侧；这次的教训是同一个，只是换到了浏览器那一侧：**测试必须用加载器真实使用的方式去加载被测对象**，否则它只是我假想的那个世界里的证据。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`
- 客户端半需要 Web 界面（`dsh.client.platform: web`）

## 测试

十八个，CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

**v1.6.0 broke DSH startup.** This release fixes it, and adds the check that should have caught it.

### Symptom

```
Failed to load plugins
failed to import loader entry 068d52b0 (@deepseek-ai/dsh-client-hmr):
  client-modules: bundle /plugins/??…,dsh-skill-router/client.js,… 
  loaded without registering "@deepseek-ai/dsh-client-hmr" via __ModuleLoader__.load
```

The error names the HMR client, but **HMR is innocent** — it sits first in the load list and was simply the first to hit the failure.

### Cause

I wrote a **top-level `return`** in the Client half. The browser loads **every** Client half as **one concatenated classic script**:

```html
<script src="/plugins/??a/client.js,dsh-skill-router/client.js,…">
```

In a classic script a top-level `return` is a **SyntaxError** — it is legal only inside a function body. **One such statement fails the whole bundle**, so **no** Client half registers, the one that reports the failure included.

The fix is that one line: a top-level `module.exports` assignment, which is what all three shipped Client halves in this harness (`dsh-context`, cost meter, skill center) do, and what the concatenated-script model requires.

### The real defect was in the test, not the code

I wrote a test that wrapped the source in `(function () { … })()` before evaluating it — **and inside a function body a top-level `return` is perfectly legal**. So the test validated **a seam that does not exist**, and gave a green light to a file that could not load.

It now compiles the source with `new Script(source)` as a classic script — the check that fails on exactly this mistake — and additionally scans for unindented top-level returns so a failure **names the line** instead of only "SyntaxError".

Verified the other way: putting the `return` back fails the test at the right line:

```
FAIL compiles as a classic script — SyntaxError: Illegal return statement
FAIL no unindented top-level return statement — line 42
```

### A false positive in the checker, fixed too

The "no `@deepseek-ai/*` in code" check flagged **the comment in which I recorded this very failure**, because the comment quotes the error text. **A checker that reports documentation is a checker people satisfy by deleting the documentation**, and that comment is the only place this symptom is written down. The check now strips comments before scanning code.

### Cross-checked against the same class

All four Client halves on this machine (`dsh-context`, cost meter, skill center, this one) are confirmed to compile as classic scripts. The check now matches the loader rather than one file.

### The temporarily disabled feature is restored

Once startup was working again, `exports["./client"]` and `dsh.client` had been removed from `package.json` — which made **startup work while the skills tab was silently not installed**. This release restores them.

### This is the second startup failure

The first (2026-09-23) was a dev `node_modules` shim shadowing the real package; this one was getting the Client seam wrong. **Both shipped without verifying the real seam.** The first produced `test/boot-safety.mjs`, which guards the Host side; the lesson here is the same one moved to the browser: **a test must load the artifact the way the loader actually loads it**, or it is only evidence about a world I imagined.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
- The Client half needs the web UI (`dsh.client.platform: web`)

### Tests

Eighteen, green on Linux and Windows × Node 20 / 22 / 24.
