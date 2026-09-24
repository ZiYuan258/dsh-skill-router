# v1.6.0 — 「技能」标签页：和对话、轨迹、审批、上下文同一栏

[English](#english) | 中文

这一版加的是**用户可见的功能**，不是修 bug：插件多了一个客户端半，在对话视图那一栏加一个**技能**标签页，列出本会话真正加载过哪些技能，中文名在前、英文原名在后。

```
技能调用清单
共 5 次技能加载，涉及 3 个技能。

1  验证·前置·完成     verification-before-completion   skill_load
2  写作·规划           writing-plans                    skill
3  供应链·风险审计     supply-chain-risk-auditor        skill_load
```

## 数据全部来自会话本身，所以零 token、零 RPC

这个座位（`conversation.view`）交给组件 `useChat`，其 `legacy.nodes` 就是本轮**已经持有**的对话。技能调用直接从中读出——**没有宿主 RPC、没有投影键、没有网络请求**，也没有任何东西进入模型上下文。插件至今仍是"从不联网、从不写文件"。

## 中文名只用于显示，一个字节都没改

技能名是 `skill_load`、索引检索、`/skill` 命令的**匹配键**，所以：

- 实际调用的永远是英文原名，中文形不离开渲染层；
- 检索仍走英文原文，`SKILL.md` 与索引**未被修改**；
- 专名（`azure`、`vercel`、`semgrep`、`figma`…）保持原样——本库名字里最高频的 token 正是 `azure`(148) 与 `google`(44)，译成中文只会更难认。

翻译是**术语表 + 专名白名单**，不是 872 条整名对照表：短语优先（`best-practices` → 最佳实践），再退到单词（`troubleshooting` → 故障排查），虚词（`and`/`from`/`the`）丢弃。

## 字段路径是探出来的，不是猜的

这一节值得单独写，因为它花了最多时间，也是唯一一个**猜错就会静默失效**的地方。

技能调用**不在**独立节点里。真实形状（由一次 183 节点的真实会话探针得到）：

```
assistant 节点   { kind: 'assistant', blocks: [ { kind: 'tool-call', name, arguments } ] }
tool-result 节点 { kind: 'tool-result', call: { name, argsRaw: '<json string>' } }
```

三个此前写进过（或差点写进）代码的猜测**全错**：

| 猜测 | 实际 |
|---|---|
| `kind === 'tool-call'` 的独立节点 | 节点 kind 只有 assistant / tool-result / user / context / steering |
| 参数在 `node.block.call` | 在 `block.arguments`，且块由 **`kind`** 区分而不是 `type` |
| 参数路径是 `conv.blocks` | 节点上直接就是 `blocks` |

如果没探这一步，`kind === 'tool-call'` 会**恒为假**——看板永远显示"0 个技能"，而排查方向会全错。所以 `test/usage.mjs` 的夹具**照抄探针输出**，`test/client-half.mjs` 则在 `node:vm` 里用桩 React/DOM/ctx **真的渲染一次**组件，断言中文名、英文原名、计数、以及"`skill_search` 不算加载""`tool-result` 不重复计"。

## 另一个差点静默失效的地方

三个已发布的客户端半（`dsh-context`、cost-meter、skill-center）**全部用 `module.exports = plugin`**，没有一个用裸 `return`。而裸 `return` 是**动态插件** `code.client` 的写法——我把两个接缝搞混了。

现在 `client.js` 两者都做：有 CommonJS 绑定时赋值 `module.exports`，无论如何也把插件返回。**这里写错的后果是文件什么都不注册、标签页静默不出现**，所以测试两条都断言。

## 工程约束没有被破坏

| 不变量 | 状态 |
|---|---|
| 零依赖、无 `node_modules` | 保持（`boot-safety.mjs` 仍拒绝任何 `@deepseek-ai/*`） |
| 客户端半不 import 任何包 | 保持（React 由宿主提供；`client-half.mjs` 静态断言） |
| 无构建步骤 | 保持——客户端半是**源码直发**，不是预构建产物（cost-meter 那种 255 KB bundle 不需要） |

## 安全政策已同步更新

新增一行"触碰页面 DOM"，因为客户端半确实做了两件 DOM 操作：`document.createElement('style')` 与 `document.head.appendChild`（卸载时移除）。**不查询、不修改产品自身的任何 DOM 节点**。同时新增一节说明客户端半读什么：只取 `kind` / `name` / `arguments` 这些标量叶子字段，不复制节点、不序列化、不外发。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`
- 客户端半需要 DSH 的 Web 界面（`dsh.client.platform: web`）

## 测试

十八个（原十六个 + `usage.mjs` + `client-half.mjs`），CI 在 Linux 与 Windows × Node 20 / 22 / 24 上全绿。

---

## English

This release adds a **user-visible feature** rather than fixing a bug: the plugin now ships a Client half that adds a **技能 / Skills** tab to the conversation view ring, listing which skills the session actually loaded — Chinese name first, English original beside it.

```
技能调用清单
共 5 次技能加载，涉及 3 个技能。

1  验证·前置·完成     verification-before-completion   skill_load
2  写作·规划           writing-plans                    skill
3  供应链·风险审计     supply-chain-risk-auditor        skill_load
```

### The data comes from the conversation itself, so: no tokens, no RPC

The seat (`conversation.view`) hands the component `useChat`, whose `legacy.nodes` is the conversation the turn **already holds**. Skill calls are read straight out of it — **no Host RPC, no projection key, no network request** — and nothing enters the model's context. The plugin still never touches the network and never writes a file.

### The Chinese name is display only, and not a byte changed

A skill name is the **match key** for `skill_load`, for index search and for the `/skill` command, so:

- what gets called is always the English original; the Chinese form never leaves the render layer;
- search still runs against the English text — `SKILL.md` and the index are **unmodified**;
- proper nouns (`azure`, `vercel`, `semgrep`, `figma`…) are left alone: the most frequent tokens in this library's names are `azure` (148) and `google` (44), and translating them only makes a name harder to recognise.

The translation is a **glossary plus a proper-noun allow list**, not 872 hand-written pairs: phrases first (`best-practices` → 最佳实践), then single words (`troubleshooting` → 故障排查), with filler words (`and`/`from`/`the`) dropped.

### The field paths were probed, not guessed

This section earns its own heading because it consumed the most time and because it is the one place where **a wrong guess fails silently**.

A skill call is **not** a node of its own. The real shape, from probing a live session of 183 nodes:

```
assistant node   { kind: 'assistant', blocks: [ { kind: 'tool-call', name, arguments } ] }
tool-result node { kind: 'tool-result', call: { name, argsRaw: '<json string>' } }
```

Three guesses that went into the code (or nearly did) were **all wrong**:

| Guess | Reality |
|---|---|
| a node with `kind === 'tool-call'` | node kinds are only assistant / tool-result / user / context / steering |
| arguments at `node.block.call` | they are at `block.arguments`, and a block is discriminated by **`kind`**, not `type` |
| the container is `conv.blocks` | `blocks` sits directly on the node |

Without the probe, `kind === 'tool-call'` would have been **permanently false** — the tab would forever read "0 skills" and every debugging instinct would point somewhere else. So `test/usage.mjs` copies the probe's output into its fixtures, and `test/client-half.mjs` **actually renders** the component in `node:vm` with stubbed React/DOM/ctx, asserting the Chinese name, the English original, the counts, that `skill_search` is not a load, and that `tool-result` nodes are not counted twice.

### Another near-silent failure

All three shipped Client halves (`dsh-context`, cost meter, skill center) use **`module.exports = plugin`**; none uses a bare `return`. A bare `return` is how a **dynamic** Package's `code.client` works — two different seams, and this file initially confused them.

`client.js` now does both: it assigns `module.exports` when the CommonJS bindings exist, and returns the plugin regardless. **Getting this wrong means the file registers nothing and the tab simply never appears**, so the test asserts both.

### The engineering constraints held

| Invariant | State |
|---|---|
| Zero dependencies, no `node_modules` | Held (`boot-safety.mjs` still rejects any `@deepseek-ai/*`) |
| The Client half imports no package | Held (React comes from the host; `client-half.mjs` asserts it statically) |
| No build step | Held — the Client half ships as **source**, not as a prebuilt artifact (no cost-meter-style 255 KB bundle) |

### The security policy was updated with it

A new row covers the page DOM, because the Client half does make two DOM calls: `document.createElement('style')` and `document.head.appendChild` (removed again on unload). It **queries and modifies no product-owned DOM node**. A further section states what the Client half reads: only the scalar leaves `kind`, `name` and `arguments` — no node is copied, serialized or sent anywhere.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
- The Client half needs DSH's web UI (`dsh.client.platform: web`)

### Tests

Eighteen (sixteen plus `usage.mjs` and `client-half.mjs`), green on Linux and Windows × Node 20 / 22 / 24.
