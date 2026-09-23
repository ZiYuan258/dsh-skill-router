# dsh-skill-router

[English](README.md) | 中文

一个 DeepSeek Harness **Host 插件**，新增 `skill_search` 与 `skill_load` 两个工具，让 agent 能从技能库里自己挑技能，而不是为"目录里挂着但用不上"的技能每轮都付 token。

- **零依赖。** 没有任何 `import`，没有 `node_modules`，不需要安装任何东西。
- **零目录成本。** 两个工具只是几百字符的 schema；技能库本身从不注入上下文。
- **由 agent 选。** 判断规则写在工具描述里，由模型决定用哪些技能——不把选择推给用户。

## 为什么需要它

DSH 会把会话技能目录注入到**每一次**模型请求里（`dsh-tool-skill` 在 `agent/pre-step` 里发一条 `source.kind='skill-catalog'` 的 user message）。于是每个常驻技能都是持续性的 token 成本，逼着人把常驻集合压小。

但目录同时是模型**唯一**的技能入口：内置的 `skill` 工具通过 `ctx.skills.list()` 解析名字，只认文件系统 provider 扫描到的根目录。这些根目录之外的东西对模型完全不存在——一个放着 1000+ 技能的分级库，等于没有。

本插件补上这一环：想自动触发的技能继续常驻；其余的留在库里，**用到的那一刻才付成本**。

## 安装

需要 DSH（`dsh >= 0.1.5-rc.1`）与一个 profile。`dsh plugin` 会在 profile 目录里转发给 `pnpm`，并同步 bundle 列表。

```sh
# 从 git 安装（推荐）
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# 或用下载的 release tarball / 本地检出
dsh plugin --profile <profile> add /absolute/path/to/dsh-skill-router
```

重启一次 DSH，然后在工具列表里确认 `skill_search` 与 `skill_load` 都在。

卸载：

```sh
dsh plugin --profile <profile> remove dsh-skill-router
```

