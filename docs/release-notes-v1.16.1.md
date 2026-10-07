# v1.16.1 — 报警真的会被看到：四个缺陷，其中三个只在真实宿主里才现形

[English](#english) | 中文

**这是一次修复"修好了但看不到"的补丁。** v1.16.0 报了四项修复，其中的索引完整性报警**在真实宿主里从未工作过** —— 而且不是一处错，是四处，每一处都只在真机上现形，每一处都躲过了当时全部的 30 个测试。

> **★ 先说结论：报警链路现在真实环境验证通过。**
>
> 第三次重启后按清单端到端验证（改坏索引 → 真实 `skill_search` → 看渲染文本）：
> **横幅出现**，含具体 mtime 差值、处置命令、以及"结果仍显示但未核实"的说明；同一次返回里
> **14 条命中照常返回**（报警不阻止搜索）；`Copy-Item` 还原备份后**横幅消失**。
>
> 完整七步读数见 `SKILLS-POLICY.md` §31.8。

**使用率预期不变**：v1.16.0 的定性原样有效 —— 这四处的修复**不改变**"技能被使用的条件是
「用户请求主语 = 技能对象」"这个观察，也不期待转化率。它们修的是"功能存在但不可见/不可靠"。

---

## 四个缺陷，同族：判据选在了错误的层面

### ① 报警写进了 `note`，而 `render()` 从不输出 `note`（`ea487ec`）

**症状**：改坏索引后真实 `skill_search` 返回**完全正常**，没有任何报警。

**根因**：报警文字全部写进 `result.note`，而 `render()` 只渲染
`hits` / `error` / `stale` / 重名提示 —— **从来没有 `note`**。
模型读的是这段渲染文本，不是工具返回的 JSON。

**为什么 30 个测试全绿**：所有断言都在 **JSON 层**（`result.indexAlarm`、`result.note`），
**没有一条断言渲染文本**。判据选在了错误的层面。

**修法**：报警作为独立段落输出（具体问题 + 处置命令 + "结果仍显示但未核实"），
并在 `test/verify.mjs` 补**渲染层断言**：用合成 alarm 驱动 `render()`，
断言文本含 `INDEX INTEGRITY ALARM` / 具体问题 / `scan-skills.ps1` / `unverified`，
外加**反例**（健康索引不得出现横幅）。

### ② catalog 行被"读不到"误判成"不存在"（`ea487ec`）

**症状**：三条完全健康的 bundled 技能被渲染成 `STALE: SKILL.md is missing — regenerate the index`。

**根因**：`resolveRow` 对 catalog 行做 `ctx.fs.resolve()` + `stat()`，失败就报 stale。
而 bundled 技能在 **`app.asar` 内部**，`app.asar` 是**文件**（121 MB）不是目录 ⇒ `ctx.fs` 打不开。
**但宿主进程读得到** —— 实测 `skill_load cordis-plugin-development` 成功（`source: resident`）。

**规则：「读不到」不等于「不存在」。** 把前者渲染成后者，是**对一条健康的技能撒谎**。

**修法**：catalog 行**从不据 `ctx.fs` 报 stale**；`path` 尽力解析、失败则原样用 provider 给的。
真正的"能不能加载"由 `skill_load` 回答 —— 它走 `skills.get()` 让 provider 自己读，不碰 `ctx.fs`。

### ③ 渲染器会输出 JavaScript 自己的词（`4889738`）

`hit.whenToUse` 缺失时渲染出字面的 **`when: undefined`**（`String(undefined)` 是 `'undefined'`，
而它 `!== ''` 恒真）。真实 hit 一定带该字段，**所以从未到达用户** —— 但它是同族陷阱的潜伏态。

渲染层的契约是"输出的每个字都是给模型看的"，`undefined` 不是。已修 + 两条断言。
**这条是 ① 的副产品**：确立"要在渲染层断言"之后，那个层次**第一次实战就抓到了东西**。

### ④ ★ `ctx.fs` 的 version 是**不透明串**，而代码对它做了算术（`4be80f4`）

**症状**：第二次重启后改坏索引，真实 `skill_search` **仍然不报警**。

**根因**（`dsh-fs-local/lib/index.js:146` 逐字）：

```js
return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
```

即 `"0:12345:3910032:1791297073405000000:1791139170108000000"` —— **`Number()` 得 `NaN`**，
`Number.isFinite()` 恒假 ⇒ **整条顺序判据被静默跳过**，报警永不出现。

**类型注释自己写着 "Opaque version token"。** 对一个自称不透明的串做算术，是根上的错。

**修法**：只取第 4 段 `mtimeNs`（纳秒、单调，正是"谁更新"的答案）；段数不符 ⇒
**如实报告"判据失效"**，而不是像旧代码那样安静跳过。

---

## 为什么四处的测试都过了：**mock 与真机不同形**

这一条比四个缺陷本身更值得记。`test/helpers.mjs` 当初给的是
`String(info.mtimeMs)`（纯数字串），而真机是五段复合串 —— **mock 里 `Number()` 正常，
真机里恒 `NaN`。形状差就是测试的盲区。**

所以本版**改了 mock 本身**，让它逐字复刻 `dev:ino:size:mtimeNs:ctimeNs`。
不改这一处，同类缺陷还会再溜过去。

三轮真机迭代，每一轮都"mock 全绿、真机不过"：

| 轮次 | 修复 | mock | 真机 | 真机暴露的层面错误 |
|---|---|---|---|---|
| v1.16.0 | 报警写进 `note` | ✅ | ❌ | 渲染层（模型读文本，不读 JSON） |
| 本次 `ea487ec` | 渲染进文本 | ✅ | ❌ | 数据形状（`Number(不透明串)` = NaN） |
| 本次 `4be80f4` | 解析 `mtimeNs` | ✅（真实形状）| **✅** | — |

---

## 一处护栏的例外，是论证而非放行

`/^\d+$/` 撞上两个独立的 ReDoS 护栏，两个都问得对，豁免都带**实测**：

| 正则 | 最坏输入规模 | 耗时 | 增长 |
|---|---|---|---|
| `/^\d+$/`（本次新增） | N=5,000,000 | **7.8 ms** | 规模 ×5 ⇒ 耗时 ×3.1（线性）|
| `/[\\/]+$/`（护栏防的形状）| N=16,000 | **187 ms** | 规模 ×2 ⇒ 耗时 ×4.2（二次）|

`package-contract.mjs` 的豁免原本只认 `[...]` 拼写，而 `\d` 是同义的简写字符类（单字符、无分支、
不可再分割）⇒ 已扩到 `\d \w \s` 及取反形式。
**写这个豁免时犯了该文件已记录过的同一个错**（集合写成 `'\\d'`，运行时两字符 ⇒ 豁免成死代码），
靠**求值并比对码点**抓到，不是靠看转义猜。

---

## 升级注意

1. **运行中的插件实例不含新代码。** 插件的源码在会话启动时加载，**重启 DSH 后本版才生效**。
   （本版的四个缺陷，全部由"改了代码但实例没换"这个形状掩盖过至少一轮。）
2. **索引完整性报警在重启后可见**，与上述同一原因。

## 没有动的东西

- 注入层的阈值、措辞、`INJECT_TIERS`、分臂与遥测：**一行没动**（实验读数跨版可比）。
- 搜索域与排序策略：**一行没动**（v1.16.0 的行为不变）。
- 库索引与生成脚本的口径：未变（`7,746` 行 / `DCFF3926…7CE9`）。

## 测试

```
npm test          # 30 / 30 通过
```

新增断言集中在两层，都是 v1.16.0 缺的那两层：

- **渲染层**（`test/verify.mjs`）：报警必须出现在渲染文本里、含处置命令、含"未核实"说明；
  健康索引不得出现横幅；`whenToUse` 缺失时不得渲染 `undefined` 或 `when:` 行。
- **形状层**（`test/helpers.mjs`）：mock 的 `version` 必须与真机同形
  （`dev:ino:size:mtimeNs:ctimeNs`），否则测的是一个不存在的世界。

---

<a id="english"></a>
## English

**Making the alarm actually visible: four defects, three of which only appeared in a real host.**

**This is a patch for "it was fixed but you could not see it".** v1.16.0 shipped four fixes; its index-integrity alarm **never worked in a real host** — and not through one mistake but four, each of which appeared only on a real machine and each of which passed all 30 tests of the time.

> **★ The result first: the alarm chain is now verified in a real environment.**
>
> After a third restart, end to end per the checklist (corrupt the index → call the real
> `skill_search` → read the rendered text): **the banner appears**, carrying the specific mtime
> delta, the command that fixes it, and a note that the results below are shown but unverified;
> the same response still returns **14 hits** (the alarm does not block search); restoring the
> backup makes **the banner disappear**.
>
> The full seven-step reading is in `SKILLS-POLICY.md` §31.8.

**The usage expectation is unchanged**: v1.16.0's framing still holds — these four fixes do **not** change the observation that a skill is used when the user's request subject IS the skill's object, and no conversion-rate change is expected. They fix "the feature exists but is invisible or unreliable".

## Four defects, one family: criteria chosen at the wrong layer

### ① The alarm went into `note`, and `render()` never emits `note` (`ea487ec`)

**Symptom**: with a corrupted index, the real `skill_search` returned **perfectly normally**, with no alarm.

**Cause**: the alarm text all went into `result.note`, and `render()` emits hits, errors, stale rows and the duplicate hint — never `note`. The model reads that rendered text, not the tool's JSON.

**Why all 30 tests passed**: every assertion was at the **JSON layer** (`result.indexAlarm`, `result.note`); **none asserted the rendered text**. The criterion sat at the wrong layer.

**Fix**: the alarm is now its own paragraph (the specific problem, the fixing command, "results are shown but unverified"), and `test/verify.mjs` gained the **render-layer assertions**: a synthetic alarm drives `render()` and the text must carry `INDEX INTEGRITY ALARM` / the specific problem / `scan-skills.ps1` / `unverified`, plus a **counter-case** (a healthy index must render no banner).

### ② A catalog row was called stale because we could not read it (`ea487ec`)

**Symptom**: three healthy bundled skills rendered as `STALE: SKILL.md is missing — regenerate the index`.

**Cause**: `resolveRow` resolved and stat-ed the catalog path and reported failure as staleness. Bundled skills live inside **`app.asar`**, which is a **FILE** (121 MB), not a directory, so `ctx.fs` cannot open it — **while the host process reads it fine** (measured: `skill_load cordis-plugin-development` succeeds with `source: resident`).

**The rule: "cannot read it from here" is not "it is not there".** Rendering the former as the latter is **lying about a healthy skill**.

**Fix**: catalog rows never report stale from a `ctx.fs` probe; the path is resolved best-effort and otherwise passed through as the provider gave it. Whether a skill can load is answered by `skill_load`, which asks the provider to read it and never touches `ctx.fs`.

### ③ The renderer printed JavaScript's own words (`4889738`)

A hit without `whenToUse` rendered a literal **`when: undefined`** (`String(undefined)` is `'undefined'`, and that is not `''`). Real hits always carry the field, **so it never reached a user** — but it is a latent instance of the same trap. The renderer's contract is that every character is meant for the model; `undefined` is not. Fixed, with two assertions. **This one is a by-product of ①**: once render-layer assertions existed, that layer **found something on its first outing**.

### ④ ★ `ctx.fs`'s version is an **opaque string**, and the code did arithmetic on it (`4be80f4`)

**Symptom**: after a second restart, with the index corrupted, the real `skill_search` **still showed no alarm**.

**Cause** (`dsh-fs-local/lib/index.js:146`, verbatim):

```js
return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
```

i.e. `"0:12345:3910032:1791297073405000000:1791139170108000000"` — **`Number()` yields `NaN`**, `Number.isFinite()` is false, so **the whole ordering criterion was skipped in silence** and the alarm could never fire.

**The type annotation calls it an "Opaque version token".** Doing arithmetic on a string that describes itself as opaque was wrong at the root.

**Fix**: take the fourth field (`mtimeNs`) — nanosecond, monotonic, and the actual answer to "which is newer"; an unrecognized shape **reports that the criterion is inactive** instead of going quiet the way the old code did.

## Why all four passed their tests: **the mock and the host disagreed about a shape**

This matters more than the four defects. `test/helpers.mjs` supplied `String(info.mtimeMs)` — a plain number — while the real host produces a five-field composite. **`Number()` works in the mock and is always `NaN` on a real machine. The shape difference was the blind spot.** This release therefore **changes the mock itself**, reproducing `dev:ino:size:mtimeNs:ctimeNs` faithfully. Without that, the same family of defect would slip through again.

Three rounds of real-host iteration, each "mock green, host broken":

| Round | Fix | Mock | Host | Wrong layer the host exposed |
|---|---|---|---|---|
| v1.16.0 | alarm into `note` | ✅ | ❌ | Rendering (the model reads text, not JSON) |
| this `ea487ec` | alarm into the text | ✅ | ❌ | Data shape (`Number(opaque)` = NaN) |
| this `4be80f4` | parse `mtimeNs` | ✅ (real shape) | **✅** | — |

## One guard exemption, argued rather than waved through

`/^\d+$/` tripped two independent ReDoS guards. Both were right to ask, and both exemptions carry **measurements**:

| Regex | Worst-case input | Time | Growth |
|---|---|---|---|
| `/^\d+$/` (new here) | N=5,000,000 | **7.8 ms** | x5 size ⇒ x3.1 time (linear) |
| `/[\\/]+$/` (the shape that guard exists for) | N=16,000 | **187 ms** | x2 size ⇒ x4.2 time (quadratic) |

`package-contract.mjs`'s exemption only recognized the `[...]` spelling, while `\d` is the same thing by another name (one character, no alternation, not re-divisible) — now extended to `\d \w \s` and their negations. **Writing that exemption reproduced a mistake the file already documents** (the set was written as `'\\d'`, two characters at runtime, making the exemption dead code), caught by **evaluating the set and comparing code points** rather than reading the escape and assuming.

## Upgrade notes

1. **A running plugin instance does not contain the new code.** Plugin source loads at session start; **this release takes effect after restarting DSH**. (All four defects here were masked by exactly this shape for at least one round.)
2. **Index integrity alarms are visible after a restart**, for the same reason.

## What did not change

- Injection thresholds, wording, `INJECT_TIERS`, arm assignment and telemetry: **untouched** (readings stay comparable across versions).
- Search domain and ranking policy: **untouched** (v1.16.0 behaviour is unchanged).
- Library index and generator scope: unchanged (`7,746` rows / `DCFF3926…7CE9`).

## Tests

```
npm test          # 30 / 30 pass
```

The new assertions sit in the two layers v1.16.0 was missing:

- **Render layer** (`test/verify.mjs`): the alarm must appear in the rendered text, carry the fixing command and the "unverified" note; a healthy index must render no banner; a missing `whenToUse` must render neither `undefined` nor a `when:` line.
- **Shape layer** (`test/helpers.mjs`): the mock's `version` must match the host's shape (`dev:ino:size:mtimeNs:ctimeNs`) — otherwise the tests validate a world that does not exist.
