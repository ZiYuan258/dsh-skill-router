# v1.16.2 — 注入层默认关停 + 中文查询可检索：两个被实测直接指向的改动

[English](#english) | 中文

**两个改动，各自有一条实测在背后。** 都不改变"技能被使用的条件是「用户请求主语 = 技能对象」"这个观察，
也不期待转化率；它们修的是"做了但被实测证明是死重"和"做了但中文完全搜不到"。

## 改动一：HIGH-tier 注入默认关停

实测（见 `.dsh/SKILLS-POLICY.md` §25/§26，`discovery.jsonl`）：注入候选的 45 个 treatment 回合
**0 次自发加载**（唯一 1 次是用户指定重放），而**不注入**的 181 个对照回合有 12 次自发使用——
且常驻目录的 16 次自发使用全部落在未注入侧。设计假设"agent is never told which ones are worth
considering"已被直接测试证伪。

`host.js` 的 `INJECT_TIERS` 改为环境变量门控，默认空集（不注入）：

```js
const INJECT_TIERS = new Set(process.env.DSH_SKILL_ROUTER_INJECT_TIERS === 'HIGH' ? ['HIGH'] : [])
```

重新打开（仅供继续观测）：`DSH_SKILL_ROUTER_INJECT_TIERS=HIGH`。工具半（`skill_search` /
`skill_load`）原样保留——它是库的唯一模型入口，且是被证明有效的那条通道。

## 改动二：tokenizer 保留集加入 CJK

`host.js` 的 tokenize 原来用 `/[^a-z0-9+#._-]+/g` 切词，保留集不含 CJK，于是
`tokenize('插件装不上') = []`——中文查询在检索层**整体灭活**。现在保留集加入窄口径 CJK 范围
（Ext-A `\u3400-\u4dbf` + 统一表意 `\u4e00-\u9fff` + 兼容表意 `\uf900-\ufaff`），
CJK 连续段作为一个 token 保留。中文无词边界，多词查询仍需用空格分词。

## 测试与版本

- `test/discovery-injection.mjs` 升到 v3：在文件顶部设 `DSH_SKILL_ROUTER_INJECT_TIERS=HIGH`，
  继续验证注入接线；真机默认不注入。
- 版本 1.16.1 → 1.16.2（`package.json` + `client.js`）；README 版本示例同步。

---

## English

**Two changes, each backed by a direct measurement.** Neither alters the observation that "a skill
gets used when the user's request subject is the skill's object"; they fix "done but measured dead"
and "done but invisible to Chinese queries".

### Change 1: HIGH-tier injection off by default

Measured (see `.dsh/SKILLS-POLICY.md` §25/§26): of 45 injected treatment turns, **0 spontaneous
loads** (the single 1 was a user-specified replay); of 181 non-injected control turns, 12 spontaneous
uses — and all 16 resident-catalog spontaneous uses fell on the non-injected side. The design
hypothesis "the agent is never told which ones are worth considering" is directly falsified.

`INJECT_TIERS` in `host.js` is now env-gated and empty by default (no injection). Re-enable for
continued observation only: `DSH_SKILL_ROUTER_INJECT_TIERS=HIGH`. The tool half (`skill_search` /
`skill_load`) is unchanged — it is the library's only model-facing entry and the proven channel.

### Change 2: tokenizer keeps CJK

The tokenizer used `/[^a-z0-9+#._-]+/g`, so `tokenize('插件装不上') = []` — Chinese queries were
fully dead in the retrieval layer. The keep-set now includes a narrow CJK range (Ext-A `\u3400-\u4dbf`,
Unified Ideographs `\u4e00-\u9fff`, Compatibility Ideographs `\uf900-\ufaff`); a CJK run is kept
as one token. Chinese has no word boundaries, so multi-word queries still need space-separated words.

### Tests and version

- `test/discovery-injection.mjs` is now v3: it sets `DSH_SKILL_ROUTER_INJECT_TIERS=HIGH` at the top
  to keep testing the injection wiring; real hosts inject nothing by default.
- Version 1.16.1 → 1.16.2 (`package.json` + `client.js`); README version examples updated in lockstep.
