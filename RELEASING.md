# 发版流程（每一步都要做，缺一步就会留下不一致）

**GitHub 的 tag 和 Release 是两个不同的对象。** `git push origin vX.Y.Z` 只推送 tag；
`/releases` 页面上的 Release 必须**另外创建**。这个仓库曾经连续 14 个版本只推了 tag
（tag 页 30 个、Release 页停在 15 个），直到有人翻发行版页面才发现——那种不一致没人会收到通知。

## 顺序

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
| tag 已推送 | `git ls-remote --tags origin \| grep vX.Y.Z` |
| **Release 已创建** | `node tools/publish-release.mjs --check`，或打开 `/releases` |
