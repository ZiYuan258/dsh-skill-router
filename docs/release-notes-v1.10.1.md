# v1.10.1 — `engines.dsh` 的范围静默排除了上游升级后的每一个版本

[English](#english) | 中文

上游（DSH Desktop）从 **2.0.13 升到 2.0.14**，内置 harness 从 `0.1.5-rc.2` 升到 **`0.1.7-rc.1`**。为确认适配性，我把两版的类型声明从 npm 取下来逐项对比——**API 全部没变，但引擎范围出了问题**。

## 结论先说：API 兼容，声明不兼容

| 我依赖的接口 | 0.1.5-rc.2 → 0.1.7-rc.1 |
|---|---|
| `ctx.fs.resolve/stat/readText/listDir` | ✅ 签名逐字未变 |
| `ctx.tools.register` / `ToolDefinition` | ✅ |
| `ctx.skills`（常驻目录）公开面 | ✅ 5 项完全相同 |
| `slots.register` / `slots.inject` / `subscribe` / `entries` | ✅ |
| `conversation.view` 的 `scope: "session"` 与 `sessionId` prop | ✅ |
| 渲染器的 `runInject` / `binding.key` / `SessionEntry` | ✅ |
| `SessionEventWindow` / `SessionBinding` / `ObservableSnapshot` / `loadOlder` | ✅ |
| **`agent/pre-step` 的 payload 与 `enter` 分支** | ✅ **逐字相同**（含 `claim()` 仍早于瀑布派发） |

**但**声明里的范围是 `engines.dsh: ">=0.1.5-rc.1"`。用真实 semver 实测：

```
satisfies('>=0.1.5-rc.1', '0.1.5-rc.2')  = true     ← 你现在跑的
satisfies('>=0.1.5-rc.1', '0.1.7-rc.1')  = false    ← 升级后
```

**它拒绝了 11 个已发布版本中的 7 个**，包括 `0.1.6-*`、`0.1.7-alpha/rc` 全部。名字看起来像"从那以后都支持"，实际是"只支持那一个 tuple"。

## 规则（读 `semver/classes/range.js` 得到，不是猜的）

一个带预发布标签的版本，只有**当范围里某个比较符的 `major.minor.patch` 元组与之完全相同、且该比较符自身也带预发布标签**时才被放行。所以覆盖所有 `0.1.x` 的 rc **没有捷径**，必须为每个 tuple 各写一个带预发布的分支：

```
>=0.1.0-rc.1 <0.1.5-rc.1 || >=0.1.5-rc.1 <0.1.6-rc.1 || >=0.1.6-rc.1 <0.1.7-rc.1 || >=0.1.7-rc.1 <0.2.0-0
```

实测：接纳全部 11 个已发布版本，拒绝 `0.2.0-0`/`0.2.0`/`0.3.0-0`/`0.0.9`。

> 顺带一提：awesome 列表 contributing.md 里给的那个"推荐写法"（`>=0.1.5-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`）**也是错的**——三个测试版本全是 false。我没有照抄它。

## 这个 bug 现在有多严重：是"声明过时"，不是"装不上"

我在本机（2.0.13）查了谁会读 `dsh.engines`：**没有任何东西读它**。启动器只读 `dsh.profile`，客户端加载器只读 `dsh.client`/`dsh.bundle`。所以：

- **升级不会因为这条范围而拒绝加载插件**；
- 但声明已经与实际不符，而且这是写给别人看的契约——一旦上游开始校验（contributing.md 通篇在教怎么写这个字段，说明生态在意它），它会变成真的拦截。

## 新增第 23 个测试：把这条钉死

`test/engine-range.mjs`：

- 每条 OR 分支都必须带预发布标签（**缺了就覆盖不到那个 tuple 的 rc**，正是当初漏掉的点）；
- 覆盖 0.1.5 / 0.1.6 / 0.1.7，排除 0.2；
- 在本机找到真实 semver 时**实测**：接纳 11 个已发布版本、拒绝 4 个不该接纳的、且**已装的 harness 版本落在范围内**。

它自己也不写死本机路径——写死会被 `no-local-paths.mjs` 拦下（第一版就是这么被拦的，改成了从 `DSH_HOME`/主目录推导 + 向上逐级查找）。

## 另一处我**没有**照做上游建议

contributing.md 要求官方 `@deepseek-ai/*` 包用 `peerDependencies` 声明。我加了之后 `test/boot-safety.mjs` 立刻报错：

```
package.json declares DSH host package "@deepseek-ai/dsh-tools" under peerDependencies
  — resolve it from the DSH install instead of pinning a copy
```

**我的检查更对**，而且这条规则的来历正是一次事故：当初一个残留的 dev 替身遮蔽了真包，导致整棵插件树加载失败。本插件**运行时零导入**（工具定义在本地构造成标准 JSON Schema），声明 peer 只会凭空产生一个安装要求（还可能 ERESOLVE），不带来任何东西。所以我撤掉了 peer，保留修正后的 `engines` 范围。

## English

Upstream (DSH Desktop) moved **2.0.13 → 2.0.14**, taking the bundled harness from `0.1.5-rc.2` to **`0.1.7-rc.1`**. To check compatibility I pulled both versions' type declarations from npm and compared them member by member: **no API changed, but the engines declaration did**.

**Verdict:** every interface this plugin touches is byte-identical across the two versions — `ctx.fs.*`, `ctx.tools.register`, the `ctx.skills` surface, `slots.register/inject/subscribe/entries`, the `conversation.view` session scope and `sessionId` prop, the renderer's `runInject`/`binding.key`/`SessionEntry`, `SessionEventWindow`/`SessionBinding`/`ObservableSnapshot`/`loadOlder`, and **the `agent/pre-step` payload and `enter` branch including `claim()` still running before the waterfall**.

**But** the declared range was `>=0.1.5-rc.1`, and measured against a real semver it **rejects 7 of the 11 published versions** — including every `0.1.6-*` and `0.1.7-alpha/rc`. It reads like "0.1.5 and later"; it means "that one tuple".

The rule (read out of `semver/classes/range.js`, not guessed): a prerelease version is only admitted when some comparator in the range shares its exact `major.minor.patch` tuple **and** carries a prerelease tag itself. Covering every `0.1.x` rc therefore has no shortcut — each tuple needs its own branch, which is what the new range does. Verified: it admits all 11 published versions and rejects `0.2.0-0`/`0.2.0`/`0.3.0-0`/`0.0.9`. (The range that the awesome-list contributing guide recommends is itself wrong — all three of its own examples fail. I did not copy it.)

**Severity today:** nothing in the installed build reads `dsh.engines` — the launcher reads `dsh.profile`, the client loader reads `dsh.client`/`dsh.bundle`. So the update will **not** refuse to load the plugin over this. But the declaration no longer matches reality, and it is a contract others read; if upstream starts enforcing it, it becomes a real block.

**New 23rd test**, `test/engine-range.mjs`, pins all of it: every OR branch must carry a prerelease tag (the exact thing that was missing), 0.1.5/0.1.6/0.1.7 must be covered and 0.2 excluded, and where a real semver is present it verifies the 11 acceptances, the 4 rejections, and that **the installed harness version falls inside the range**. It derives its search paths instead of hardcoding them — `no-local-paths.mjs` caught that in the first draft, which is precisely its job.

**One upstream recommendation I deliberately did not follow:** contributing.md asks for official `@deepseek-ai/*` packages as `peerDependencies`. Adding them made `test/boot-safety.mjs` fail immediately, because that rule exists after a stray dev shim shadowed the real package and took the whole plugin tree down. This plugin imports nothing at runtime — it builds its tool schemas locally — so declaring peers would only create an install requirement (and possible ERESOLVE) while providing nothing.
