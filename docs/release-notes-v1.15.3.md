# v1.15.3 — 打印原始 2×2 表；p 值改为显式开关

[English](#english) | 中文

实验实现**不动**。这一版只做你要求的最后一件事：把最终分析要用的原始 2×2 表打印出来，并修掉我上一版一句会被误当成检验结果的措辞。

## 修掉的措辞

上一版读数写的是"不重叠 → 差异方向可信"。**这读起来像显著性结论**，而区间重叠与否只是描述。现在：

```
区间是否重叠：  不重叠（**描述性**：不是显著性检验，正式判断请用下面的 2×2 表做 Fisher exact）
```

## 默认打印原始 2×2 表

```
③ 原始 2×2 表（最终分析用这些整数，不要在插件里做检验）
                      search    no search   total
  treatment           20        5           25
  control             4         21          25
  （一行可复制： a=20 b=5 c=4 d=21）
                      load      no load     total
  treatment|search    16        4           20
  control|search      4         0           4
```

两张表：**搜索率**（分母＝全部首观测）与**条件加载率**（分母＝搜过的）。你要的漏斗连续性就落在这两张表的四个整数上。

现在数据是 0 条，所以这是零成本的：等读数那天再手工拼表，反而容易拼错。

## p 值：实现放在工具里，但**不**出现在默认输出

```sh
node tools/discovery-report.mjs --since <T0>            # 只给表，不给 p
node tools/discovery-report.mjs --since <T0> --fisher   # 显式要求才算
```

**为什么默认不算。** 检验属于分析阶段；产品不该把某个检验绑进自己的输出，读者也不该在每次读数里看到一个容易被当成结论的 p 值。你说"不需要为此改插件"，我按这个理解处理：**功能在手，默认不出现。**

Fisher exact（两尾，零依赖）用教科书例子校验过：

| 表 | p | 期望 |
|---|---|---|
| `3/3 vs 0/3` | 0.1000 | 教科书 0.1 ✅ |
| `5/25 vs 5/25` | 1.0000 | 无差异 ✅ |
| `8/25 vs 5/25` | 0.5202 | "看不出来" ✅ |
| `20/25 vs 4/25` | 1.15e-05 | 明显 ✅ |
| `25/25 vs 0/25` | 1.58e-14 | 极端 ✅ |
| `0/25 vs 0/25` | 1.0000 | 无证据反对同一分布 ✅ |

**`0/25 vs 0/25` 这一格是我实现里的一处修正。** 第一版把"两臂都 0 次命中"当成退化输入返回 `null`——那是不对的：观测到 0 vs 0 时答案是 **p=1**（没有证据反对同一分布），而且"两臂都没搜"恰恰是可能出现的真实读数。

输出带一句提醒：**一次读数里的多重比较不做校正；p 只回答"这批数据像不像同一分布"，不是效应量。**

## 测试

新增 12 条，其中三条是**跨层一致性**：默认读数含表但不含 p、`--fisher` 才出现 p、以及**表里的四个整数与 2×2 行一致**（后者我第一版按"搜了 2 次"误写成 `a=2`——**计数是会话数，不是调用次数**，这正是主指标的定义）。

写测试时又踩了一个捕获坑：`capture()` 只 mock 了 `process.stdout`，而**文本模式走 `io.log`**，于是文本断言全部拿到空字符串——又一个"功能没出现"的假失败。现在两条路都捕获。

## 冻结清单仍未动

`skill index = 1025` · discovery algorithm · tokenizer · common-token threshold · dedupe · HIGH threshold · hint wording · session-level arm · `firstEligible` 定义——只改了 `tools/discovery-report.mjs` 与 README。

## English

The experiment implementation is **untouched**. This release does the last thing asked — print the raw 2x2 table the final analysis needs — and fixes a phrase of mine that could be mistaken for a test result.

**The phrase**: the previous readout said "not overlapping → the direction is credible", which reads like a significance claim while interval overlap is only a description. It now says explicitly that this is descriptive, that it is not a significance test, and that the formal judgement should use the table below.

**The table is printed by default**: two of them — the search rate (denominator = all first observations) and the conditional load rate (denominator = sessions that searched) — with the four raw integers and a copy-paste line. The funnel continuity you said you would watch lives in exactly those integers. With zero data recorded so far this is free; assembling the table by hand on readout day is where mistakes happen.

**The p-value exists but does not appear by default.** `--fisher` asks for it explicitly. Testing belongs to the analysis stage: a product should not bind one particular test into its output, and no reader should meet a p-value on every readout that gets mistaken for a verdict. That is how I read "you do not need to change the plugin for this" — the capability is on hand, absent from the default output.

The two-tailed Fisher implementation is zero-dependency and validated against the textbook case: `3/3 vs 0/3` gives 0.1000, `5/25 vs 5/25` gives 1.0000, `8/25 vs 5/25` gives 0.5202, `20/25 vs 4/25` gives 1.15e-05, `25/25 vs 0/25` gives 1.58e-14, and `0/25 vs 0/25` gives 1.0000.

**That last cell is a correction inside my own implementation.** The first version treated "zero hits in both arms" as a degenerate input and returned `null`. That is wrong: observing 0 versus 0 gives **p=1**, since there is no evidence against a shared distribution — and "neither arm searched" is a real readout this experiment may well produce. The output also warns that **no correction for multiple comparisons is applied within one readout**, and that a p-value answers only whether the data look like one distribution, never how large the effect is.

**12 new assertions**, three of them cross-layer: the default readout carries the table but no p-value, `--fisher` is what makes a p-value appear, and **the four integers in the test's table match the 2x2 row** — which I first wrote as `a=2` from "searched twice", forgetting that **the count is sessions, not calls**, which is the whole definition of the primary metric. Writing the tests I also tripped over a capture bug: `capture()` mocked only `process.stdout` while **text mode goes through `io.log`**, so every text assertion received an empty string — another false failure of the "feature missing" kind. Both paths are captured now.

**The freeze list is unchanged**: skill index at 1025, discovery algorithm, tokenizer, common-token threshold, dedupe, HIGH threshold, hint wording, session-level arm, `firstEligible` definition. Only the readout and the README changed.

> **Later note (v1.15.4):** one item on that list has since been unfrozen — `hint wording`. The hint was rendering the matched field *names* (`semgrep (name, description, path)`) instead of their contents, which left it with zero information for the model. v1.15.4 renders the real description instead, which means **T0 restarts**: readouts taken before it had a different stimulus in the treatment arm. Everything else on this list is still frozen.
