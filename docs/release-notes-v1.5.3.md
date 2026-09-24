# v1.5.3 — 以一般情况为标准：清掉"我这台机器"的假设

[English](#english) | 中文

这一版只有一件事：把**属于作者安装环境的事实**从**属于插件本身的事实**里分出来。CI 一个都没抓到——因为它一直只在那个假设所属的机器上跑。

## 最要紧的一处：模型每轮都读到的工具描述

`skill_search` 的描述原本写着"the ~1000-skill staged library under .skill-src"。**库只有 40 个技能的人，每一轮都会被告知一句关于他自己机器的假话**，而这句话是模型做选择时读的。

现在描述讲**机制**（在会话工作区同层或上层找到索引），不讲某一次安装的规模。`skill_load` 的描述原本说常驻侧是 `.dsh/skills`；它实际查的是运行时的 skills 服务——那个服务完全不必由文件系统提供。

`shape.mjs` 新增断言，禁止 `~1000`、`1000-skill`、`1025`、`.dsh/skills` 这类说法回到描述里。已验证：把它们塞回去，测试立刻失败。

## 把读者指向一个他不可能有的文件

索引不存在时的报错原文让读者去跑 `.skill-src\scan-skills.ps1`——**那个脚本只存在于作者的工作区**，而且用的是 Windows 专有的分隔符。任何按这条提示操作的人都会去找一个从来没在仓库里出现过的文件。

现在它指向 README 的两节（库放在哪、怎么生成索引）。`verify.mjs` 同时断言这一点，以及错误里**不得**再出现那个私有脚本名。

## 一个安全工具里的本机约定

`tools/audit-library-risk.mjs` 静默跳过一个名叫 `stageout` 的目录——作者的暂存目录名。在别人机器上，同名目录会被当成空的：**一条本机约定改变了安全工具给出的结论**。现在只跳过 `node_modules`。

## 检查器：从"按名字"改成"按形状"

`test/no-local-paths.mjs` 原本只匹配字面量 `Users|DSH Desktop|Vibe coding`。也就是说，它要防的那个 bug 在换个用户名或换台 CI 机器（`D:/ci/work/...`）时会**直接溜过去**——只能抓住已经发生过的那一个具体实例的检查器，抓不住下一个。

现在它对任何盘符路径和任何 `/home/<user>/` 路径都报警，只保留一份很短的放行清单，且每条都必须对应文档里真实发布的占位写法。双向验证过：仓库干净，且三种拼法的植入路径都能抓到。

## CI：把主平台纳入矩阵

Windows 现在是矩阵的一维（2 平台 × 3 版本 = 6 条腿），并关闭 fail-fast。`resolvePath` 带盘符与反斜杠处理、目录链接方案是 junction、文档主线是 PowerShell——只测 Ubuntu 等于**把主目标放在验证之外**。

fail-fast 本身就值得关掉：正是它让"三条腿全部真实失败"被读成"一条失败 + 两条取消"。

## 文档里的说法现在有测试兜着

README 让读者在库不在工作区时放一个链接指过去，并说这条已实测。它确实实测过——手动跑了一次 `tools/check-link-support.mjs`，而那个脚本**不在 `npm test` 里**。于是文档主推的那条 Windows 专有路径，在它所要描述的平台上没有任何覆盖。

新增 `test/link-support.mjs`：真的建一个链接，并走完搜索与加载。跑不动链接的运行器报告为**跳过**，不是通过——无权建链接是关于运行器的事实，不是关于插件的证据。两个平台都已确认是真跑，不是跳过。

## 其余

- `host.js` 开头的注释描述了一个本仓库并不存在的第二运行时（`session-package.js` / `build-session-package.mjs`）。**读者无法核对一个不存在的文件。** 注释改为描述实际提供的接缝（`register` 是参数）。
- 插件自报的名字是 `local-skill-router`，而包与组合行都叫 `dsh-skill-router`。已统一。
- `helpers.mjs` 只在 `AppData\Roaming` 下找打包版 DSH Desktop，于是 Linux 与 macOS 上会直接跳到更弱的本地断言。
- 测试夹具的路径从 `C:` 改为 `Q:`——不可能存在的盘符，一眼可辨是测试数据。
- 两份 README 在第十三个脚本加入后仍写着"十二个"；工作区里一个 42 KB 的 1.5.1 打包产物已清掉。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

## 测试

十四个（原十三个 + `link-support.mjs`），CI 在 **Linux 与 Windows** × Node 20 / 22 / 24 上全绿。

---

## English

This release does one thing: separating **facts about the author's installation** from **facts about the plugin**. CI caught none of it, because CI had only ever run on the machine those assumptions came from.

### The one that mattered most: a tool description the model reads every turn

`skill_search` announced "the ~1000-skill staged library under .skill-src". **A reader with a 40-skill library was told something untrue about their own machine on every turn**, and a tool description is what the model reads when choosing.

The descriptions now state the mechanism — an index found at or above the session workspace — rather than one installation's size. `skill_load` claimed the resident side is `.dsh/skills`; what it actually consults is the runtime's skills service, which need not be filesystem-backed at all.

`shape.mjs` now asserts that `~1000`, `1000-skill`, `1025` and `.dsh/skills` cannot come back. Verified the other way too: put them back and the test fails immediately.

### Pointing the reader at a file they cannot have

The missing-index error told the reader to run `.skill-src\scan-skills.ps1` — **a scanner that exists only in the author's workspace**, with a Windows-only separator. Anyone following that message went looking for a file that was never in the repository.

It now points at the README's two relevant sections. `verify.mjs` asserts both the pointer and that the private script name is gone.

### A machine-local convention inside a security tool

`tools/audit-library-risk.mjs` silently skipped any directory named `stageout` — the author's scratch directory. On anyone else's machine a directory by that name was audited as if it were empty: **a machine-local convention changing what a security tool reports**. Only `node_modules` is skipped now.

### The scanner: judgement by shape, not by name

`test/no-local-paths.mjs` matched only the literal names `Users|DSH Desktop|Vibe coding`. The very bug it exists to prevent would slip through on a machine with a different user name or on a CI builder (`D:/ci/work/...`) — a checker that can only catch the one instance that already happened cannot catch the next one.

It now flags any drive-letter path and any `/home/<user>/` path, keeping a short allow list where every entry corresponds to a placeholder the docs actually publish. Verified in both directions: clean on the repo, and planted paths in three spellings are all caught.

### CI: the primary platform is now in the matrix

Windows is a matrix dimension (2 OS × 3 Node = 6 legs), with fail-fast disabled. `resolvePath` carries drive-letter and backslash handling, the link recipe is a junction, and the docs lead with PowerShell — testing only Ubuntu **left the primary target unverified**.

Disabling fail-fast matters on its own: it is what made a genuine failure on all three legs read as one failure plus two cancellations.

### A documented claim now has a test behind it

The README tells readers to place a link when the library lives elsewhere, and says this is tested. It was — by hand, once, via `tools/check-link-support.mjs`, which is **not in `npm test`**. So the one Windows-specific path the docs lead with had no coverage on the platform whose behaviour it documents.

`test/link-support.mjs` builds a real link and drives search and load through it. A runner that refuses to create a link reports a **skip**, not a pass: being unable to create a link is a fact about the runner, not evidence about the plugin. Confirmed on both platforms to be genuinely running, not skipped.

### The rest

- `host.js` opened by describing a second runtime (`session-package.js`, built by `build-session-package.mjs`) that this repository does not contain. **A reader cannot check a claim about a file that isn't there.** The comment now describes the seam the code actually offers: `register` is a parameter.
- The plugin reported its own name as `local-skill-router` while the package and composed row are `dsh-skill-router`. Unified.
- `helpers.mjs` looked for a packaged DSH Desktop only under `AppData\Roaming`, so on Linux and macOS it went straight to weaker local assertions.
- Test fixtures use `Q:` instead of `C:` — a drive letter that cannot exist, so they read unmistakably as test data.
- Both READMEs still said "twelve scripts" after the thirteenth was added; a stale 42 KB 1.5.1 pack artifact is gone from the working tree.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`

### Tests

Fourteen (thirteen plus `link-support.mjs`), green on **Linux and Windows** × Node 20 / 22 / 24.
