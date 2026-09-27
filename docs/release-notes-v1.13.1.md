# v1.13.1 — 读数去重、删掉 debug 旁路、README 事实修正

[English](#english) | 中文

三处收尾，都不改 discovery 算法。第一处会让实验结论算错，第三处是**文档已经与代码冲突**。

## 修复一：`pairTurns()` 的注释说去重，代码没去重

注释写着"同一回合可能有多条发现记录……取最后一条计数"，而代码是：

```js
for (const found of discovery) {
  const counted = calls.get(pairKey(found))
  if (counted === undefined) unpaired.push(found)
  else paired.push({ ...found, calls: counted })   // 每条记录都 push
}
```

**注释与代码矛盾，而且是字面意义的矛盾**——上一轮的补丁把注释塞进了循环体，却没实现去重。

后果不是显示问题：同一回合在**分子和分母里各算两次**，`injected.pairedTurns` / `searchRate` / `loadRate` 全部被重复计数，**足以把真实差异抹平**。最危险的地方是读数看起来完全正常——没有报错，没有异常值，只是一个悄悄变大的分母。

**现在的模型**：

```
(sessionKey, turn)
       ↓
多条发现记录 → 取最后一条（tier 由它裁定）
       ↓
多条计数记录 → 逐项求和（每条已是"该回合累计值"）
       ↓
再配对
```

`paired.length` 因此**等于唯一回合数**，实验门槛"50 个回合"数的才是它。

**真机效果**：可配对回合从 **36 → 30**——确实有 6 条重复此前被当成 6 个回合。

**为什么我的测试没抓到**：没有覆盖"同回合 ≥2 条发现记录"。现已补上 7 条断言，包括"取最后一条"和"多条计数求和"。

## 修复二：删掉两处 debug 旁路

`sessionKeyOf()` 和 pre-step 里各有一处：

```js
const dbg = globalThis.__sk
if (Array.isArray(dbg)) dbg.push({ keys: …, id: session && session.id })
```

默认不写任何地方（那两个全局正常不存在），所以**不是实际泄露**。但它们是**"如果有人设置这个全局数组，就把真实 session id 放进去"的旁路**——而上一版刚花整轮把隐私边界做到"只存哈希、不存 id"。原则和旁路不能共存，直接删。

删完检查了全部三个发布文件，只剩一处 `globalThis`：

```js
const sink = globalThis.__dshSkillRouterDiscoveryErrors   // 只收集错误字符串
```

它收集的是**错误信息**（不含会话数据、不含用户文本），已注释说明是给测试用的，与那两处性质不同，保留。

## 修复三：README 的事实错误

README 开头写着"本插件不做自动注入"，发现层那节写着"当前只测量不注入"——而 `host.js` 已经在做：

```js
return inject ? { ...decision, messages: [...decision.messages, contextMessage(hint)] } : decision
```

**这是事实错误，不是措辞问题。** 产品真实的边界是：

```
用户任务
   ↓
discovery          ← 插件自动
   ↓
候选提示（只有名字）  ← 插件自动
   ↓
判断要不要用        ← agent
   ↓
skill_load         ← agent
   ↓
技能正文           ← 只有这一步才进上下文
```

所以改为：

> **本插件不会自动加载或注入技能正文，但它**会**自动提示候选——两者都是有意的。**

这句把"自动提示"与"自动加载正文"分开，既准确描述现在的架构，也不会和那些"自动路由 + 把正文塞进提示词"的项目混淆。正文同步改了三处（开头、同名仓库对照表、ledger 那节），英文侧同步。

**并且改了守着这句话的那条断言。** `docs-parity.mjs` 原本查的是 `不做自动注入`——**断言跟着过时的语义走，就会把事实错误锁死在文档里**。现在它要求开头同时说出两条边界（不加载正文 / 会提示候选），中英文各自的正则都要求两半都在。

## 范围

按你锁定的范围，这一版只有这三项：

```
v1.13.1
├── discovery report 按 (sessionKey, turn) 真正去重  ✅
├── 删除 __sk / __pre debug 遗留                    ✅
└── README 修正"自动注入"语义                        ✅
```

**没有动**：discovery 算法、tokenizer、embedding、严格 AND、MEDIUM 注入。

## 测试

`test/discovery-report.mjs` 增加 7 条断言；`docs-parity.mjs` 的立场断言改为要求两条边界同时出现。全套 30 个脚本全绿。

写断言时我又留了一条**恒真断言**（`... ? true : true`，等于没测），发现后删掉了——和上一轮的三次夹具错误是同一类问题：**测试本身也需要被看着**。

## English

Three pieces of cleanup, none touching the discovery algorithm. The first could make the experiment's numbers wrong; the third is a **documentation fact error**.

**Fix one: `pairTurns()` said it deduped and did not.** The comment claimed "several discovery records for one turn: take the last", while the loop pushed one entry per discovery record. The comment and the code contradicted each other literally — the previous round's patch inserted the comment into the loop body without implementing the dedup. The consequence is not cosmetic: one turn counted twice in both numerator and denominator, so `injected.pairedTurns`, `searchRate` and `loadRate` were all inflated, **enough to flatten a real difference**. What makes it dangerous is that the readout looks entirely normal — no error, no outlier, just a quietly larger denominator. Pairing is now keyed on `(sessionKey, turn)`: several discovery records collapse to the last one (which decides the tier), and several counting records are **summed** field by field, because each one already represents that turn's cumulative value. `paired.length` therefore equals the number of unique turns, which is what the "50 turns" gate should be counting. Against the live log the change moved paired turns from **36 to 30** — six duplicates had been counted as six turns. My tests missed it because none covered "two discovery records in one turn"; seven assertions now do, including "last one wins" and "multiple counting records sum".

**Fix two: two debug bypasses removed.** `sessionKeyOf()` and the pre-step handler each had a `globalThis.__sk` / `globalThis.__pre` push that would place a **real session id** into a global array. They write nothing by default, so nothing leaked — but they are a bypass around the privacy boundary the previous version established ("store the hash, never the id"), and a principle and a bypass cannot coexist. After removing them, a scan of all three shipped files leaves exactly one `globalThis`: `__dshSkillRouterDiscoveryErrors`, which collects error **strings** only — no session data, no user text — and is documented as a test hook, so it stays.

**Fix three: the README was factually wrong.** The opening said the plugin does not auto-inject and the discovery section said it currently only measures; `host.js` already appends the hint to `decision.messages`. The real boundary is: discovery and a names-only hint are automatic, the decision and the `skill_load` call are the agent's, and a skill body enters the context only through that call. The opening now reads "**this plugin never auto-loads or injects a skill's body — but it does auto-suggest, deliberately**", with three body passages and the English side aligned. **The assertion guarding that sentence was updated too**: `docs-parity.mjs` used to require the phrase "does not auto-inject", and an assertion that follows stale semantics locks the fact error into the docs. It now requires both halves of the boundary, in both languages.

**Scope.** Exactly the three locked items — no changes to the discovery algorithm, the tokenizer, embeddings, the strict-AND policy, or MEDIUM injection. While writing the assertions I left one **tautology** (`... ? true : true`, testing nothing) and removed it on noticing — the same class of mistake as the three fixture errors in the previous round: the tests themselves need watching.
