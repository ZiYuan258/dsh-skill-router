# v1.15.5 — 回合结束即结算，会话的最后一个回合不再丢失

[English](#english) | 中文

**这是一次读数覆盖的修复，不是刺激的改变。** 冻结清单九项一个都没动，treatment 臂看到的提示与 v1.15.4 逐字相同——**与 v1.15.4 的唯一行为差异，是 `turn-calls` 记录的写入时刻**。刺激没变、判据没变、读数口径没变；旧记录与新记录都是有效读数，只是不能放进同一个分母（见下面"T0 从什么时候重起"）。

## 修的是什么

发现层遥测把每个回合的工具调用数写成 `turn-calls` 记录，但**只在下一个回合的 `step 1` 结算**。一个会话走完最后一个回合就结束时，没有任何后续回合来触发这次结算，于是：

> 每个会话的**最后一个回合**永远没有 `turn-calls` 记录。

而实验的主指标——"该会话的首个 HIGH 机会里，模型有没有去搜"——观测的恰恰常常就是最后一个回合（真机上最常见的会话形状是"一次问答"）。实测后果：T0 之后 19 个合格会话，主指标里只剩 **1 个可配对观测**。

## 为什么会漏掉（这一段比修复本身更值得记）

旧代码的注释写着：这个 harness 声明了 `turn/start` 与 `turn/end`，但**没有暴露任何可供插件挂钩的回合停止 waterfall**，并注明"已验证 `agent/turn-stopping` 在 0.1.7-rc.2 里不存在"。

那句话是真的，结论是错的。它找的是 **waterfall**，于是"没有 waterfall"被当成了"回合结束不可观测"。实际上 `turn/end` 是**会话事件**：

```js
// dsh-agent-loop：在 finally 里 append，所以取消与报错的回合也被闭合
this.session.append('turn/end', { turn, reason: turnEnds })

// dsh-session-projection-cache：就是这么消费它的，与 tool/call 同一条通道
ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') { this.flushSoft(session, 'turn/end'); return } … })
```

而本插件**早就在监听这条通道**——用来数 `tool/call`。一个被找错形状的钩子，让一个已经握在手里的事件变成了"不可观测"，并使每个会话都稳定丢一行数据。失败方向是"少记录"而不是"记错"，所以它安静地活了很久：日志看起来正常，只是每个会话都缺最后一行。

## 改成什么

- **`turn/end` 到达即结算**（主结算点）。格式校验器要求 `turn/end` 之前该回合的调用集已闭合（`dsh-session-format-v3-to-v4`：`case "turn/end"` 必须没有未闭合的 step，且先 `closeTools`），所以此刻的计数是完整的。
- **`session/disposed` 再结算一次**（第二结算点）：会话在两个回合之间被销毁、或中途异常退出时，没有下一个回合可等。
- **下一个回合 `step 1` 的那次结算保留为兜底**：`turn/end` 会清空它结算过的状态，所以兜底只可能对"`turn/end` 没到"的回合生效，不会重复写出。

**只改了写作的时刻。** 计数器、键 `(sessionKey, turn)`、记录形状全部未动——同一次调用、同一个回合，写出的值相同。这一点是实测的：从会话日志离线重算，插件也写过计数的 **55 个 (会话, 回合) 重叠单元，5 个计数器逐条全部相等**。差异只出现在插件漏写的区间。

## 已知残余：进程在 `turn/end` 之前被杀

主结算点依赖 `turn/end` **真的到达**。宿主进程在某个回合中途被杀、或连接在回合闭合前断开时，那个回合仍然没有 `turn-calls` 记录——这不是回归，是这次修复的边界，写在这里是为了以后不要把它当成"修复不彻底"。

活样本：主会话 `fa327c1c` 的 turn 124 于 `2026-10-02T19:01Z` 结束，宿主在 `19:10:31Z` 重启，那次结算没走到就被换掉了，于是该回合缺一条记录。同一批数据里，v1.15.5 之前创建的 17 个会话**全部各缺恰好 1 个回合**，那是旧版的最后一回合漏洞；而新会话（单回合、零工具调用）的日志回合数与遥测条数**差 0**。

离线工具的"结算完整性"一节就是按这个读的：某个会话"日志回合数 − 遥测条数 = 1"，若该会话创建于 v1.15.5 之前 → 旧版漏洞；创建于 v1.15.5 之后 → 该回合没有 `turn/end`（被杀）。差大于 1 才需要查。

## 没有动的东西

冻结清单上的九项一个都没碰：skill corpus、discovery 算法、tokenizer、常用词过滤、去重、HIGH 阈值、提示措辞、会话级分臂、`firstEligible` 定义。这一版改变的是读数的**覆盖**，不是刺激。改动清单可以逐文件对照：`host.js`（结算点 + 兜底注释）、`test/discovery-injection.mjs`（四条新断言）、`test/discovery-report.mjs`（一句注释）、版本号两处、本发布说明。除此之外没有文件被这一版碰过。

## T0 从什么时候重起

从**装上 v1.15.5 之后新建的会话**开始计数，理由不是"版本变了"，而是旧读数缺的正是主指标的观测单元：每个会话的首个 eligible 回合通常落在最后一个回合，也就是旧记录里恰好没有的那一行。旧日志不删除——它是一份有效的"结算前读数"，但它系统性地少算首观测，不能与新读数混在同一个分母里。

## 测试

`test/discovery-injection.mjs` 增加了五条断言（结算点、兜底未删、最后一个回合、会话销毁、空记录守卫），并把原有的时序断言从"下一回合结算"改到"`turn/end` 结算"。这些断言在**旧代码上会红**——实测跑旧 `host.js`：12 条断言失败，其中就包括"会话最后一个回合也有 `turn-calls` 记录"。一条不会因为行为改变而变红的测试，等于没有在测行为。

## 离线重算工具

从会话日志重算 `turn-calls` 的脚本（现放在 `D:\Vibe coding\.dsh\tools\`）不再充当长期读数口径，它的角色是**历史数据修正器 + 交叉验证器**：用于核对插件自己的结算是否完整，以及在旧日志上补回最后一回合。补数只对"插件报为不可配对、且日志能重算出来"的 `(会话, 回合)` 生效，补 0 也算补——插件的缺口是"不知道"，而日志能证明"确实 0 次"。

## English

**This is a coverage fix, not a stimulus change.** None of the nine frozen items moved; the treatment arm sees exactly the same hint as v1.15.4. **The only behavioural difference from v1.15.4 is the moment at which a `turn-calls` record is written.** Same stimulus, same criteria, same readout definition; old records and new records are both valid readouts, they just cannot share a denominator (see "T0 restarts" below).

**What was wrong.** The discovery telemetry wrote each turn's tool-call counts as a `turn-calls` record, but only settled a turn at the **next** turn's `step 1`. A session that ends after its final turn has no next turn, so every session's **last turn** never got a record. The experiment's primary metric — "did the model search during this session's first HIGH opportunity" — usually observes exactly that last turn (the most common real-world session shape is one question and one answer). Measured effect: of the 19 eligible sessions after T0, the primary metric kept **1 paired observation**.

**Why it was missed.** The old code's comment said the harness declares `turn/start` and `turn/end` but exposes no turn-stopping waterfall a plugin can hook, noting that `agent/turn-stopping` does not exist in 0.1.7-rc.2. That observation was true; the conclusion was wrong. It looked for a **waterfall**, and read "no waterfall" as "turn end is unobservable". But `turn/end` is a **session event**: `dsh-agent-loop` appends it in a `finally` (so canceled and failed turns are closed too), and `dsh-session-projection-cache` consumes it as `ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') … })` — the same channel this plugin was already listening on to count `tool/call`. A hook looked for in the wrong shape turned an event already in hand into an unobservable one, and cost every session one row. The failure direction was "one record missing" rather than "a wrong record", so it stayed quiet for a long time: the log looked healthy, it was just one line short per session.

**What changed.** Settle on **`turn/end`** (primary): the format decoder requires a turn's call set to be closed before `turn/end` is appended, so the counts are complete at that instant. Settle again on **`session/disposed`**: a session torn down between turns has no next turn to wait for. The next-turn `step 1` flush stays as a **backstop** — `turn/end` clears the state it settles, so the backstop can only fire for a turn whose `turn/end` never arrived, and cannot double-write.

**Only the moment of writing changed.** Counters, the `(sessionKey, turn)` key and the record shape are untouched; the same call, the same turn, the same numbers. This is measured, not asserted: recounting from the session logs, the **55 (session, turn) units the plugin did settle match on all five counters**. The two sources differ only where the plugin wrote nothing.

**Known residual: killed before `turn/end`.** The primary settlement point depends on `turn/end` actually arriving. If the host process is killed mid-turn, or a connection drops before the turn closes, that turn still gets no `turn-calls` record — not a regression, but the boundary of this fix, recorded here so nobody later reads it as an incomplete repair. Live sample: in main session `fa327c1c`, turn 124 ended around `2026-10-02T19:01Z` and the host restarted at `19:10:31Z`, so that settlement never ran and the turn is missing its record. In the same dataset the 17 sessions created before v1.15.5 are missing exactly one turn each (the old last-turn bug), while a new session (one turn, zero tool calls) shows a difference of zero. The offline tool's "settlement completeness" section reads it this way: log turns minus telemetry records equals one means the old bug for sessions created before v1.15.5, and a turn with no `turn/end` for sessions created after; anything larger needs investigating.

**What was not touched.** None of the nine frozen items: skill corpus, discovery algorithm, tokenizer, common-token filter, dedupe, HIGH threshold, hint wording, session-level arm, `firstEligible` definition. This release changes the **coverage** of a readout, not the stimulus. The change list can be checked file by file: `host.js` (settlement point plus the backstop comment), `test/discovery-injection.mjs` (four new assertions), `test/discovery-report.mjs` (one comment), the two version strings, and this note. No other file was touched by this release.

**One thing worth recording: T0 restarts.** Sessions **created after v1.15.5 is installed** start the new clock — not because the version changed, but because the old readouts are missing precisely the unit the primary metric is built from: a session's first eligible turn is usually its last, which is the row old records never had. Old logs are kept as a valid "pre-settlement" readout, but they systematically under-count first observations and must not share a denominator with the new one.

**Five new assertions** in `test/discovery-injection.mjs` (settlement point, backstop intact, last turn, session disposal, no phantom records), and its timing assertions moved from "settled by the next turn" to "settled at `turn/end`". They fail on the old code: running the old `host.js` reddens 12 assertions, including "a session's last turn has a `turn-calls` record". A test that does not redden when behaviour changes is not testing behaviour.

**The offline recount tool.** The script that recounts `turn-calls` from session logs (now under `D:\Vibe coding\.dsh\tools\`) is no longer a long-term readout path; its role is **historical corrector plus cross-validator** — checking that the plugin's own settlement is complete, and restoring last turns in old logs. It only adds units the plugin reported as unpaired and the log can recompute, and a recovered zero counts as recovered: the plugin's gap is "I do not know", while the log can prove "zero calls happened".
