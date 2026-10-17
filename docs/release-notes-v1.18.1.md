# v1.18.1 — 适配 DSH 0.2.1-rc.2：引擎范围补 0.2.x、修好两条静默失效的检查

[English](#english) | 中文

**运行代码不变。** 这一版只做三件事：让 `dsh.engines.dsh` 说出真话、把两条"看起来在检查、其实已经失效"的测试修回可用、以及让入门库的路径判据不再误报。

## 背景

DSH 从 0.1.7-rc 线升到 **0.2.1-rc.2**，同时把插件从 `C:\Users\21450\dsh-plugins\` 迁到 `<DSH_HOME>/plugins/`（profile 依赖由 `link:` 变成 `file:`）。本插件照常加载、32/33 测试通过——失败的与失配的正是下面三处。

## 改了什么

### 1. `dsh.engines.dsh` 补上 0.2.x

旧范围上界是 `<0.2.0-0`，而装着的 harness 是 **0.2.1-rc.2**，声明与事实不符。现在逐 tuple 枚举到 0.2.1、上界收到 0.3：

```
>=0.1.0-rc.1 <0.1.5-rc.1 || >=0.1.5-rc.1 <0.1.6-rc.1 || >=0.1.6-rc.1 <0.1.7-rc.1
|| >=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0
```

**为什么必须逐 tuple**：node-semver 只放行"某个比较符的 major.minor.patch 元组完全相同、且该比较符自身也带预发布标签"的预发布版本。所以 `>=0.2.0-0 <0.3.0-0` **并不**接纳 0.2.1-rc.2（tuple 是 0.2.1，不是 0.2.0）。已知边界：0.2.2+ 的**预发布**不在范围内，一旦它成为真实安装版，下面那条断言会报出来。

（实测：本机装了 12 个插件，**只有本插件声明 `dsh.engines.dsh`**，其余全为空；DSH 当前也不强制它——`compatibility.json` 是 `{}`。所以这条修的是"声明与事实一致"，不是"通不过门控"。）

### 2. `test/engine-range.mjs`：两条断言都已静默失效

- **"已装版本在范围内"根本没跑**：它靠从 DSH 安装里找 `@deepseek-ai/dsh-tools` 来取版本，而 0.2 布局把它放进 asar 与 pnpm 链接后面（`profiles/node_modules/@deepseek-ai/*` 甚至是指向已不存在路径的悬空链接），于是每次都打印"跳过"。**这次失配正是它该抓的，它没抓到。**
- **真实 semver 的交叉验证也没跑**：profile 里找不到 `semver` 包。

改法：本仓库零依赖，所以自带一个只覆盖本项目范围形状的 `satisfies`（复刻上面那条预发布规则），用它实测 16 个已发布版本与 3 个越界版本；已装 harness 的版本改成问 CLI 自己（`dsh --version`，Windows 上需过一层 shell 才能启动 `.cmd`），取不到就跳过——CI 里没有 `dsh`。现在本机会如实报出 `本机已装的 harness 0.2.1-rc.2 落在范围内`。

### 3. `test/starter-library.mjs`：路径判据误报

产品不变量是"入门库绝不能落在常驻根（`.dsh/skills`）下"，断言却写成了"路径里不能出现 `.dsh`"。插件迁到 `.dsh/plugins/` 之后，插件根必然含 `.dsh` → 误报。判据收窄为只匹配常驻根（`/(^|[\\/])\.dsh[\\/]+skills([\\/]|$)/`），不变量不变。

## 没有改什么

`host.js` 行为、`client.js` 行为（只动了版本号常量）、搜索算法、注入层开关——都没动。新增依赖：无。

---

## English

**No runtime behavior change.** Three things only: make `dsh.engines.dsh` tell the truth, repair two tests that had silently stopped checking, and stop the starter-library path assertion from false-positiving.

## Background

DSH moved from the 0.1.7-rc line to **0.2.1-rc.2** and relocated plugins from `C:\Users\21450\dsh-plugins\` to `<DSH_HOME>/plugins/` (the profile dependency changed from `link:` to `file:`). The plugin still loads and 32/33 tests passed; the failure and the two mismatches are below.

## What changed

1. **`dsh.engines.dsh` now covers 0.2.x.** The old range capped at `<0.2.0-0` while the installed harness is **0.2.1-rc.2** — the declaration was false. It now enumerates 0.1.5/0.1.6/0.1.7/0.2.0/0.2.1 and caps at 0.3. Each tuple must be listed because node-semver only admits a prerelease whose major.minor.patch tuple matches a comparator that itself carries a prerelease tag — `>=0.2.0-0 <0.3.0-0` does **not** admit 0.2.1-rc.2. Known boundary: prereleases of 0.2.2+ are outside the range; if one becomes the installed build, the assertion below reports it. (Measured: of 12 installed plugins, only this one declares `dsh.engines.dsh`; DSH does not currently enforce it — `compatibility.json` is `{}`.)

2. **`test/engine-range.mjs` had two dead assertions.** The "installed harness is in range" check located the version via `@deepseek-ai/dsh-tools`, which the 0.2 layout hides behind the asar and pnpm links, so it printed "skipped" every run — the very check meant to catch this drift. The real-semver cross-check was dead too (no `semver` package under the profile). Both are replaced by a small dependency-free `satisfies` that replicates the prerelease rule, plus `dsh --version` to confirm the installed harness (skipped where `dsh` is absent, as in CI).

3. **`test/starter-library.mjs` path assertion was too broad.** The invariant is "the starter library must not sit under a resident root (`.dsh/skills`)", but the check said "the path must not contain `.dsh`" — false once plugins live under `.dsh/plugins/`. It now matches resident roots only.

## What did not change

`host.js` behavior, `client.js` behavior (only the version constant), the search algorithm, the injection flag. New dependencies: none.