> **不发布到 registry。** DSH 只要能把包装上就组合得出插件，git URL 或本地路径已经足够——
> 所以本包 `private: true`，`dsh plugin add github:…` 就是标准装法。离线或隔离环境的安装包
> 挂在 [GitHub releases](https://github.com/ZiYuan258/dsh-skill-router/releases) 上。

### 插件对你的环境有什么要求

需要一个**技能索引**：`<工作区>/.skill-src/skill-index.tsv`。它是制表符分隔的表，表头为
`repo`、`relpath`、`name`、`description`、`files`、`KB`，每行指向 `<根目录>/<repo>/<relpath>/SKILL.md`。

插件从**会话工作目录往上最多找 8 层**，因此没有任何盘符或路径是写死的。索引不存在时，两个工具会
直接说明这一点，并告诉你它们找过哪里。

索引由谁生成都行——只要能产出这几列。下面是一个参考实现（PowerShell，适用于把多个上游仓库
检出一到同一个目录的情况）：

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

**请用真正的 CSV 写入器**（`Export-Csv`、`csv.writer` 之类）。手工用制表符拼列会在描述包含制表符、
引号或换行时直接坏掉——上面这份参考实现当初就踩过这个坑。

## 工具

### `skill_search`

找技能。关键词会转小写，并在**技能名、描述、上游仓库**三处做 **AND** 匹配。

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string，必填 | 例如 `"kubernetes helm"`、`"remotion video"` |
| `limit` | integer | 1–40，默认 12 |
| `repo` | string | 按上游目录名过滤，不分大小写 |
| `names_only` | boolean | 只返回名字与仓库，不带描述 |

返回 `total`、`shown`、`more`，以及每条命中的 `name`、`repo`、`description`（展示时截断到 220 字符）、
`copies`、`files`、`path`、`libraryRelative`。

### `skill_load`

把一个或多个技能的全文加载进上下文。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | 单个技能名；也可以直接给 `SKILL.md` 的完整路径 |
| `names` | string | 一次加载多个，用逗号或换行分隔 |
| `repo` | string | 上游仓库过滤，作用于本次调用的每个名字（见下） |

返回 `requested`、`loaded`、`failed`，以及 `skills[]`：每项含 `name`、`source`、`repo`、`copies`、
`path`、`resourceDir`、`content`、`referenceFiles`、`error`。工具卡片会把每个技能渲染成一个
`<skill_content>` 块并附上它的 base directory，所以 `scripts/`、`references/`、`assets/` 这类相对路径能正确解析。

查找顺序：**先库，后常驻目录**（`ctx.skills`）。`source` 字段标明最终用的是哪边。

上限：单次 8 个名字、单个技能正文 120,000 字符、附带文件清单最多 8 项。

## 设计取舍

**为什么用 `name` + `names`，而不是数组。** 早先的版本把 `name` 声明成 `oneOf: [string, array]`。
schema 上好看，实际会坏：数组参数**可能以字符串形式到达工具**，于是 `["gh-cli"]` 变成字面量
`'["gh-cli"]'`，命中 string 分支，被当成一个不存在的技能名。现在的实现三种形态都接受——真数组、
JSON 编码的数组、逗号/换行分隔的字符串——因为这种健壮性不该依赖传输层怎么序列化参数。

**为什么什么都不 import。** 早先的版本从 `@deepseek-ai/dsh-tools` 引入 `defineTool`。Node 解析裸标识符时
**先从发起包自己的 `node_modules` 找**，于是包里一个残留的开发用替身遮蔽了真包，作者 DSL
（`output.schema: { type: 'json' }`）未经编译就进了注册表，结果**整棵插件树加载失败**：

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

所以本插件**不带 `node_modules`、不带任何依赖**，并自己在本地把工具定义构建成标准 JSON Schema——
无论运行时是否编译 schema，它们都合法。注册表的编译器在一处比它的断言更严：object schema 必须显式声明
`additionalProperties`（只写 `{ type: 'object' }` 会被拒）。`test/boot-safety.mjs` 把这些规则全部固化成断言。

**重名。** 由多个上游仓库拼起来的库经常同名多份——某个热门仓库会把每个技能同时放在
`skills/`、`plugins/<name>/skills/` **和** `antigravity/skills/` 下。`skill_search` 用 `copies`
把这种歧义暴露出来，`skill_load` 接受 `repo` 消歧；不给提示时按确定性规则选择（路径最浅者胜）。
`repo` 过滤没命中时，会列出**真正拥有它的仓库**，而不是悄悄回退到别的仓库。

## 测试

```sh
npm test
```

六个零依赖脚本。当机器上能找到一个真实的技能库时就直接对真库跑，否则**在系统临时目录生成一个
一次性夹具库**，所以裸克隆也能测：

| 脚本 | 覆盖内容 |
|---|---|
| `boot-safety.mjs` | 无遮蔽用的 `node_modules`、`dependencies` 里无 DSH 宿主包、schema 落在注册表强制子集内 |
| `schema-forms.mjs` | 哪种 `output.schema` 写法能通过注册，以及作者 DSL 会失败 |
| `shape.mjs` | 参数形状与工具描述里的路由措辞 |
| `verify.mjs` | 搜索 + 加载的端到端行为 |
| `collisions.mjs` | 重名解析与 `repo` 提示 |
| `batch.mjs` | 多技能请求的每一种传输形态 |

用 `SKILL_LIBRARY_ROOT=/path/to/workspace` 可以指定要测的技能库。

## 目录结构

```
host.js              插件本体：apply()、buildSkillRouterTools()、definePortableTool()
cordis.patch.yml     被组合进去的那一行（id: skill-router, name: dsh-skill-router）
test/                六个测试，外加一个仅开发用的 @deepseek-ai/dsh-tools 替身
docs/                各版本的发布说明
.github/workflows/   CI：Node 20 / 22 / 24 上跑 npm test
```

## 许可

MIT
