# dsh-skill-router

[English](README.en.md) | 中文

给 DeepSeek Harness 的 **Host 插件**。新增 `skill_search` / `skill_load` / `skill_ref` 三个工具，让 agent 在需要时自己去技能库里检索并加载技能。

> **你只有十几个技能？这个插件不适合你。**
> 一次工作通常只用到几个技能，所以**技能少的时候，让它们常驻目录反而更省**——目录本来就是 DSH 的原生机制。
> 这个插件解决的是另一个问题：**技能多到装不进目录**。

## 你需要它吗

判断标准只有两条：**库有多大**，以及**每个任务用几个**。

| 你的情况 | 怎么办 |
|---|---|
| 技能 < **~30** 个 | **不需要本插件。** 全部常驻，目录成本可控，原生 `skill` 工具直接能用 |
| 技能几十到上百，且每个任务只用几个 | **本插件的典型场景。** 常驻留高频的十来个，其余进库按需检索 |
| 有多个上游仓库、上千个技能 | **最需要。** 全量常驻不可行（1000 条 ≈ 每轮 15 万字符），但你又不想丢掉其中任何一个 |
| 只想"技能自动触发"、库其实很小 | **不需要。** 那是 pre-step 路由插件的领域，不是这个 |

一句话：**它是为"库大、但每次只用几个"设计的**。如果你把常用技能都常驻了，它的收益就是负的——因为你多付了工具 schema 的钱。

## 它解决什么技术问题

DSH 把会话技能目录注入到**每一次**模型请求里（`dsh-tool-skill` 在 `agent/pre-step` 发出一条件 `source.kind='skill-catalog'` 的 user message）。所以：

- **常驻数量的成本是持续性的**：每多一个常驻技能，**每一轮**都要付它的名字与描述。1000 个技能 ≈ 每轮 **150k** 字符，与任务是否相关无关。
- **但目录同时是模型唯一的技能入口**：内置 `skill` 工具通过 `ctx.skills.list()` 解析名字，只认文件系统 provider 扫到的根目录。这些根之外的东西对模型**完全不存在**——一个放着 1000+ 技能的库，等于没有。

于是只有两个选项：**要么全塞进目录（每轮都贵），要么全放在库外（模型够不着）**。本插件提供第三个：库留在库外，agent 需要时**自己检索、自己加载**。代价从"每轮固定"变成"用到才付"。

## 成本（实测，不是估计）

工具驱动不是免费的，它有两笔开销：

| 开销 | 实测 | 性质 |
|---|---|---|
| 常驻工具 schema | **3,603 B ≈ 1,001 token/轮** | **固定**，不随库增长——这是与目录注入最本质的区别 |
| 一次检索往返 | 1 次 tool call + 约 **1,533 B ≈ 426 token**（`limit=12`） | 按需，与"目录已注入、模型直接挑"相比多出的一步 |

对照：常驻 28 个技能实测 **1,541 token/轮**。把 1,541 + 3,603 B 换成"只留六个常驻 + 工具"，净额才划算——所以**库小的时候别用**（见上一节）。

省往返的两个动作：**`limit` 调小**（或 `names_only: true`，返回体积约降 60%）、**名字已知时直接 `skill_load`**，跳过检索。

## 工作原理

### 数据流

```
用户消息
   │
   ├─ 常驻技能（DSH 原生）        ← 每轮注入目录，自动触发
   │
   └─ 库内技能（本插件）
        模型判断需要专门知识
          │
          ├─ skill_search  ← 关键词检索索引（不读技能正文）
          │     返回：名字 / 仓库 / copies / 绝对路径
          │
          ├─ skill_load    ← 只加载选中的那几个，包成 <skill_content> + base directory
          │
          └─ skill_ref     ← 只见真需要某个 references/ 或 scripts/ 文件时，单独读它
```

关键点：**检索与加载分离**。`skill_search` 只查索引，从不读技能正文；`skill_load` 只读你点名的。所以"搜 12 条"的代价是元数据，"加载 2 个"的代价才是正文。

### 索引是契约，不是缓存

插件读 `<工作区>/.skill-src/skill-index.tsv`——制表符分隔，一行一个技能：

