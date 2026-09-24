# v1.6.7 — 真机反馈暴露的三个缺陷：翻页会卡死，而且卡死时还说「数字是完整的」

[English](#english) | 中文

v1.6.6 之后我问了用户一个开放问题："标签页现在是什么状态？" 回答把三个我测试里跑不到的缺陷一次暴露了出来：

```
技能调用清单
本会话已加载 0 个技能名（0 次调用，涉及 0 个技能），正在读取更早的记录…

已读到第 0 页更早的记录，仍在继续。
```

**计数本身是对的**（这个会话确实一条技能都没加载——全程用的 `read`/`edit`/`pwsh`/`cordis_*`）。错的是状态：它永远停在"仍在继续"。

## 缺陷一：`loadOlder()` 不 settle，标签页就永远"正在读取"

`loading` 只在 promise 的 resolve/reject 里被改写。所以一次永远不 settle 的读取，会让这一次渲染停留到会话结束——`page` 停在 0，文案一直说"仍在继续"。

我的测试跑不到这条路径，因为**替身的 `loadOlder` 总是立刻 resolve**。这和第 3 条教训是同一个形状：替身比现实更友好，于是它验证的是一个不存在的时序。

修法是三层的：8 秒看门狗、`Promise.resolve(request)`（宿主侧接口不保证返回 promise，`.then` 会当场抛）、以及尝试 `loadOlder()` 本身的 try/catch。任何一层触发都会得到一个**结论**而不是无限等待。

## 缺陷二：翻页停在第 0 页，因为 tick 没有前进

翻页 effect 的依赖里只有 `state.tick` 表示"账本动了，看看还有没有下一页"。而解析回调只写了 `page` 和 `loading`——**没写 `tick`**，于是这次状态变化永远不会重新进入 effect。第一页解析完就停了。

这是修缺陷一时发现的：加了看门狗之后我意识到，"卡死"还有一个不需要超时的成因。

## 缺陷三（最严重）：给出结论时，卡死被当成"读完了"

看门狗触发后我把 `hasMore` 折叠成 `false` 传进账本，于是完整性判定落到 `complete`，标签页打印：

> 已读到本会话最早一条记录，**上面的数字是完整的**。

**这是这个标签页存在的意义所禁止的那句谎话。** 「我放弃了后面的历史」和「历史到此为止」是两个完全不同的事实，必须分开。现在 `stalled` 独立传递，`completeness` 保持 `partial`，文案是"之后不再继续读取——上面的数字只是这部分的"。

> 这一条是测试逼出来的：我先按"折叠掉 hasMore 更简单"写，两条断言当场变红。**如果我只信自己的判断，这个谎话会进发布版。**

## 现在卡住时会长什么样

```
技能调用清单
本会话已加载 1 个技能名（1 次调用，涉及 1 个技能）。   ← 不打印「共 N 次调用」
1  技能·B  (stuck-then-ok)  skill_load  第 1 轮
已读到第 0 页更早的记录，之后不再继续读取——上面的数字只是这部分的。
```

停止翻页**不影响实时尾部**：账本后来出现的调用照样会显示（有断言钉住）。

## 测试

`test/usage-tab.mjs` 从 51 条断言增到 **62** 条，新增的都是这三条路径：非 promise 的 `loadOlder`、永不 settle 的 `loadOlder`（推进受控时钟越过看门狗）、以及停止后不再发起新请求但仍接收实时新记录。

## English

After v1.6.6 I asked the user one open question — "what state is the tab in?" — and the answer exposed three defects my tests could not reach:

```
技能调用清单
本会话已加载 0 个技能名（0 次调用，涉及 0 个技能），正在读取更早的记录…
已读到第 0 页更早的记录，仍在继续。
```

**The count was right** (this session really had loaded no skills — it used `read`/`edit`/`pwsh`/`cordis_*` throughout). The state was wrong: it sat on "still reading" forever.

**One: a `loadOlder()` that never settles means "reading" forever.** `loading` was only ever rewritten in the promise's resolve/reject, so a read that never settles leaves that render in place for the life of the session — `page` stuck at 0, the copy still saying "still reading". My tests could not reach this path because **the fake always resolved immediately**: the same shape as lesson three, where a friendlier-than-reality stand-in validates a timing that does not exist. The fix is three layers — an 8-second watchdog, `Promise.resolve(request)` (a host-side read is not guaranteed to return a promise, and `.then` on a non-thenable throws), and a try/catch around the call itself — and any of them now produces a conclusion instead of an indefinite wait.

**Two: paging stopped at page 0 because `tick` never advanced.** The paging effect's only dependency meaning "the ledger moved, see whether another page is available" is `state.tick`, and the resolution callback wrote `page` and `loading` but **not** `tick` — so that state change never re-entered the effect. Found while fixing the first defect: realising a stall has a cause that needs no timeout at all.

**Three, and the worst: when it did conclude, it called a stall "complete".** The watchdog folded `hasMore` into `false` on the way into the ledger, so completeness resolved to `complete` and the tab printed "已读到本会话最早一条记录，**上面的数字是完整的**" — the one lie this tab exists to prevent. "I gave up on the rest of the history" and "the history ended here" are different facts. `stalled` is now passed separately, completeness stays `partial`, and the line reads "之后不再继续读取——上面的数字只是这部分的".

That third one was **forced by a test**: I wrote the simpler folding version first, and two assertions went red immediately. Had I trusted my own judgement, the lie would have shipped.

Stopping the paging does **not** stop the live tail — calls that arrive later still show up, and an assertion pins that.
