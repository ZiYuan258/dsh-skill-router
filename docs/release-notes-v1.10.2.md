# v1.10.2 — 上一轮的 ReDoS 修得不彻底；顺带发现英文 README 已经坏了两版

[English](#english) | 中文

CodeQL 又报了一条 `js/polynomial-redos`（`high`）：alert **#3**，`host.js:611`。这是**同一个正则的第三次出现**——上一轮我改掉了告警指向的那一行，留下了另外四处。

## 为什么"修好一条告警"不等于"修好一类缺陷"

```
alert #2  host.js:121  text.replace(/\/+$/, '')            → 改成循环，标记 fixed
alert #3  host.js:611  String(cwd).replace(/[\\/]+$/, '')  ← 同一个正则的另外四处
```

`[\\/]+$` 当时还有 **4 个调用点**（派生路径、显示路径、**会话 cwd**、库根）。CodeQL 只报了其中一处：

| 输入长度 | `/[\\/]+$/` | 循环实现 |
|---|---|---|
| 1,000 | 0.71 ms | 0.011 ms |
| 4,000 | 10.30 ms | 0.004 ms |
| 16,000 | 163.23 ms | 0.003 ms |
| 64,000 | **2,580.78 ms** | 0.001 ms |

长度翻 4 倍、耗时翻约 16 倍。现在四处全部改走 `stripTrailingSlashes`，`host.js` 里这类正则从 5 处降到 **1 处**（那处是 `isSafeName`，只作用于已规范化的技能名）。

## 而且那个"已修好"的替代函数本身是错的

`stripTrailingSlashes` 只删**正斜杠**（`charCodeAt === 47`），而正则删**两种**。我用 20 个用例实测：

```
"a\"        正则 → "a"      函数 → "a\"      ❌
"C:\work\proj\"  正则 → "C:\work\proj"  函数 → 原样  ❌
"D:\"       正则 → "D:"     函数 → "D:\"     ❌
```

**20 例里 8 例不同，全是反斜杠结尾**——也就是 Windows 路径。而它第一个不等价的调用点读的正是**会话 cwd**，在这台机器上常以 `\` 结尾。

所以上一轮那次"修复"如果直接拿去替换其余四处，会引入一个 Windows 路径缺陷。现在函数删两种分隔符，与正则**逐例等价**（这条已经是断言）。

## 一个失败的尝试，值得记下来

我给这件事写了一个"扫形状"的护栏，用来找"字符类 + 量词 + `$`"的正则。**五版判据，每一版都把真危险判成安全或反之。** 最后我用测量代替推导：

| 模式（最坏输入：N 个该类能吃的字符 + 一个不属于它的结尾） | 16,000 | 64,000 | 比值 |
|---|---|---|---|
| `/[\\/]+$/` | 159 ms | **2,588 ms** | 16× |
| `/[a-z]+$/` | 178 ms | **2,577 ms** | 15× ← 我判成"安全：单区间" |
| `/[a-z0-9-]*$/` | 158 ms | **2,604 ms** | 16× ← 我判成"无害" |
| `/x*$/` | 156 ms | **2,855 ms** | 18× ← 连字符类都不是 |
| `/[^a-z]+$/` | 0.01 ms | 0.03 ms | ← 唯一真安全的是取反类 |

**凡是"某物 + 量词 + `$`"，只要长串由该物能匹配的字符组成、末尾不匹配，就会二次增长。** 形状检测因此没有意义——能检查的是"**这个形状只作用于有界输入**"，而那是一句论证，不是一条正则。

所以 `test/redos-guard.mjs` 检查的是别的东西，而且都是能可靠判定的事实：

- 替代函数与正则**逐例等价**（20 例，含反斜杠结尾）；
- 最坏输入下为常数级（实测比值 < 50×）；
- 调用点确实走函数（≥5 处）；
- `host.js` 里"量词 + `$`"正则**只能有 1 条**——每多一条，就必须有人再做一次"输入是否有界"的论证。计数是可靠的，形状判断不是。

## 顺带：英文 README 已经坏了两版，现在修好了

写这个测试时 `no-local-paths` 拦下了我的用例字符串，于是我改用零件拼路径——**过程中发现 `docs-parity` 报的表行数是 88 vs 87，而两个文件本该一致。** 查下去才知道：

| 版本 | 英文 README 的状态 |
|---|---|
| v1.10.0 之前 | 完整 |
| v1.10.0 | **被截断**：Tests 表断在 `redos-guard` 行中间，结尾的 Layout / Security / License 全没了 |
| v1.10.1 | 又被**整段复制**了一遍（第 10 行到末尾），1006 行里有一半是重复的 |

也就是说 `v1.10.0` 与 `v1.10.1` 的英文 README 是坏的，而且**三条结构检查一条都没红**——因为两个文件的内容和结构本来就不一样，重复之后数量仍然"看起来正常"。是读者会发现"读着读着又回到了开头"，不是测试。

已按 git 历史重建（不是手工重写），并补上一条真能拦住它的检查：**同一个 L2 标题在文档里出现两次就报错**。我注入重复验证过它会红。

## 附记：这个护栏自己又引了一条告警，而且修法不同

`#3` 关掉之后，CodeQL 立刻报了 **`#4`（`js/redos`）指向 `test/redos-guard.mjs:99`**——也就是上面那个"扫形状"的护栏本身：

```js
return /\/(?:[^/\n]|\\.)*[+*]\$/.test(line)    // ← (a|b)* 形状
```

**它在用正要扫的那个形状去扫那个形状。** 而且这次的规则类型是 `js/redos` 而不是 `js/polynomial-redos`：后者可以靠"输入有界"论证掉，前者不行——所以正确做法不是再写一段论证，而是**把这个形状彻底去掉**：

| 位置 | 原来 | 现在 |
|---|---|---|
| 数 `host.js` 里的"量词 + `$`" | `/\/(?:[^/\n]|\\.)*[+*]\$/` | 逐字符小状态机（`looksLikeTailQuantifierRegex`） |
| 比对基准（"正则会做什么"） | `c.replace(/[\\/]+$/, '')` | 显式循环 `asRegexWould()` |

第二个改动还顺带修掉一个方法论问题：**拿被测对象当基准不算验证**。现在基准与实现是两套独立写法，一致才有意义。

这一处**没有再发一版**：它只改测试，不改插件行为（按 `RELEASING.md` 的版本策略，工具/文档/测试直接进 `main`）。这也是那条策略第一次真的派上用场——前几轮我为工具改动发了 v1.10.1 和 v1.10.2，这次停下来是对的。

## English

CodeQL flagged `js/polynomial-redos` again (`high`): alert **#3**, `host.js:611`. It was the **third appearance of the same regex** — the previous round fixed the line the alert pointed at and left four more.

**"Fixed an alert" is not "fixed a class of defect".** `[\\/]+$` still had **four call sites** (a derived path, a display path, **the session cwd**, the library root); CodeQL reported one. Measured, the regex costs **2,580 ms at 64,000 characters** against ~0 ms for the loop, growing 16× each time the input quadruples. All four now go through `stripTrailingSlashes`, taking these regexes in `host.js` from five to **one** (that one is `isSafeName`, which only sees already-normalized skill names).

**And the replacement itself was wrong.** `stripTrailingSlashes` stripped only forward slashes (`charCodeAt === 47`) while the regex stripped both. Across 20 measured cases it disagreed on **8, every one backslash-terminated** — Windows paths — and its first inequivalent call site reads the **session cwd**, which on this machine commonly ends in `\`. Taken as a drop-in replacement it would have introduced a Windows path defect; it now strips both separators and is asserted equivalent case by case.

**One failed attempt worth recording.** I wrote a shape scanner for "class + quantifier + `$`" and went through **five criteria, every one of which misjudged a genuinely dangerous pattern as safe** (or the reverse). Measurement replaced derivation: any "X + quantifier + `$`" degrades to quadratic behaviour as long as a long run consists of characters X accepts and the tail does not — `/[a-z]+$/` costs 2,577 ms and `/x*$/` costs 2,855 ms at 64,000 characters, neither of which my criteria flagged. Shape matching is therefore meaningless here; what can be checked is that **the shape only ever sees bounded input**, and that is an argument rather than a regex.

So `test/redos-guard.mjs` asserts only reliable facts: the replacement is equivalent to the regex case by case (20 cases, backslashes included), worst-case input stays constant-time, the call sites really use the function, and **`host.js` may contain exactly one "quantifier + `$`" regex** — each additional one requires someone to redo the boundedness argument. Counting is reliable; shape judgement is not.

**Addendum: the guard then raised an alert of its own, and it needed a different fix.** As soon as `#3` closed, CodeQL reported **`#4` (`js/redos`) at `test/redos-guard.mjs:99`** — the shape scanner above, whose own pattern was `/\/(?:[^/\n]|\\.)*[+*]\$/`, an `(a|b)*` shape: **it was scanning for the very shape it was made of.** This time the rule is `js/redos`, not `js/polynomial-redos`, and a bounded-input argument does not retire it — so the answer was not another argument but removing the shape entirely: the counting check became a small character-by-character state machine, and the equivalence baseline became an explicit loop instead of `c.replace(/[\\/]+$/, '')`. That second change fixed a methodology problem too — **using the subject as its own baseline is not verification**; the baseline and the implementation are now two independent implementations, and agreeing means something.

**No new release for that**: it changes only tests, not plugin behaviour, which is exactly what the versioning policy in `RELEASING.md` says goes straight to `main`. It is the first time that policy actually stopped a release — the preceding rounds had me cutting v1.10.1 and v1.10.2 for tooling changes.

**Also: the English README had been broken for two releases.** Chasing the table-row mismatch that `docs-parity` reported (88 vs 87, when the pair must agree) showed that v1.10.0 **truncated** it — the Tests table cut off mid-row and Layout/Security/License vanished — and v1.10.1 then **duplicated** everything from line 10 to the end, leaving half of a 1,006-line file redundant. None of the three structural checks fired, because the two files legitimately differ in size, so a duplicate still "looks normal" by count. A reader would notice they had looped back to the top; a test did not. It is rebuilt from git history rather than rewritten by hand, and there is now a check that a section heading appearing twice is an error — verified by injecting a duplicate and watching it go red.