| 列 | 必填 | 说明 |
|---|---|---|
| `repo` | 是 | 上游目录名，用于消歧与过滤 |
| `relpath` | 是 | 相对仓库根的子路径，与 `repo` 拼出 `SKILL.md` 的位置 |
| `name` | 是 | 技能名，`skill_load` 的键 |
| `description` | 是 | 检索语料，也是给模型看的说明 |
| `files` | 否 | 该技能目录的文件数 |
| `KB` | 否 | 体积 |
| `whenToUse` | 否 | 触发措辞，以高于描述的权重参与检索（实测参考库 1025 个 `SKILL.md` 里 **0 个**带它——"没有"是常态） |

设计取舍：**为什么是 TSV 而不是 YAML/JSON**——索引由机器生成，TSV 最不容易出结构歧义；而 YAML 恰好会被这次会话咬过（frontmatter 里的块标量 `>-`/`|-` 会带着标记漏进描述）。解析器手写（插件零导入，不能用 `node:path`/CSV 库），按 CSV 规则处理引号，表头**按形状识别**而不认字面量，所以加列不会破坏旧文件：**6 列索引照常工作，缺列读作空字符串**。

索引位置从会话工作目录**往上最多找 8 层**，没有任何盘符写死。找不到时工具会说明并列出找过哪里。

### 检索：加权 AND + 诚实降级

评分是逐关键词累加，权重顺序体现信息密度：

| 命中字段 | 权重 | 理由 |
|---|---|---|
| `name` | **+100** | 技能名是最强信号 |
| `whenToUse` | **+40** | 它按定义就是触发措辞 |
| `description` | **+24** | 描述性散文 |
| `path`（`repo/relpath`） | **+6** | 弱信号，但能救"按仓库找"的查询 |
| 名字完全相等 | **+400** | 精确命中断层领先 |

排序键依次是：是否全词命中 → 命中词数 → 总分 → 名字命中数 → 名字长度 → 字典序（确定性，同样输入永远同样顺序）。

默认是**严格 AND**（每个关键词都要命中）。当 AND 结果为空且关键词多于一个时，才尝试**部分匹配**：候选必须命中"除一个以外的全部"关键词，否则宁可回答"没找到"，并置 `fallback: "weak"`。命中的部分匹配带 `matchCount`、结果里 `strict: 0`，模型看到的头部也写成"0 exact match(es); N partial match(es)"——**近似命中永远不会被伪装成真命中**；单个关键词不降级（没有可降级的余地）。

> 这条阈值是实测逼出来的：在 1026 行的参考库上，`test setup config helper` 原本返回 **1026 条**，绝大多数只共享一个常见词；收紧后是 **7 条**。同一实验里 `make a movie` 会因 `make`/`a` 命中全库，所以 `a`、`the`、`make`、`use` 这类无区分度的词在分词阶段就被丢弃（`tokenize` 里的 `STOP_WORDS`）。

`explain: true` 时可看到分数构成，诊断"为什么搜不到"：

```
- beta-gadgets  [beta-skills]
    why: widgets: -; beta: +130 (name+description+path)
```

### 重名：确定性优先于猜测

由多个上游拼起来的库经常同名多份——有的仓库把每个技能同时放在 `skills/`、`plugins/<name>/skills/` 和 `antigravity/skills/` 下（参考库里 `test-driven-development` 有 **5 份**）。

处理方式：`skill_search` 报 `copies` 把歧义**暴露出来**；`skill_load` 接受 `repo` 消歧；不给提示时按确定性规则选（**路径最浅者胜**，即 `skills/<name>` 优先于 `plugins/<x>/skills/<name>`）；`repo` 过滤没命中时**列出真正拥有它的仓库**，而不是悄悄回退到别的仓库。

### 查找顺序与上限

`skill_load` 先库（`.skill-src`）后常驻目录（`ctx.skills`），`source` 字段标明最终用了哪边。上限：单次 8 个名字、单个技能正文 120,000 字符、附带文件清单 8 项。正文超限会被截断**并明确上报**（`truncated: true` + 原始长度 + 可读全文的路径），不静默丢弃。

### 路径包含性

`skill_ref` 在**任何 I/O 之前**对归一化路径做包含性校验，`../` 到不了文件系统。已知局限：该校验是**词法**的、不感知符号链接（参考库符号链接数为 0，故目前是理论风险）。`resolvePath` 已导出并**直接单测**——只通过工具间接验证的安全规则，等于一条可能悄悄失效的规则。

## 安装

