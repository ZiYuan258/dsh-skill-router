# 发版流程（每一步都要做，缺一步就会留下不一致）

**GitHub 的 tag 和 Release 是两个不同的对象。** `git push origin vX.Y.Z` 只推送 tag；
`/releases` 页面上的 Release 必须**另外创建**。这个仓库曾经连续 14 个版本只推了 tag
（tag 页 30 个、Release 页停在 15 个），直到有人翻发行版页面才发现——那种不一致没人会收到通知。

## 什么时候才发版

**版本号只在插件行为变化时才动。** 判断标准是"装上它的人会不会观察到不同"：

| 改动 | 是否发版 |
|---|---|
| `host.js` / `client.js` 的行为、`package.json` 的元数据（入口、`dsh.bundle`、依赖） | **要**，补丁位 +1 |
| 工具脚本、文档、测试、CI 配置 | **不要**，直接提交 `main` |

工具、文档、测试没有版本号也能正常工作，给它们发版会让版本历史看起来像"插件更新了很多次"。

> 这条规则是吃了一次教训写下的：我曾为了"多一个测试脚本 + 一个发布脚本"发了一版 v1.9.2，
> 事后撤回。当时我说"新版本需要发布说明，而检查要求如此"——**那是把因果说反了**：不是"要发版
> 所以写说明"，而是"我 bump 了一版，于是自己的检查要求我补说明"。检查是用来防"漏建 Release"
> 的，不该被用来给"每次提交都发版"背书。`test/release-consistency.mjs` 里那条"当前版本必须有
> 发布说明"已删除，正是因为它会强迫这件事。

## 顺序（只在发版时执行）

```sh
# 1. 改版本号：两处必须一致，test/package-contract.mjs 会核对
#    package.json 的 version
#    client.js 的 const VERSION = 'X.Y.Z'

# 2. 写发布说明：中英双语，中文在前，含 "## English" 一节
#    docs/release-notes-vX.Y.Z.md

# 3. 全套测试（含 docs-parity：双语结构、编码、发布说明格式）
npm test

# 4. 提交、打标签、推送
git add -A
git commit -m "..."
git tag -a vX.Y.Z -m "vX.Y.Z - <一句话>"
git push origin main
git push origin vX.Y.Z

# 5. 建 Release —— 这一步最容易漏，而且漏了没有任何提示
node tools/publish-release.mjs
```

第 5 步的脚本会读 `package.json` 的版本、读 `docs/release-notes-vX.Y.Z.md`、
用它的 H1 作标题、全文作正文来创建 Release；已存在则跳过，所以重复执行是安全的。

```sh
node tools/publish-release.mjs            # 当前版本
node tools/publish-release.mjs --check    # 只检查有没有 Release，不创建
node tools/publish-release.mjs --all      # 回填所有缺 Release 的版本
```

需要 `gh` 已登录（或 `GH_TOKEN` 环境变量）。

## 为什么要脚本而不是记住步骤

因为"推了 tag"和"建了 Release"在本地看起来完全一样——`git tag` 都有、`git push` 都成功。
只有去 GitHub 的发行版页面才看得出差别，而没有任何人会每天去看那个页面。把最后一步做成
一条命令，是这类"静默不一致"唯一可靠的防法。

## 检查清单

| 步骤 | 验证方式 |
|---|---|
| 版本号两处一致 | `npm test` → `package contract` 里的版本断言 |
| 发布说明双语且中文在前 | `npm test` → `docs parity` |
| 发布说明格式（标题带版本号、文件名规范） | `npm test` → `发版一致性` |
| tag 已推送 | `git ls-remote --tags origin` 里有 `vX.Y.Z` |
| **Release 已创建** | `node tools/publish-release.mjs --check`，或打开 `/releases` |
