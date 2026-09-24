# v1.5.5 — 索引带 BOM 时，表头会变成一条"技能"

[English](#english) | 中文

这个 bug 是在回答"我的库有多大"时撞出来的：数出来的行数比磁盘上的 `SKILL.md` 多一条。

## 症状

索引文件由 PowerShell 的 `Export-Csv` 写出，**带 UTF-8 BOM**。BOM 会粘在首个字段上，于是首行实际是：

```
\uFEFF"repo"    "relpath"    "name"    ...
```

`parseIndex` 判断表头的条件是 `repo === 'repo' && name === 'name'`。`'\uFEFF"repo"' !== 'repo'`——**比较永远失败**，表头就被当作一条真实记录推进了结果：

| 字段 | 值 |
|---|---|
| `name` | `name` |
| `repo` | `\uFEFF"repo"` |
| `relpath` | `relpath` |
| `libraryRelative` | `\uFEFF"repo/relpath"` |
| `path` | `…\.skill-src/\uFEFF"repo/relpath/SKILL.md` |

`skill_search` 会正常返回它——搜 `name` 时它出现在 24 条结果里，分数还不低；`skill_load` 再报"找不到"。也就是说：**检索结果里混着一条不存在的技能，而且它比真技能更容易被 `name` 这类查询命中**（因为它的名字就叫 `name`）。

## 根因不是"少写了一个 if"

不是。BOM 前缀的 UTF-8 是 Windows 上多个写入器的默认行为，**包括 PowerShell 的 `Export-Csv`**——也正是本仓库 README 推荐读者用来生成索引的方式。所以这是常规路径，不是边角情况。而原代码的注释还写着"按形状识别表头，不按精确字符串"，实际却依赖了精确字符串。

## 修法

读取每个单元格时先剥掉 BOM、再去掉首尾引号、最后 trim；表头判定用清理后的值。这样带引号、不带引号、带 BOM、两者兼有、LF 换行——**五种写法都是同一个表头**。

`test/index-header.mjs` 逐一验证这五种写法：表头不会变成技能行、名字与 repo 里不会残留 BOM、名为 `name` 的技能不存在、**并且真实的技能行仍然能搜到**（否则这个"修复"只是把整个索清空了）。

## 附带：这个库的实测规模

| 项 | 值 |
|---|---|
| 磁盘上 `SKILL.md` | **1025** |
| 索引数据行 | **1025**（修复前是 1026——多出来的就是那条幽灵行） |
| 唯一技能名 | **1021**（4 个重名占 8 行） |
| 索引覆盖 repo | 23（顶层目录 26 个，另 3 个是 `audit`、`skill-router`、`vercel-next-skills` 三个工具/文档目录，本身不含 `SKILL.md`） |
| 库总体积 | 138.5 MB |
| 全部技能正文合计 | 12.70 MB，平均 13 KB/个 |
| `skill-index.tsv` | 462 KB |

对照成本：常驻 32 个技能的目录文本实测 **5,159 字符 ≈ 1,433 token/轮**，插件三个工具 schema **≈ 1,001 token/轮**。把 1025 个全部常驻按本次实测均值线性外推约 **46k token/轮**（外推用于量级判断，不是实测值）。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

## 测试

十六个（原十五个 + `index-header.mjs`），CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

This bug surfaced while answering "how big is my library": the row count came out one higher than the number of `SKILL.md` files on disk.

### Symptom

The index is written by PowerShell's `Export-Csv`, which emits a UTF-8 BOM. The mark glues itself to the first field, so the first line is really:

```
\uFEFF"repo"    "relpath"    "name"    ...
```

`parseIndex` recognized the header with `repo === 'repo' && name === 'name'`. Since `'\uFEFF"repo"' !== 'repo'`, **the comparison never matched** and the header was pushed into the results as a real record:

| Field | Value |
|---|---|
| `name` | `name` |
| `repo` | `\uFEFF"repo"` |
| `relpath` | `relpath` |
| `libraryRelative` | `\uFEFF"repo/relpath"` |
| `path` | `…\.skill-src/\uFEFF"repo/relpath/SKILL.md` |

`skill_search` returned it happily — a search for `name` put it among 24 hits, scoring well — and `skill_load` then reported it missing. In other words: **a nonexistent skill was mixed into the results, and it was easier to hit than real skills for queries like `name`**, because its name is literally `name`.

### The cause is not "a missing if"

BOM-prefixed UTF-8 is the default output of several Windows writers, **including PowerShell's `Export-Csv`** — which is exactly how this repository's own README tells readers to generate the index. So this is the normal path, not a corner case. The original code even carried a comment saying the header is recognized "by shape, not by an exact string", while in fact depending on an exact string.

### The fix

Each cell is stripped of a BOM, then of wrapping quotes, then trimmed; the header test uses those cleaned values. Quoted, unquoted, BOM-prefixed, both at once, and LF-only — **all five shapes are the same header now**.

`test/index-header.mjs` verifies each of the five: the header never becomes a skill row, no BOM survives into a name or repo, a skill named `name` does not exist, and **the real rows are still searchable** — otherwise the "fix" would just be an emptied index.

### Along the way: this library, measured

| Item | Value |
|---|---|
| `SKILL.md` on disk | **1025** |
| Index data rows | **1025** (1026 before the fix — the extra one was the phantom row) |
| Unique skill names | **1021** (4 duplicated names account for 8 rows) |
| Repos covered by the index | 23 (26 top-level directories; the other 3 are `audit`, `skill-router` and `vercel-next-skills`, tooling and docs directories that contain no `SKILL.md`) |
| Library size on disk | 138.5 MB |
| Total skill prose | 12.70 MB, averaging 13 KB each |
| `skill-index.tsv` | 462 KB |

For comparison: the resident catalog of 32 skills measures **5,159 characters ≈ 1,433 tokens/turn**, and the plugin's three tool schemas are **≈ 1,001 tokens/turn**. Making all 1025 resident extrapolates to roughly **46k tokens/turn** on this library's average (an extrapolation for scale, not a measurement).

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`

### Tests

Sixteen (fifteen plus `index-header.mjs`), green on Linux and Windows × Node 20 / 22 / 24.
