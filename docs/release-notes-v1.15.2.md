# v1.15.2 — 读数补上 n、yes/no 与不确定性区间

[English](#english) | 中文

实验设计已经冻结。这一版**只改报告层**——不给读数加统计模型，只加你指出的三样东西：每组的 `n`、命中/未命中计数、以及一个简单的不确定性区间。

现在数据还是 0 条，所以这是**零成本**的：等到读数那天才发现缺它，就得多花一轮。

## 为什么不能只看 Δ

`8/25` 与 `20/25` 都算得出一个差值，但证据强度差一个量级。所以每组都印：

```
treatment（有提示）：  n=25  搜了 20 / 没搜 5 → 80.0%  95% 区间 [60.9%, 91.1%]
control（无提示）：    n=25  搜了  4 / 没搜 21 → 16.0%  95% 区间 [6.4%, 34.7%]
Δ（差值）：                    +64.0 个百分点
区间是否重叠：                 不重叠 → 差异方向可信（仍不是效应量估计）
```

## 区间用 Wilson，不用朴素正态近似

`p ± 1.96·sqrt(p(1-p)/n)` 在**这个实验真正会遇到的取值上会坏掉**：

| 情形 | 朴素正态 | Wilson |
|---|---|---|
| 25 个会话，0 次搜索 | `[0, 0]` ← 把"没观测到"说成"不可能发生" | `[0%, 13.3%]` |
| 25 个会话，1 次搜索 | 下界为负 | `[0.7%, 19.5%]` |

control 组很可能就是 0–5 次搜索这个区间，所以这不是学究式挑刺。Wilson 多点两行实现，没有理由用会撒谎的那个。

**这不是统计模型**——它只是把"n 这么小时这个比例有多不确定"变成一个数字。用户要的是简单区间，不是把项目变成统计练习。

## 指标②的分母：我第一版错了

我最初把加载率算在**全部首观测**上，那读起来像"搜了却不用"，但里面混着"根本没搜"。

现在**两个分母都给**，因为它们回答不同的问题：

```
treatment：n=20（搜过的）  加载 16 / 没加载 4 → 80.0%      ← 搜了会不会用
全漏斗（分母＝全部首观测）：treatment 64.0%，control 16.0%   ← 一个机会最终真的加载的比例
```

所以合成数据里 treatment 是"搜了 20 个、真的加载 16 个"（条件率 80%），而不是"25 个里 16 个"（64%）。这两个数都对，但回答的问题不同，**只给一个就会误导**。

## 一条边界情况

control 组可能 `4/4 = 100%` 加载——区间 `[51%, 100%]` 如实说明 n=4 时这个 100% 几乎不含信息。这正是要区间的原因。

另外"无人搜索"时条件率分母为 0：报 `n=0` 与 `n/a`，**不报 0%**。

## 测试

新增 12 条：

- Wilson 的六个边界（0/25 上界 13.3% 而非 0、1/25 下界不为负、25/25 封顶、n=0 返回 null 而非 NaN、区间包含点估计、n 越大越窄）；
- `misses` 是显式字段；
- **条件加载率分母＝搜过的（2）而不是全部（3）**、搜了没用算未加载、全漏斗分母＝全部、两个分母不同所以两个数都报；
- 无人搜索时 `n=0` 且 `rate === null`。

## 冻结清单未动

`skill index = 1025` · discovery algorithm · tokenizer · common-token threshold · dedupe · HIGH threshold · **hint wording** · session-level arm · `firstEligible` 定义——这一版一行都没碰，只改了 `tools/discovery-report.mjs` 的输出与 README。

## English

The experiment design is frozen. This release changes **only the reporting layer** — no statistical model, just the three things asked for: each arm's `n`, the hit/miss counts, and a simple uncertainty interval. The data is still empty, which makes this free: discovering the gap on readout day would cost another round.

**Why Δ alone is not enough.** `8/25` and `20/25` both produce a difference, but the evidence differs by an order of magnitude. Each arm now prints its n, its searched/not-searched counts, its rate, and a 95% interval, plus whether the two intervals overlap (a disjoint pair makes the direction credible, which is still not an effect size).

**Wilson rather than the naive normal approximation.** `p ± 1.96·sqrt(p(1-p)/n)` breaks on values this experiment will actually hit: 25 sessions with zero searches gives `[0, 0]`, reporting "not observed" as "cannot happen", and one search in 25 gives a negative lower bound. The control arm is likely to live in exactly that range, so this is not pedantry; Wilson costs two extra lines.

**Metric ② had the wrong denominator in my first version.** I computed the load rate over all first observations, which reads like "searched but refused to use" while actually mixing in "never searched". Both denominators are now reported because they answer different questions: the **conditional** rate (denominator = sessions that searched) answers "having searched, will it use something", and the **full funnel** answers what share of opportunities end in a load. In the synthetic check, treatment is "searched in 20, actually loaded in 16" (80% conditional) rather than "16 of 25" (64%) — both true, different questions, and reporting one alone misleads.

**One boundary case worth naming**: control may load `4/4 = 100%`, and the interval `[51%, 100%]` says plainly that at n=4 that 100% carries almost no information — which is the point of having it. When nobody searched at all, the conditional rate reports `n=0` and `n/a`, never `0%`.

**12 new assertions**: six Wilson boundaries (the 13.3% upper bound at 0/25, a non-negative lower bound at 1/25, the cap at 25/25, `null` rather than `NaN` at n=0, containment of the point estimate, and narrowing with n), `misses` as an explicit field, the conditional denominator being the searched subset, "searched but did not load" counting as a miss there, the full-funnel denominator, both rates being reported because they differ, and the empty-searched-set case.

**The freeze list is untouched** — skill index at 1025, the discovery algorithm, tokenizer, common-token threshold, dedupe, HIGH threshold, hint wording, session-level arm, and the `firstEligible` definition. Only the readout's output and the README changed.