需要 DSH 与一个 profile。`dsh.engines.dsh` 声明 `>=0.1.5-rc.1`——那是**已验证可用的版本**，不是"需要这么新"：本插件只用到 `ctx.tools.register` 与 `ctx.fs.*` 这一小组 API，无事件钩子、无 import；更早的版本我没有验证过，**不想过度声明兼容性**。`ctx.get` / `ctx.effect` / `ctx.skills` 全部是**可选**的，缺失时降级而不是崩溃（由 `test/minimal-host.mjs` 钉住）。

```sh
# 从 git 安装（推荐）
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# 或用下载的 release tarball / 本地检出
dsh plugin --profile <profile> add /absolute/path/to/dsh-skill-router
```

重启一次 DSH，然后在工具列表里确认三个工具都在。卸载：

```sh
dsh plugin --profile <profile> remove dsh-skill-router
```

> **不发布到 registry。** DSH 只要能把包装上就组合得出插件，git URL 或本地路径已经足够——
> 所以本包 `private: true`。离线或隔离环境的安装包挂在 [GitHub releases](https://github.com/ZiYuan258/dsh-skill-router/releases) 上。

### ⚠️ 名字先认准：`dsh-skill-router` 有多个同名仓库

这个名字下至少并存 8 个仓库，**装错就是装了另一个插件**：

| | 本仓库 | 另一类同名插件（例：`MJorgin/dsh-skill-router`） |
|---|---|---|
| 安装命令 | `github:ZiYuan258/dsh-skill-router` | `github:akqwpeter-prog/dsh-skill-router`（该仓库已改名，命令是过期的） |
| 机制 | **工具驱动**：模型自己调 `skill_search` / `skill_load` / `skill_ref` | **pre-step 自动路由**：模型回答前读用户消息，命中即注入全文 |
| 解决的问题 | 库里的技能**对模型不可见** | 模型**该用技能时没用**（注意力漏掉） |
| 依赖 | 零依赖、零导入 | 各自不同，有的需要 LLM 判定或 embedding |

两者**不冲突、可叠加**——它们在不同层次工作。装之前核对 owner 是 `ZiYuan258`。

> 若你的工具报告本仓库"不可访问"，先分清是哪种：GitHub 对**未认证 API** 限流 60 次/小时，
> 超限返回 `403 API rate limit exceeded`，而网页与 raw 文件仍然正常——`dsh plugin add` 走的正是后者。

## 使用方法

### 一、把库放到哪里

插件从**会话工作目录往上最多 8 层**找 `.skill-src/skill-index.tsv`。所以惯例是把库放在**工作区根**：

```
<你的工作区>\                      ← 你在这里开 DSH 会话
├─ .skill-src\                      ← 库的根，插件找的就是这个名字
│  ├─ skill-index.tsv               ← 索引（下一步生成）
│  ├─ remotion-skills\              ← 一个上游仓库 = 一个顶层目录
│  │  └─ skills\remotion-create\
│  │     └─ SKILL.md
│  └─ trailofbits-skills\
│     └─ plugins\semgrep\skills\semgrep\
│        └─ SKILL.md
├─ .dsh\skills\                     ← DSH 常驻区（插件不碰这里）
└─ AGENTS.md
```

两条硬性约定：

1. **目录名必须是 `.skill-src`。** 前导点让它对 DSH 的 skill 扫描器不可见——这正是"库不占目录成本"的机制。若命名为 `skills/` 或放进 `.dsh/skills/`，DSH 会把里面的技能**全部注入每轮上下文**，插件就白装了。
2. **它必须在会话 cwd 的同级或上级。** 若你的 DSH 会话开在 `<你的工作区>\projects\foo`，插件会向上找到 `<你的工作区>\.skill-src`——这没问题。
3. **内部结构随意。** 插件只要求"某层的目录名等于 `repo` 列、其下路径等于 `relpath` 列、最后是 `SKILL.md`"。上游仓库那种 `skills/`、`plugins/<name>/skills/`、`antigravity/skills/` 混排的布局原样放着即可。

### 二、库在别处（别的盘 / 别的目录）

插件按 `cwd/.skill-src` 找，所以库不在工作区里时，在工作区放一个**目录链接**指过去即可。已实测可用（Windows junction / POSIX symlink，`node tools/check-link-support.mjs` 可自行复验）：

```powershell
# Windows：junction 不需要管理员权限
New-Item -ItemType Junction -Path "D:\work\.skill-src" -Target "E:\skills-archive"
```

```sh
# Linux / macOS
ln -s /mnt/skills-archive "/home/me/work/.skill-src"
```

链接下 `skill_search` 与 `skill_load` 都正常。**已知局限**：返回的 `path` 是链接下的路径，不是真实路径——排查问题时若需要真身，用 `dir` 或 `ls -l` 看链接目标。

> 不要用 DSH 的 `customSkillDirs` 来指向这个库。那个配置的作用是**把技能注册成常驻**，会立刻让全部技能进入每轮目录——与这个插件的目标正好相反。

### 三、生成索引

索引由谁生成都行——只要能产出那几列。参考实现（PowerShell，适用于把多个上游仓库检出一到同一目录）：

```powershell
$rows = Get-ChildItem $root -Directory | ForEach-Object {
  $repo = $_
  Get-ChildItem $repo.FullName -Recurse -File -Filter 'SKILL.md' | ForEach-Object {
    $text = Get-Content $_.FullName -Raw
    $name = ''; $desc = ''
    if ($text -match '(?s)^\uFEFF?---\s*\r?\n(.*?)\r?\n---') {
      $fm = $Matches[1]
      if ($fm -match '(?m)^name:\s*(.+?)\s*$') { $name = $Matches[1].Trim() }
      if ($fm -match '(?ms)^description:\s*(.+?)(?=\r?\n[a-zA-Z_-]+:\s|\z)') {
        $desc = ($Matches[1] -replace '\s+', ' ').Trim() -replace '^[>|][+-]?\s*', ''
      }
    }
    [pscustomobject]@{
      repo = $repo.Name
      relpath = $_.Directory.FullName.Substring($repo.FullName.Length).TrimStart('\')
      name = $name; description = $desc
      files = 1; KB = [math]::Round($_.Length / 1KB)
    }
  }
}
$rows | Export-Csv -Path (Join-Path $root 'skill-index.tsv') -Delimiter "`t" -NoTypeInformation -Encoding UTF8
```

**请用真正的 CSV 写入器**（`Export-Csv`、`csv.writer` 之类）。手工用制表符拼列会在描述含制表符、引号或换行时坏掉——上面这份参考实现当初就踩过这个坑。库内容变了要重跑（见第六节的"库变了怎么办"）。

### 四、验证装好了

安装命令见上一章；**重启 DSH 后**（插件行只在生成新宿主进程时组合）按顺序验证：

1. **工具在不在**：问 agent"你有哪些 skill 相关的工具"，应当看到 `skill_search` / `skill_load` / `skill_ref`。
2. **索引找没找到**：让 agent 用 `skill_search` 查一个你库里确实有的名字。返回里带 `library` 字段，那是它实际使用的库根——**核对这个路径**，这是"找错目录"最快的诊断点。
3. **加载通不通**：让 agent `skill_load` 其中一个。返回的 `source` 应为 `library`（若是 `resident`，说明命中的是常驻区而不是库）。
4. **库没被塞进目录**：确认新会话的技能目录**没有**因为这次安装而变长。库在 `.skill-src` 下就不该出现。

`library` 与 `error` 两个字段能区分三种失败：**索引不存在**（报错里会列出找过的路径）、
**索引在但不是这个库**（`library` 路径不对）、**索引格式坏了**（`error` 非空）。
`explain: true` 还能看出检索为什么没命中。

手边核对索引本身：

```powershell
# 表头（应为 6 或 7 列）与行数
Get-Content "D:\work\.skill-src\skill-index.tsv" -TotalCount 1
(Import-Csv "D:\work\.skill-src\skill-index.tsv" -Delimiter "`t").Count
```

### 五、日常怎么用

**你不需要记住任何技能名。** 这是这个插件的设计目的——选择由 agent 做：

- 直接描述任务即可（"帮我用 Remotion 做个视频"）。工具描述里写明了"非平凡任务开始前先搜一次"，agent 会自己检索。
- 想知道库里有什么，可以问："你的技能库里有没有跟 X 相关的？" agent 会 `skill_search` 把结果给你看。
- 想让它**自动触发**某个技能（不必每次提醒），那才需要把它装进常驻区：
  ```powershell
  & "D:\work\.skill-src\install-more.ps1" -Name remotion-create
  ```
  代价是它开始进入每轮目录——也就是你付钱买"自动触发"。

### 六、库变了怎么办

| 你做了什么 | 要做什么 |
|---|---|
| 新增/删除/重命名了技能目录 | **重跑索引生成**，否则检索的是过期元数据 |
| 改了某个 `SKILL.md` 的描述 | 同上（描述是检索语料） |
| 只改了技能正文 | 不用重跑——`skill_load` 每次都实时读文件 |
| 移动了整个库 | 更新链接目标；旧索引里的 `repo`/`relpath` 会失效 |

**库内容会变，所以把生成命令存成一个脚本**（例如 `.skill-src\scan-skills.ps1`），改完库就跑一次。
过期条目的表现是"搜得到但加载失败"——路径还在索引里、文件已经不在；这时 `skill_load` 会明确报出
读不到哪个路径，而不是静默失败。

### 七、备份与隔离

- **库要备份**：它是你的能力集合，而且多半来自多个上游仓库。若那些仓库还能重新 clone，最少要备份
  `skill-index.tsv` 与你的准入记录。
- **可疑技能先隔离**：把目录移出库根（例如 `.skill-src\_quarantine\`），重跑索引后它就自动消失，
  不需要卸载插件。审计命令 `node tools/audit-library-risk.mjs <库根>` 会分别统计"代码块内"与
  "叙述里"的危险模式——只有前者是模型可能照着执行的。

## 工具参考

### `skill_search`

关键词转小写，在 `name` / `whenToUse` / `description` / `path` 上做加权匹配。

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string，必填 | 例如 `"kubernetes helm"`、`"remotion video"` |
| `limit` | integer | 1–40，默认 12 |
| `repo` | string | 按上游目录名过滤，不分大小写 |
| `names_only` | boolean | 只返回名字与仓库，不带描述（体积约降 60%） |
| `explain` | boolean | 额外返回每条命中的分数构成，用于诊断 |

返回 `total`、`strict`、`shown`、`more`、`fallback`，以及每条命中的 `name`、`repo`、`description`、`copies`、`matchCount`、`stale`、`whenToUse`、`files`、`path`、`libraryRelative`；开了 `explain` 时另有 `score` 与 `why`。

`stale: true` 表示索引里有这一条但磁盘上已没有 `SKILL.md`——库改过而索引没重跑。这种条目**不会**让搜索失败（早期版本会直接抛 `ENOENT`，一条过期记录拖垮整个检索），而是被标出来，模型也能看到。

### `skill_load`

把一个或多个技能的全文加载进上下文。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | 单个技能名；也可直接给 `SKILL.md` 绝对路径 |
| `names` | string | 一次加载多个，逗号或换行分隔 |
| `repo` | string | 上游仓库过滤，作用于本次调用的每个名字 |

返回 `requested`、`loaded`、`failed`，以及 `skills[]`：每项含 `name`、`source`、`repo`、`copies`、`path`、`resourceDir`、`content`、`referenceFiles`、`truncated`、`error`。工具卡片把每个技能渲染成 `<skill_content>` 块并附 base directory，所以 `scripts/`、`references/`、`assets/` 这类相对路径能正确解析。

> **为什么是 `name` + `names` 而不是数组。** 早先版本把 `name` 声明成 `oneOf: [string, array]`：schema 上好看，实际会坏——数组参数**可能以字符串形式到达工具**，`["gh-cli"]` 变成字面量 `'["gh-cli"]'`，命中 string 分支，被当成一个不存在的技能名。现在三种形态都接受（真数组 / JSON 字符串 / 逗号换行分隔），因为这种健壮性不该依赖传输层怎么序列化。

### `skill_ref`

读技能捆绑的**单个文件**，或列出它捆绑了什么。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string，必填 | `skill_search` 返回过的技能名 |
| `path` | string | 相对该技能 base directory 的路径，例如 `references/rulesets.md` |
| `list` | boolean | 列出全部捆绑文件，而不是读某一个 |
| `repo` | string | 上游仓库过滤，用于同名多份的情况 |

`skill_load` 返回的 `referenceFiles` 通常足以判断**要不要**读某个文件——这个工具让你只读那一个，而不是把整个目录塞进上下文。

## 工程约束

**为什么零导入。** 早先版本从 `@deepseek-ai/dsh-tools` 引入 `defineTool`。Node 解析裸标识符时**先从发起包自己的 `node_modules` 找**，于是包里一个残留的开发用替身遮蔽了真包，作者 DSL（`output.schema: { type: 'json' }`）未经编译就进了注册表，结果**整棵插件树加载失败**：

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

现在插件**不带 `node_modules`、不带任何依赖**，自己在本地把工具定义构造成标准 JSON Schema——无论运行时是否编译都合法。注册表编译器在一处比它的断言更严：object schema 必须显式声明 `additionalProperties`。`test/boot-safety.mjs` 把这些规则全部固化成断言，包括"`dependencies` 里出现任何 `@deepseek-ai/*` 即构建失败"。

**为什么没有 ledger/去重状态。** 插件不做自动注入，所以不存在"这个技能本会话已注入过"的状态可维护。是否重复加载由模型自己决定——这是工具驱动相对 pre-step 路由的一处结构性简化。

## 测试

```sh
npm test
```

十五个零依赖脚本。机器上能找到真实技能库时就直接对真库跑，否则**在系统临时目录生成夹具库**，所以裸克隆也能测：

| 脚本 | 覆盖内容 |
|---|---|
| `boot-safety.mjs` | 无遮蔽用的 `node_modules`、`dependencies` 里无宿主包、schema 落在注册表强制子集内 |
| `schema-forms.mjs` | 哪种 `output.schema` 写法能通过注册，以及作者 DSL 会失败 |
| `shape.mjs` | 参数形状与工具描述里的路由措辞 |
| `verify.mjs` | 搜索 + 加载的端到端行为 |
| `collisions.mjs` | 重名解析与 `repo` 提示 |
| `batch.mjs` | 多技能请求的每一种传输形态 |
| `robustness.mjs` | 部分匹配降级、`explain` 的分数构成、`whenToUse`、两种截断边界 |
| `skill-ref.mjs` | 路径包含性（含 `../` 越界尝试）、列目录、文件缺失 |
| `index-format.mjs` | 索引格式契约：6 列与 7 列都可解析、表头按形状识别、真库仍可用 |
| `minimal-host.mjs` | 只注入 `ctx.fs` 时的降级：三个工具仍可用，可选 API 缺席不崩溃 |
| `link-support.mjs` | `.skill-src` 是目录链接时搜索与加载仍然可用（Windows junction / POSIX symlink）；运行器不允许建链接时报告为跳过 |
| `stale-and-duplicates.mjs` | 索引过期（目录已删）不再使 `skill_search` 抛异常、过期条目被标 `stale`；重名候选的 repo 列表对模型可见；弱匹配不被当作命中 |
| `docs-parity.mjs` | 双语文档不漂移：README 对、SECURITY 对、发布说明中文在前 |
| `workflow-config.mjs` | CI 配置本身：`permissions` 显式且只给 `contents: read`、action 固定版本、无 tab 缩进 |
| `no-local-paths.mjs` | 代码与配置里没有本机绝对路径；文档里的示例路径有意排除在外 |

用 `SKILL_LIBRARY_ROOT=/path/to/workspace` 指定要测的技能库；`node tools/audit-library-risk.mjs` 可对任意库做风险审计。

## 目录结构

```
host.js                       插件本体：apply()、buildSkillRouterTools()、definePortableTool()
cordis.patch.yml              被组合进去的那一行（id: skill-router, name: dsh-skill-router）
SECURITY.md / SECURITY.zh.md  安全政策（英文 / 中文）
test/                         十五个测试，外加一个仅开发用的 @deepseek-ai/dsh-tools 替身
tools/audit-library-risk.mjs  技能库风险审计（政策里的统计由它推导）
docs/                         各版本的发布说明（双语，中文在前）
.github/workflows/            CI：Linux 与 Windows 上、Node 20 / 22 / 24 各跑一遍 npm test
```

## 安全

这个插件**从不执行代码、从不联网、从不写文件、从不读环境变量**——只做索引查询与文件读取。它读到的技能正文是**不可信第三方内容**，那才是信任边界。

完整政策（威胁模型、路径包含性的已知局限、供应链约束、以及"未经审阅不会加入的功能"清单）见
[`SECURITY.zh.md`](SECURITY.zh.md) ｜ [English](SECURITY.md)。漏洞请走本仓库的 GitHub 私密漏洞报告。

## 许可

MIT
