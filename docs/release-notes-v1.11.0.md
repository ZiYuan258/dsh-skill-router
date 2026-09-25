# v1.11.0 — 下载即用：入门技能库 + 可运行的索引生成器 + 体检

[English](#english) | 中文

在这之前，装完插件只是**装了一个工具**：用户还得自己检出技能库、自己写生成器、自己核对索引。这一版把"准备技能库"从**用户必须完成的部署流程**变成**可选的自动化初始化**。

三层，各管一件事。

## 一、装完就能用：随插件发布的入门技能库

插件自带 5 个技能，覆盖整条工作链：

| 技能 | 管什么 |
|---|---|
| `search-before-guessing` | 该先搜再动手的场景（框架/协议/流程），以及**什么时候不该搜** |
| `evidence-before-claims` | 说"修好了/通过了"之前必须跑命令并读到输出 |
| `debug-with-evidence` | 先取证再改代码；"修了没效果"说明的是诊断错了 |
| `scope-before-building` | 需求不清楚时先问一轮，并写下验收判据 |
| `report-results-clearly` | 先说结论、附上证据、说清未验证的部分 |

没有自己的库时它就是你的库，`skill_search` 立刻有东西可搜：

```
skill_search "debug"
→ debug-with-evidence
```

返回值带 **`starterLibrary: true`**，`library:` 指向插件包内路径。**看见这个标记就说明读的是入门库**——"我的库被读到了"和"这是入门示例"是两种完全不同的诊断方向，所以必须能分辨。有自己的库时这个标记不出现。

> **入门技能绝不进常驻目录。** 它们在插件包的 `resources/starter-skills/` 下，走 `skill_search` / `skill_load` 这条路。把入门技能放进 `.dsh/skills/` 会让它们每轮进上下文——那正好毁掉这个插件的全部意义。`test/starter-library.mjs` 有一条独立断言守这件事，而且它断言的是"插件没有任何往常驻目录注册技能的调用"，不是"我没这么写"。

**为什么是 5 个而不是 1000 个。** 这个插件解决的问题就是"大库不要常驻"。往包里塞一个大库会同时带来包体、更新滞后、许可证混杂、版本绑定四类问题。入门库只负责"装完不空"，真正的能力覆盖靠用户接自己的库。

## 二、`tools/build-index.mjs`：索引生成器不再是"参考实现"

```
node tools/build-index.mjs <库根>            # 生成 / 覆盖 <库根>/skill-index.tsv
node tools/build-index.mjs <库根> --check    # 只报告是否与磁盘一致（不一致退出码 1）
node tools/build-index.mjs <库根> --stdout   # 写到标准输出
```

零依赖、跨平台，递归找 `SKILL.md`、解析 YAML frontmatter、用真正的 TSV 转义（描述含制表符/引号/换行不会坏列）、`whenToUse` 只在至少一行有时才写第 7 列。

README 里那段要用户自己复制、自己改 `$root` 的 PowerShell 参考实现已经**删掉**，理由是它有实质缺陷：只扫一层、不产出 `whenToUse`、**漏掉没有 frontmatter 的技能**。实测同一个库：

| | 技能行数 |
|---|---|
| 老参考实现产出的索引 | **1025** |
| `build-index.mjs` | **1028** |

漏掉的 3 个在微软那个 monorepo 里，没有 frontmatter，于是**永远搜不到**。

### 它的第一版是错的，而计数检查抓不到

`relpath` 必须是**相对仓库根**，不是相对库根——插件按 `<库>/<repo>/<relpath>/SKILL.md` 拼路径。第一版传了库根进去，于是每一行都多套了一层 `repo/`：

```
行数：1028 = 1028          ← 完全一致
键集合：看起来也合理
能拼出真实文件的行：0 / 1028
```

**行数对、键集合对、全部拼不出文件。** 所以这个生成器的测试里最重要的一条断言不是"行数对不对"，而是"**每一行都必须按插件的路径规则解析到一个真实存在的 SKILL.md**"。那条断言是拿真库跑出来的（1028/1028），现在它是一条会红的检查。

## 三、`tools/doctor.mjs`：体检

```
node tools/doctor.mjs [--root <库根>] [--json]
```

装完之后用户的失败体验全是**沉默的**：索引在但过期、技能忘了重新索引、描述为空导致永远搜不到、名字撞车导致 `skill_load` 需要 `repo`。这些都能算出来，但原先只藏在工具返回值里，要用户自己想出该问什么。

它对**你自己的库**跑出来的第一份报告：

```
技能：      1028 个，来自 26 个仓库
已索引：     1025 条（磁盘上有 1028 个）
缺失：      3 个
重名：      79 个名字
无描述：     3 个

重名（skill_load 需要 repo 提示）：
  test-driven-development × 5  addyosmani-skills, context-eng-kit, superpowers
  context-engineering × 4  addyosmani-skills, context-eng-kit
  …

结论：有 1 项需要处理
  · 3 个技能在磁盘上但不在索引里（搜不到它们）
```

它会**双向**比对"磁盘上有"与"索引里有"，两个方向都报。

## 一处行为改变（会影响已有测试，也应当如此）

`verify.mjs` 里有两条断言原本是"没有库时必须报错"。回退改变了这个行为，所以它们红了——这正是测试该做的事。现在改为：

- **没有自己的库 → 断言确实读到入门库、且标记为 `starterLibrary: true`**（新行为，也是这一版的目的）；
- **连入门库都没有 → 断言仍然报出"找不到 skill-index.tsv"并指向 README**（旧分支仍然存在，用一份"拒绝 starter-skills 路径"的 fs 真正触发它，不是只留个意图）。

## 工程注意

- `resources/` 加入了 `package.json` 的 `files`。这个坑踩过三次（`discovery.js` 两次、`resources` 一次）：本地开发永远正常，用户装上就是缺文件。现在有一条断言盯着发布清单。
- `host.js` 现在用 `import.meta.url` 定位自己的包。**宿主把它当经典脚本拼接会让整个插件在解析期就死**，所以这一条是实测过的：真 ESM 加载 + `apply()` 调用都通过。
- 回退整段包在 try 里：`import.meta` 万一不可用，只是回退不生效，不会让插件加载失败。

## 测试

27 个脚本（新增 `build-index.mjs`、`doctor.mjs`、`starter-library.mjs`）。`doctor` 的每条断言都构造一种**真实故障**并要求它被报出来——一个永远返回"健康"的体检工具也能通过"健康库返回 OK"那种测试。

## English

Until now, installing this plugin got you **a tool**: you still had to check out a skill library, write an index generator, and audit the result yourself. This release turns "prepare a library" from **a deployment flow the user must complete** into **an optional, automated initialisation**.

**1. It works once installed.** The plugin ships 5 starter skills covering the whole chain — search before guessing, evidence before claims, debug with evidence, scope before building, report results clearly. With no library of your own, that *is* the library, and `skill_search` finds something immediately. The result carries **`starterLibrary: true`**, because "your library was read" and "this is the bundled example" call for completely different diagnosis; the flag is absent when you have your own library.

**The starter skills never enter the resident catalog**, and that is asserted rather than intended: `test/starter-library.mjs` checks that the plugin makes no call that would register skills as resident, and that the bundled library sits inside the package. Shipping 5 rather than 1,000 is deliberate — the problem this plugin solves is a large library that must not stay resident, and bundling one would bring package size, update lag, licence mixing and version coupling at once.

**2. `tools/build-index.mjs` replaces the "reference implementation".** Zero dependencies, cross-platform, real TSV escaping, `whenToUse` written only when present. The old PowerShell block is gone because it had real defects: it scanned one level, never emitted `whenToUse`, and **missed skills without frontmatter**. Measured on one library: the old approach's index held **1,025** rows against **1,028** on disk — the three missing skills were unfindable, permanently.

Its **first version was wrong in a way counting cannot catch**: `relpath` must be relative to the *repo root*, not the library root, and the first version added an extra `repo/` level to all 1,028 rows. **Row counts matched exactly. Key sets looked right. Zero of 1,028 resolved to a real file.** So the generator's most important assertion is not "is the count right" but "**does every row resolve to an existing `SKILL.md` by the plugin's own path rule**" — verified against a real library at 1,028/1,028, and now a check that can go red.

**3. `tools/doctor.mjs`** reports what the user otherwise discovers silently: a stale index, skills missing from it, empty descriptions (unfindable), and duplicate names. It compares on-disk against in-index **in both directions**. Run against this machine's library it immediately surfaced 3 missing skills and 79 duplicated names.

**One behaviour change, and the existing test caught it.** Two assertions in `verify.mjs` demanded an error when no library exists; the fallback changed that, so they went red — which is what they are for. They now assert the new behaviour (the bundled library is used and flagged) and keep the old branch reachable by building a tool set whose fs refuses any `starter-skills` path, so the missing-index error path is genuinely exercised rather than merely intended.

**Engineering notes:** `resources/` joined `package.json`'s `files` (that omission has now bitten three times — local development always looks fine and the user's install is missing files, so a test watches the manifest); `host.js` locates its own package via `import.meta.url`, which was **measured** to work because a host that concatenated it as a classic script would die at parse time; and the whole fallback is wrapped so an unavailable `import.meta` disables the fallback rather than the plugin.

**27 test scripts** (three new). Every `doctor` assertion constructs a real failure and requires it to be reported — a check-up that always says "healthy" would pass a test that only feeds it healthy libraries.
