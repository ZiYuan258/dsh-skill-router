# v1.16.0 — 搜索正确性修复：中文不再假成功、搜索域并入会话目录、单词查询分档、索引完整性报警

[English](#english) | 中文

**这是一次搜索正确性的修复，不是刺激的改变。** 注入层的阈值、措辞、`INJECT_TIERS` 与分臂逻辑一行没动 —— treatment 臂看到的提示与 v1.15.5 逐字相同。

> **★ 先读这一段：搜索质量提升了，但这不改变使用率。**
>
> **修复前**有一组干净对照：**18 个"搜索可得"的历史机会单元里，0 个被加载**（历史读数，不是对修复后的预测）。修复后 `skill_search` 能返回对的候选（下面每个例子都有读数）——但**没有理由认为模型会因此开始主动搜索**。
>
> 理由是：**观察到的瓶颈不在搜索质量**。来自同一批转录的**四种不同形态的观察**指向同一个条件——**技能被使用的条件是「用户请求主语 = 技能对象」**，而不是「技能可用 / 可见 / 在候选里」：目录可见 0/12、指针注入 0/45、正文完整在手 10 次机会 0 次使用、208 项目录 0 次技能族调用。
>
> 这四种形态的观察说明的是"搜索质量不是**已观测到的**那个限制因素"；它们**不**说明搜索质量永远不可能成为限制因素，也**不**说明使用率被证明恒为 0。本版没有测"修好搜索之后会发生什么"——那需要新的观察窗口，而那正是下一节要说的事。
>
> 所以本版的定义是**修 bug**：修的是"声明说会做、实现没做"和"做错了但看不出错"。不期待转化率，但也不把"转化率不会变"当作已验证的结论。

版本号从 v1.15.5 走到 **v1.16.0**（而非补丁位 +1），因为 ② 和 ③ 改变了搜索结果本身——域扩大了、排序键多了一层。按 semver，可观察的行为变化是 minor。

---

## 四项修复，按用户能感知的顺序

### ① 中文查询不再"假成功"

**症状**：`C盘清理 系统盘治理 磁盘空间` 这类查询返回 **7,643 条**（全库 99.3%），第一条是 `c-review`。

**机制**：tokenizer 把非拉丁字符整体替换成空格：

```js
.replace(/[^a-z0-9+#._-]+/g, ' ')     // 汉字全部变成空格
```

`C盘清理…` 于是只剩 `C盘` 里的那个 ASCII 字母。它落进"整条查询都是停用词"的回退分支：

```js
const meaningful = tokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t))
return meaningful.length > 0 ? meaningful : tokens     // ← 回退到未过滤的 tokens
```

回退本意是服务 `the a of` 这种查询（说点什么总比说没有好）。但中文查询从这里拿到了 `tokens = ["c"]`，而**字母 c 出现在 7,643 / 7,700 行里**。

**为什么这比"搜不到"更糟**：返回 0 条时模型会换词；返回一屏像模像样的结果时，它无从知道一个关键词都没匹配上。这是**假成功**——错误被结果的外表掩盖了。

**修复**：回退放行前要求至少一个 token 长度 ≥ 2。

| 查询 | 修复前 | 修复后 |
|---|---|---|
| `C盘清理 系统盘治理 磁盘空间` | total=**7643**，top1=`c-review` | **no searchable keyword** |
| `C盘清理 系统盘治理` | total=**7643** | **no searchable keyword** |
| `做视频` | no searchable keyword | no searchable keyword（不变）|
| `the a of` | total=1598 | total=1598（**逐字不变**）|

单字母查询（`a` / `c`）现在也如实报"无可用关键词"，而不是匹配整个库。

### ② `skill_search` 现在搜索会话目录（catalog），不只搜库

**症状**：工具声明写的是

> `Search every skill available to this agent: the session skill catalog plus the staged library`

而实现只读了 `.skill-src/skill-index.tsv`。全文件只有 `parseIndex` 一处 `rows.push`，没有任何位置把会话目录并进来。

**后果**（实测于真实会话）：搜 `hindsight` 返回 0 条，而 `hindsight-coding-agent` **当时就在那个会话的目录里**——它由用户级 `user-agents` 根提供，不在库索引里。`cordis` 同样：库里 0 行，答案在目录里。

**修复**：`skill_search` 现在通过 `ctx.get('skills').list({ cwd, scope, signal })` 并入会话目录。

**为什么必须走这个接口**：目录是**三层合并**——运行时注册（别的插件在 apply 时注册）、各 provider 的 `list()`、随 DSH 发布的 bundled。自己扫磁盘只能拿到中间层。实测：`dsh-univer-office` 用 `ctx.skills.registerProvider()` 注册了 8 个 `univer*` 技能，它们既不在工作区目录树、也不在 app bundle 里——扫磁盘的写法会整个漏掉它们（第一版实现就是这么漏的）。

| 查询 | 修复前 | 修复后 |
|---|---|---|
| `hindsight` | total=2，**无目标** | total=**3**，`hindsight-coding-agent` **第 2 位** |
| `cordis` | total=**0** | total=**1**（`dsh-plugin-failures`）|
| `univer` | total=44，top3 全是 `universal-*` | total=**52**，前 8 位是 `univer` / `univer-doc` / `univer-base`… |

**没有给 catalog 排序特权。** `hindsight` 落在第 2 位是排序算法自己算出来的——如果加了特权，这个第 2 位就不能再作为"排序能处理跨域候选"的证据。

**catalog 行没有 repo / relpath。** registry 的 `toSummary()` 只给 `{ name, path?, description, whenToUse?, invocation, source, provider, resourceBase? }`。这两个字段在搜索里有三处用途（打分、`libraryRelative`、定位文件），所以 catalog 行带 `origin: 'catalog'` 并用自己的绝对路径定位——否则 `resolveRow` 会拼出 `rootDir//SKILL.md`，`stat` 失败，然后把**每一条健康的 catalog 技能**标成 `STALE: SKILL.md is missing`。

**副本计数改成结构化**：`copies` 从数字变成 `{ total, library, catalog }`。原因是同名可以来自两个域（`next-dev-loop` 实测：库一份、`project-dsh` 一份），而两者的正确动作不同——库内多份要 `repo` 才能选，跨域同名**不能**靠 `repo` 选（catalog 技能不属于任何仓库）。合成一个数字会让模型去找一个不存在的参数。

**失败即降级**：`ctx.get` 不存在、`skills.list` 不存在、或 registry 抛错，搜索都回到"只有库"的旧行为，绝不因此失败。

### ③ 单词查询按名字匹配质量分档

**症状**：`includes` 是子串匹配，一个单词查询会拖回大量"只有描述里出现过这个词"的行。`univer` 命中 44 条而名字含它的只有 3 条；`test` 命中 829 条。

**修复**：命中按"关键词是否落在**名字**里"分档。**这不是过滤**——`total` 仍报全量，新增 `nameMatched` 报第一档条数，两者之差就是"只被描述命中"的条数。

`univer` 修复后：

```
total: 52      ← 一个字都没少（含 41 条 universal-* / universe 等拼写巧合）
nameMatched: 11
shown: 11
```

档内按匹配形态排序：**完全相等 > 词段边界 > 裸前缀 > 子串**。

- `univer` → `univer`（完全相等）
- `univer` → `univer-sheet`（`univer` 是完整词段）
- `univer` → `universal-checkout`（只是 `universal` 的开头，切在词中间 ← 44 条噪音的来源）
- `test` → `latest`（仅子串）

**只对单词查询生效**，这个边界是实测定的：一开始对**所有**查询分档，回归套件立刻抓到三处破坏——`debug failing test` 丢了 `api-analyzer`、`kubernetes helm` 丢了 2/3、`semgrep security scan` 顺序被打乱。多词查询里 `matchCount`（命中几个关键词）才是相关度信号；而单词查询里它恒等于 1，不携带任何信息。

#### 为什么不改成"词边界匹配"

处理子串噪音最直觉的方案是要求词边界。它被实现、用 27 条真实查询实测，然后**否决**：

| 查询 | 现状 top3 | 加词边界后 |
|---|---|---|
| `debug failing test` | `test-blindspots`, **`systematic-debugging`**, `api-analyzer` | `diagnose`, `api-analyzer`, `go-troubleshooting` ← 正确项被挤出 |
| `univer` | 44 条 | **0 条** |

致命处：**`debugging` 是 `systematic-debugging` 的子串**，而技能名绝大多数是连字符复合形式。词边界会把名字本身切断。记在这里，因为这个想法足够直觉，以后还会有人提。

#### 一条例外：当名字信号本身不可信时

如果第一档**全部**是裸前缀（名字里根本没有这个词，命中全是拼写巧合）而第二档非空，"名字命中优先"的前提就失效了。此时第二档被**追加**而不是挡住，并在 note 里说明是拼写巧合。

扫描 55 个查询找这个条件：**恰好命中一条**，且只在退化路径——catalog 不可达（minimal host 或目录收集失败）时搜 `univer`，第一档 3 条全是 `universal-*`、41 条被挡在后面。目录正常时第一档含 `univer` 与 `univer-*`，前提成立，例外不触发。

#### 一个要留意的读数：`nameMatched: 0` 不代表没有命中

`cordis` 修复后返回 `total=1, nameMatched=0, shown=1`。**这不是 bug**，而是上面两条设计同时生效的结果，值得单独说明，否则读读数的人会以为分档算错了：

```
dsh-plugin-failures    origin=catalog  source=project-dsh  matchCount=1
  score=64   why=cordis: +64 (description+whenToUse)
```

- **命中是真的**：它来自该技能 `whenToUse` 里的 `cordis.patch.yml`（`whenToUse` 权重 +40，description +24）。
- **`nameMatched=0` 也是真的**：这个技能的**名字**里没有 `cordis`，所以它不属于第一档。
- **它仍然可见**，因为"第一档为空 ⇒ 放开第二档"。

⇒ 所以读 `skill_search` 的返回值时，`total > 0` 与 `nameMatched = 0` 可以同时成立，含义是"命中了，但都只在描述/触发词里，名字里没有"。这也是 `whenToUse` 确实参与评分的直接证据。

### ④ 索引完整性检查

索引（`skill-index.tsv`）是检索层的契约，它曾经被一次重跑**无声**换掉口径（1,302 行 → 8,690 行），四天后才被撞见。一个描述自己的文件，不等于一个被检查的文件。

**修复**：两层检查，**两条互相独立的判据，都只报警、不阻止搜索**：

- **① hash 不一致** ⇒ 索引被外部工具改过、没走生成脚本；
- **② 行数漂移超过 10%** ⇒ 规模变化必须解释。

| 位置 | 做什么 | 怎么触发 |
|---|---|---|
| 检索层 | 索引缓存重载时自检；真报警才在 `skill_search` 返回值里加 `indexAlarm`，并把提示前置到 `note` | 任何一次 `skill_search`（正常路径零成本）|
| `index-integrity.mjs` | 字节级精确 hash 比对 + 生成器不变式诊断，退出码 0/1 | `node .skill-src/index-integrity.mjs` |

检索层做不了精确 hash——`ctx.fs` 只暴露 `resolve` / `stat` / `listDir` / `readText`，没有字节读取。所以精确校验放在独立脚本里。

**同时修掉的生成器缺陷**：`scan-skills.ps1` 过去顺序直写四个产物，中途失败会留下"本体已换、身份文件没换"的中间态——正好制造它自己要检测的那种不一致。现在改为**先写临时文件 → 提交前校验 → 统一 rename**，失败则放弃全部四个产物、旧文件原样保留。

> 这个校验器第一次运行就拦住了我自己的错误：我把行数不变式写错（8,691 vs 正确的 7,747），脚本拒绝提交、清理临时文件、旧索引原样保留。校验不是形式，是拦截器。

---

## 回归：79 次查询，新旧版本并排跑

把改动前的 `host.js` 与当前版本放在同一套 mock 环境下逐条对比，查询集 = 24 条历史真实查询（转录里实际出现过的）+ 50 个真实单词查询 + 5 条中文/退化查询。

| 结果 | 数量 |
|---|---|
| **前三条完全不变** | **58 / 79** |
| 有变化 | 21 / 79 |
| — ① 从"假成功"变成如实报错 | **2** |
| — ② `total` 变化（catalog 并入域）| **6** |
| — ③ 前三条重排（名字分档）| **13** |
| — ④ 其他 | **0** |

**每一处变化逐条列出：**

**① 假成功 → 如实报错（2 处）**

| 查询 | 旧 | 新 |
|---|---|---|
| `C盘清理 系统盘治理 磁盘空间` | total=7643 | no searchable keyword |
| `C盘清理 系统盘治理` | total=7643 | no searchable keyword |

**② `total` 变化 / catalog 并入域（6 处）**

| 查询 | 旧 total | 新 total | 变化 |
|---|---|---|---|
| `univer` | 44 | 52 | +8（目录里的 `univer*`）|
| `hindsight` | 2 | 3 | +1（目标本身）|
| `cordis` | 0 | 1 | +1（从"搜不到"到"搜到"）|
| `data` | 449 | 450 | +1 |
| `version` | 289 | 290 | +1 |
| `config` | 612 | 613 | +1 |

**③ 前三条重排 / 名字分档（13 处）**

这 13 处**逐条审过，均为改善；未发现退化**——这是审阅结论，不是机器判定的客观事实（判据是"名字匹配形态更强的排到了前面"，每一处都列在下面，可自行复核）。

| 查询 | 旧 top3 | 新 top3 |
|---|---|---|
| `refactor` | `refactor`, `go-refactoring`, `sepia-refactor` | `refactor`, `sepia-refactor`, `workflow-refactor` |
| `python` | （子串巧合优先）| （词段匹配优先）|
| `sql` | （同上）| （同上）|
| `terraform` | （同上）| （同上）|
| `video` | `video`, `video`, `videodb` | `video`, `video`, `demo-video` |
| `branch` | `create-branch`, `workspace-branch`, `mirrord-db-branching` | `create-branch`, `workspace-branch`, `finishing-a-development-branch` |
| `debug` | `debugview`, `doca-debug`, `debug-error` | `doca-debug`, `debug-error`, `web-debug-search` |
| `bug` | `debugview`, `find-bugs`, `doca-debug` | **`bug-analysis`**, `debugview`, `find-bugs` |
| `error` | `debug-error`, `venice-errors`, `Error Resolver` | `debug-error`, `Error Resolver`, `error-handling-ux` |
| `exception` | 3 条子串巧合 | 1 条词段匹配 |
| `log` | `blog`, `shiplog`, `blog-geo` | `implementing-cloud-trail-log-analysis`, `implementing-log-forwarding-with-fluentd`, `performing-log-source-onboarding-in-siem` |
| `metric` | `asc-metrics`, `metric-creation`, `torch-geometric` | `metric-creation`, `metric-calculator`, `north-star-metric` |
| `alert` | `competitor-alerts`, `vss-manage-alerts`, `gke-alert-configuration` | `gke-alert-configuration`, `cloud-run-alert-configuration`, `agent-platform-alert-configuration` |

`log` 与 `bug` 最能说明问题：旧版把 `blog` / `shiplog`（含 `log` 但语义无关）排在前面，把 `bug-analysis` 挤在后面。

**多词查询逐条回归**（这些是用户给的底线，前三条必须逐字不变）：

| 查询 | 前三条 |
|---|---|
| `debug failing test` | `test-blindspots`, `systematic-debugging`, `api-analyzer` ✓ |
| `kubernetes helm` | `securing-helm-chart-deployments`, `mirrord-kafka`, `mirrord-temporal` ✓ |
| `semgrep security scan` | `implementing-devsecops-security-scanning`, `semgrep`, `clawsec-scanner` ✓ |
| `test driven development` | `test-driven-development` ×3 ✓ |
| `systematic debugging failing test root cause` | `systematic-debugging` ✓ |
| `remotion video` | `video`, `remotion`, `video-polish` ✓ |
| `git worktree` | `git-worktrees`, `using-git-worktrees` ✓ |
| `verification before completion evidence` | `verification-before-completion` ✓ |
| `poka-yoke mistake-proof` | `poka-yoke` ✓ |
| `next-dev-loop` | `next-dev-loop` ✓ |

单词查询的另一条底线：`debugging` → `systematic-debugging` 仍第 1 位 ✓。

---

## 两个升级注意

1. **运行中的插件实例不含新代码。** 插件的源码在会话启动时加载，**重启 DSH 后本版才生效**（README 的「索引与完整性」一节也写着这一条）。
2. **索引完整性报警同样只在重启后可见。** 如果你手工改了索引，当前会话不会知道，直到下次重载。

## 没有动的东西

- 注入层的阈值（`INJECT_TIERS` / `DISCOVERY_MIN_SCORE` / `DISCOVERY_STRONG_MATCHES`）、提示措辞、分臂与遥测：**一行没动**。因此实验读数跨越本版仍可比（刺激未变）。
- 库索引与 `scan-skills.ps1` 的口径、行数、sha256：未变（`7,746` 行 / `DCFF3926…7CE9`）。
- `skill_load` / `skill_ref` 的查找顺序与返回结构：仅 `copies` 字段形状随 ② 改变，其余不变。

## 测试

```
npm test          # 30 / 30 通过
```

新增/更新的断言：

- `test/verify.mjs` — `copies` 改成检查结构（`total` / `library` / `catalog` 三字段齐全且 `total` 等于两者之和）。只查 `typeof` 的话，少任何一个字段都测不出来。
- `test/collisions.mjs` — 两处分支各自断言 `.library`，而不是只断言 `.total`。
- `test/stale-and-duplicates.mjs` — 新增两条：中文查询（`C盘清理…`）如实报无关键词、且返回 0 条命中。

三套独立验收（mock registry 端到端驱动 `buildSkillRouterTools`）：`accept-③.mjs` 20/20、`accept-④.mjs` 23/23、`accept-exception.mjs` 15/15。

---

<a id="english"></a>
## English

**Search correctness: no more silent Chinese false-positives, the catalog joins the search domain, single-word ranking, index integrity alarms.**

**This is a search-correctness release, not a change to the intervention.** The injection thresholds, wording, `INJECT_TIERS` and arm assignment are untouched — a treatment arm sees a byte-identical hint to v1.15.5.

> **★ Read this first: search quality improves — that does not change usage.**
>
> **Before this release** there was a clean control: **of 18 historical "search-reachable" opportunity units, 0 were loaded** (a historical reading, not a prediction about the fix). After it, `skill_search` returns the right candidates (every example below carries a reading) — but there is **no reason to expect the model to start searching because of this**.
>
> The reason: **the bottleneck we have observed is not search quality.** **Four different forms of observation**, drawn from the same body of transcripts, point to one condition — **a skill is used when the user's request subject IS the skill's object**, not when the skill is available, visible, or among the candidates: catalog-visible 0/12, pointer injection 0/45, full body already in hand 0 uses in 10 opportunities, 208-entry catalog 0 skill-family calls.
>
> What those four forms of observation show is that search quality is not **the limiting factor observed so far**. They do **not** show that search quality can never become the limiting factor, and they do **not** show that usage is 0 by proof or forever. This release did not test what happens once search is fixed — that needs a fresh observation window, which is the subject of the next section.
>
> So this release is defined as **bug fixes**: fixing "the declaration said it does X, the implementation did not" and "it was wrong in a way you could not see". No conversion-rate expectation — but equally, "the rate cannot change" is not treated as a verified conclusion either.

The version moves v1.15.5 → **v1.16.0** (not a patch bump) because ② and ③ change the search results themselves — a wider domain and one more ranking key. Observable behaviour change means a minor bump under semver.

## Four fixes, ordered by what a user notices

### ① Chinese queries no longer report a false success

**Symptom**: a query like `C盘清理 系统盘治理 磁盘空间` returned **7,643 rows** (99.3% of the library), ranked `c-review` first.

**Mechanism**: the tokenizer replaces every non-Latin character with a space:

```js
.replace(/[^a-z0-9+#._-]+/g, ' ')     // every Han character becomes a space
```

`C盘清理…` therefore leaves behind only the ASCII `C` of `C盘`, which lands in the "the whole query is stop words" fallback:

```js
const meaningful = tokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t))
return meaningful.length > 0 ? meaningful : tokens     // ← falls back to the unfiltered tokens
```

That fallback exists for queries like `the a of`, where saying something beats saying nothing. A Chinese query reached it with `tokens = ["c"]` — and **the letter c appears in 7,643 of 7,700 rows**.

**Why this is worse than finding nothing**: at zero hits a model rewords. Faced with a screen of plausible results it has no way to know that not one keyword matched. That is a **false success** — the error is hidden by the shape of the answer.

**Fix**: the fallback fires only when at least one token is of length ≥ 2.

| Query | Before | After |
|---|---|---|
| `C盘清理 系统盘治理 磁盘空间` | total=**7643**, top1=`c-review` | **no searchable keyword** |
| `C盘清理 系统盘治理` | total=**7643** | **no searchable keyword** |
| `做视频` | no searchable keyword | no searchable keyword (unchanged) |
| `the a of` | total=1598 | total=1598 (**byte-identical**) |

Single-letter queries (`a` / `c`) now also report "no searchable keyword" instead of matching the entire library.

### ② `skill_search` now searches the session catalog, not only the library

**Symptom**: the tool declared

> `Search every skill available to this agent: the session skill catalog plus the staged library`

while the implementation read `.skill-src/skill-index.tsv` only. `parseIndex` holds the file's single `rows.push`; nothing merged the session catalog in.

**Consequence** (measured in a real session): searching `hindsight` returned 0 rows while `hindsight-coding-agent` **was in that session's catalog the whole time** — supplied by the user-level `user-agents` root, absent from the library index. `cordis` is the same shape: 0 rows in the library, the answer in the catalog.

**Fix**: `skill_search` merges the session catalog via `ctx.get('skills').list({ cwd, scope, signal })`.

**Why that interface specifically**: the catalog is a **three-layer union** — runtime registrations (other plugins register during apply), each provider's `list()`, and the shipped bundled set. Walking directories reaches only the middle layer. Measured: `dsh-univer-office` registers eight `univer*` skills through `ctx.skills.registerProvider()`; they exist neither in the working tree nor in the app bundle, so a disk-walking implementation misses them entirely — which is exactly what the first draft of this fix did.

| Query | Before | After |
|---|---|---|
| `hindsight` | total=2, **target absent** | total=**3**, `hindsight-coding-agent` **at position 2** |
| `cordis` | total=**0** | total=**1** (`dsh-plugin-failures`) |
| `univer` | total=44, top3 all `universal-*` | total=**52**, first eight are `univer` / `univer-doc` / `univer-base`… |

**No ranking privilege for catalog rows.** `hindsight` landing at position 2 is the ranking algorithm's own result — with a privilege, that position could no longer serve as evidence that ranking handles cross-domain candidates.

**Catalog rows have no repo / relpath.** The registry's `toSummary()` returns `{ name, path?, description, whenToUse?, invocation, source, provider, resourceBase? }`. Those two fields are load-bearing in three places (scoring, `libraryRelative`, locating the file), so catalog rows carry `origin: 'catalog'` and are located by their own absolute path — otherwise `resolveRow` would build `rootDir//SKILL.md`, fail to stat it, and label **every healthy catalog skill** `STALE: SKILL.md is missing`.

**Copy counts became structured**: `copies` is now `{ total, library, catalog }` instead of a number. A name can come from both domains (`next-dev-loop` measured: one library copy, one `project-dsh` copy) and the correct action differs — several library copies need `repo` to choose, a cross-domain pair **cannot** be chosen by `repo` (a catalog skill belongs to no repository). One number would send the model looking for a parameter that does not exist.

**Failure degrades, never errors**: no `ctx.get`, no `skills.list`, or a throwing registry all fall back to the previous library-only behaviour.

### ③ Single-word queries rank by how the name matched

**Symptom**: `includes` is substring matching, so a one-word query drags back every row whose description merely contains the word. `univer` matched 44 rows with only 3 name hits; `test` matched 829.

**Fix**: hits are split by whether a keyword landed in the **name**. **This is not a filter** — `total` still reports every hit, the new `nameMatched` reports the first tier, and the difference is the description-only count.

`univer` after the fix:

```
total: 52      ← not one row lost (41 spelling coincidences such as universal-* / universe remain counted)
nameMatched: 11
shown: 11
```

Within the tier, ordering is by match form: **exact > segment boundary > bare prefix > substring**.

- `univer` → `univer` (exact)
- `univer` → `univer-sheet` (`univer` is a whole segment)
- `univer` → `universal-checkout` (only the start of `universal`, cut mid-word ← the source of the 44-row noise)
- `test` → `latest` (substring only)

**It applies to single-token queries only**, and that boundary was measured: applying it to **all** queries broke three regressions immediately — `debug failing test` lost `api-analyzer`, `kubernetes helm` lost two of three, `semgrep security scan` reordered. Multi-word queries are ranked correctly by `matchCount` (how many keywords landed); for a single-token query it is always 1 and carries no information at all.

#### Why not switch to word-boundary matching

The intuitive fix for substring noise is to require word boundaries. It was implemented, measured against 27 real queries, and rejected:

| Query | Current top3 | With word boundaries |
|---|---|---|
| `debug failing test` | `test-blindspots`, **`systematic-debugging`**, `api-analyzer` | `diagnose`, `api-analyzer`, `go-troubleshooting` ← correct answer pushed out |
| `univer` | 44 rows | **0 rows** |

The fatal detail: **`debugging` is a substring of `systematic-debugging`**, and skill names are overwhelmingly hyphen compounds. Word boundaries cut the names themselves. Recorded because the idea is intuitive enough to be proposed again.

#### A reading worth noticing: `nameMatched: 0` does not mean nothing matched

`cordis` returns `total=1, nameMatched=0, shown=1` after this release. **That is not a bug** — it is what two of the designs above produce together, and it deserves its own note so nobody reading the field thinks the tiering miscounted:

```
dsh-plugin-failures    origin=catalog  source=project-dsh  matchCount=1
  score=64   why=cordis: +64 (description+whenToUse)
```

- **The hit is genuine**: it comes from `cordis.patch.yml` in that skill's `whenToUse` (weight +40, against +24 for description).
- **`nameMatched=0` is also genuine**: the skill's **name** does not contain `cordis`, so it is not in the first tier.
- **It is still visible**, because an empty first tier releases the second.

⇒ `total > 0` and `nameMatched = 0` can hold at the same time, meaning "it matched, but only in the description or trigger phrasing — not in the name". It is also direct evidence that `whenToUse` does take part in scoring.

#### One exception: when the name signal is untrustworthy

If **every** first-tier hit is a bare prefix (the name does not contain the word at all — the hits are spelling coincidences) while a second tier exists, the "name hits first" premise has failed. The second tier is then **appended** rather than withheld, and the note says the matches are spelling coincidences.

Scanning 55 queries for that condition finds **exactly one**, and only on a degenerate path: with the catalog unreachable (minimal host, or a failed registry collection) searching `univer`, where the first tier is three `universal-*` rows and 41 rows sit behind them. With a working catalog the first tier holds `univer` and `univer-*`, the premise holds, and the exception does not fire.

### ④ Index integrity checks

The index (`skill-index.tsv`) is the retrieval layer's contract, and it was once **silently** replaced by a re-run with a different scope (1,302 rows → 8,690), noticed four days later. A file that describes itself is not the same as a file that is checked.

**Fix**: two layers, **two independent criteria, both warnings rather than blocks**:

- **① hash mismatch** ⇒ the index was modified outside the generator;
- **② row count drift above 10%** ⇒ a size change must be explained.

| Location | What it does | How it triggers |
|---|---|---|
| Retrieval layer | Self-checks when the index cache reloads; only on a real alarm adds `indexAlarm` to the `skill_search` return value and prepends the notice to `note` | Any `skill_search` (zero cost on the normal path) |
| `index-integrity.mjs` | Byte-level exact hash comparison plus generator-invariant diagnostics, exit code 0/1 | `node .skill-src/index-integrity.mjs` |

The retrieval layer cannot compute an exact hash — `ctx.fs` exposes only `resolve` / `stat` / `listDir` / `readText`, with no byte access. The exact check therefore lives in a standalone script.

**A generator defect fixed alongside it**: `scan-skills.ps1` used to write its four artefacts sequentially, so a failure mid-way left "body replaced, identity files not" — precisely the inconsistency the check exists to detect. It now writes temp files, validates, then renames as a group; on failure it abandons all four and leaves the old files untouched.

> That validator caught my own mistake on its first run: I wrote the row-count invariant wrong (8,691 against the correct 7,747), and the script refused to commit, cleaned up its temp files, and left the old index untouched. Validation is not a formality; it is an interceptor.

## Regression: 79 queries, old and new side by side

The pre-change `host.js` and the current version were driven through the same mock environment, over 24 historical real queries (taken from actual transcripts), 50 real single-word queries, and 5 Chinese/degenerate queries.

| Result | Count |
|---|---|
| **First three rows identical** | **58 / 79** |
| Changed | 21 / 79 |
| — ① false success → honest error | **2** |
| — ② `total` change (catalog merged) | **6** |
| — ③ top-three reorder (name tiering) | **13** |
| — ④ other | **0** |

Every change, individually:

**① False success → honest error (2)**

| Query | Old | New |
|---|---|---|
| `C盘清理 系统盘治理 磁盘空间` | total=7643 | no searchable keyword |
| `C盘清理 系统盘治理` | total=7643 | no searchable keyword |

**② `total` change / catalog merged (6)**

| Query | Old total | New total | Change |
|---|---|---|---|
| `univer` | 44 | 52 | +8 (the catalog's `univer*`) |
| `hindsight` | 2 | 3 | +1 (the target itself) |
| `cordis` | 0 | 1 | +1 (from "not found" to found) |
| `data` | 449 | 450 | +1 |
| `version` | 289 | 290 | +1 |
| `config` | 612 | 613 | +1 |

**③ Top-three reorder / name tiering (13)**

All 13 were **reviewed individually and judged improvements; no regression was found** — that is a review conclusion, not a machine-determined fact. The criterion is "the stronger name-match form moved ahead", and every case is listed below so it can be checked independently.

| Query | Old top3 | New top3 |
|---|---|---|
| `refactor` | `refactor`, `go-refactoring`, `sepia-refactor` | `refactor`, `sepia-refactor`, `workflow-refactor` |
| `python` | (substring coincidences first) | (segment matches first) |
| `sql` | (same) | (same) |
| `terraform` | (same) | (same) |
| `video` | `video`, `video`, `videodb` | `video`, `video`, `demo-video` |
| `branch` | `create-branch`, `workspace-branch`, `mirrord-db-branching` | `create-branch`, `workspace-branch`, `finishing-a-development-branch` |
| `debug` | `debugview`, `doca-debug`, `debug-error` | `doca-debug`, `debug-error`, `web-debug-search` |
| `bug` | `debugview`, `find-bugs`, `doca-debug` | **`bug-analysis`**, `debugview`, `find-bugs` |
| `error` | `debug-error`, `venice-errors`, `Error Resolver` | `debug-error`, `Error Resolver`, `error-handling-ux` |
| `exception` | 3 substring coincidences | 1 segment match |
| `log` | `blog`, `shiplog`, `blog-geo` | `implementing-cloud-trail-log-analysis`, `implementing-log-forwarding-with-fluentd`, `performing-log-source-onboarding-in-siem` |
| `metric` | `asc-metrics`, `metric-creation`, `torch-geometric` | `metric-creation`, `metric-calculator`, `north-star-metric` |
| `alert` | `competitor-alerts`, `vss-manage-alerts`, `gke-alert-configuration` | `gke-alert-configuration`, `cloud-run-alert-configuration`, `agent-platform-alert-configuration` |

`log` and `bug` show it best: the old ranking put `blog` / `shiplog` (containing `log`, semantically unrelated) first and pushed `bug-analysis` down.

**Multi-word queries, one by one** (these are the stated floor; their first three rows must be identical):

| Query | First three |
|---|---|
| `debug failing test` | `test-blindspots`, `systematic-debugging`, `api-analyzer` ✓ |
| `kubernetes helm` | `securing-helm-chart-deployments`, `mirrord-kafka`, `mirrord-temporal` ✓ |
| `semgrep security scan` | `implementing-devsecops-security-scanning`, `semgrep`, `clawsec-scanner` ✓ |
| `test driven development` | `test-driven-development` ×3 ✓ |
| `systematic debugging failing test root cause` | `systematic-debugging` ✓ |
| `remotion video` | `video`, `remotion`, `video-polish` ✓ |
| `git worktree` | `git-worktrees`, `using-git-worktrees` ✓ |
| `verification before completion evidence` | `verification-before-completion` ✓ |
| `poka-yoke mistake-proof` | `poka-yoke` ✓ |
| `next-dev-loop` | `next-dev-loop` ✓ |

The other single-word floor also holds: `debugging` → `systematic-debugging` remains first ✓.

## Two upgrade notes

1. **A running plugin instance does not contain the new code.** Plugin source is loaded at session start, so **this release takes effect after restarting DSH** (the README's "Index and integrity" section says the same).
2. **Index integrity alarms are likewise visible only after a restart.** If you edit the index by hand, the current session will not know until the next reload.

## What did not change

- The injection thresholds (`INJECT_TIERS` / `DISCOVERY_MIN_SCORE` / `DISCOVERY_STRONG_MATCHES`), the hint wording, arm assignment and telemetry: **untouched**. Experiment readings therefore remain comparable across this release (the intervention is unchanged).
- The library index and `scan-skills.ps1` scope, row count and sha256: unchanged (`7,746` rows / `DCFF3926…7CE9`).
- `skill_load` / `skill_ref` lookup order and return shape: only the `copies` field shape changed with ②.

## Tests

```
npm test          # 30 / 30 pass
```

Added or updated assertions:

- `test/verify.mjs` — `copies` now asserts the structure (`total` / `library` / `catalog` all present and `total` equal to their sum). A `typeof` check alone would pass with any one field missing.
- `test/collisions.mjs` — both branches assert `.library` rather than only `.total`.
- `test/stale-and-duplicates.mjs` — two new assertions: a Chinese query (`C盘清理…`) reports no keyword and returns zero hits.

Three independent acceptance runs (mock registry driving `buildSkillRouterTools` end to end): `accept-③.mjs` 20/20, `accept-④.mjs` 23/23, `accept-exception.mjs` 15/15.
