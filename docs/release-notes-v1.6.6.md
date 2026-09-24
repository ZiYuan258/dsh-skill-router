# v1.6.6 — 现场插槽目录给出的两条纠正：座位一直都在，`inject` 要接两个参数

[English](#english) | 中文

v1.6.5 之后我重启了 DSH，然后用**只读的插槽检查器**看了一次真实浏览器里的现场目录。它一次纠正了两件事，其中一件是我在 v1.6.5 的提交说明里**写错的**。

## 纠正一：`useChat` 座位一直存在，错的是投影

我在 v1.6.5 的提交说明里写过"这个座位在会话 UI 里根本不存在"（依据是 `dsh-client-ui-conversation` 里 `useChat` 出现 0 次）。现场目录推翻了这个结论：

```
"standardProps": [
  "useChat: UseChat",
  "useConversation: UseConversation",
  "sessionId: SessionId",
  "useSession: SessionSnapshotSelector",
  ...
]
```

`useChat` 就在 `conversation.view` 的标准 props 里，由 `dsh-client-ui-chat` 通过 `uiSession.provide` 提供——我在错误的包里找了它。

所以正确的说法是：**座位在，投影里没有那些数据**（实测 210 个节点、0 次工具调用）。这和"座位不在"是两回事，而我当时只验证了一半就下了结论。数据和投影的区别才是这次真正的教训，我把它写成了一个比实际更整齐的故事。

## 纠正二：`inject` 的第二个参数也要接

现场目录的 `catalog` 里，`conversation.view` 的 `ownerProps` 只有：

```ts
interface ConvViewOwnerProps {
  viewRequest: ConversationViewRequest | null
  openView: (view: string, focus: string) => void
  completeViewRequest: () => void
}
```

**没有 `sessionId`**。会话从哪来？两条路：标准 prop `sessionId: SessionId`（组件自己读），以及注册项的 `inject`（渲染器把返回值展开成 props）。而渲染器的 `runInject` 是 `inject(binding.key, actions)`——第一个参数是作用域绑定的 key，**第二个参数只在带上下文的渲染路径上被传**。

v1.6.5 只读了第一个参数。那能跑，但等于在赌渲染器走哪条路径。现在两个都接，优先第一个：

```js
const key = sessionId ?? binding?.key
```

测试也跟着补了——原来的桩只传一个参数，于是"回退"这条路径**从来没被执行过**。只传 1 个参数的替身验证不到渲染器真正传的东西，这和第 3 条教训是同一个形状。

## 顺带确认：标签页确实在

现场目录的 `conversation.view` occupants：

| registrant | id | order | active |
|---|---|---|---|
| `Ba` | `chat` | 0 | true |
| `Ba` | `trajectory` | 10 | true |
| `dsh-approval-gate` | `dsh-approval-gate.history` | 20 | true |
| `dsh-context` | `context` | 20 | true |
| **`dsh-skill-router-client`** | **`skill-router-usage`** | **21** | **true** |

这一条比任何测试都硬：客户端半确实加载了、确实注册了、而且是活着的。之前三次事故（顶层 return、裸 `module.exports`、无守卫的 `document.head.appendChild`）在这个检查器里都会表现为"这个条目不存在"。

## English

After v1.6.5 I restarted DSH and read the live slot catalog through the read-only inspector. It corrected two things — one of which I had got **wrong** in the v1.6.5 commit message.

**`useChat` was always there; the projection was the problem.** I had claimed the seat "does not exist in the conversation UI at all", on the evidence that `useChat` appears zero times in `dsh-client-ui-conversation`. The live catalog overrules that: `useChat: UseChat` is listed among the standard props of `conversation.view`, provided by `dsh-client-ui-chat` through `uiSession.provide` — I had looked in the wrong package. The accurate statement is that the seat was present and the projection carried no such data (210 nodes, zero tool calls). A seat with wrong data is a different finding from an absent seat, and I concluded after checking only half of it. The real lesson is data versus projection; I had told it as a tidier story than it was.

**`inject` takes two arguments and both are now accepted.** The catalog's `ownerProps` for this slot are only `viewRequest`, `openView` and `completeViewRequest` — no `sessionId`. The session arrives either as the standard `sessionId: SessionId` prop or through the registration's `inject`, and the renderer's `runInject` calls `inject(binding.key, actions)`: the first argument is the scope binding's key, the second is threaded only through the contextual-render path. v1.6.5 read only the first, which works but bets on which path the renderer takes. Both are now accepted, first one preferred.

The test harness had only ever passed one argument, so the fallback path had **never executed** — a stub that passes one argument cannot verify what the renderer actually passes, which is the same shape of mistake as lesson three.

**And the tab is confirmed live.** The catalog lists `dsh-skill-router-client` / `skill-router-usage` at order 21 with `active: true`, alongside chat, trajectory, approval-gate history and context. That is harder evidence than any test: the Client half loaded, registered, and is alive. All three earlier boot accidents would have shown up here as that entry simply not existing.
