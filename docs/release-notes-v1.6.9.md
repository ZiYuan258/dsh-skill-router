# v1.6.9 — 把版本号印在标签页上，并把看门狗降到 4 秒

[English](#english) | 中文

这一版不是修数据，是修**可观测性**——因为上一轮我浪费在猜上面。

## 问题：「浏览器跑的是哪一版」无法回答

v1.6.8 发布后，反馈仍然是同一句「已读到第 0 页更早的记录，仍在继续」。而 v1.6.8 里那句话有两条出路（4 秒看门狗、连续无进展），**都不应该让它留下来**。所以要么是代码没到页面，要么是判断还有洞——可我当时无法区分，只能继续猜。

三件事凑成了这个盲区：

1. 客户端半由 web 服务带 `cache-control: public, max-age=31536000, immutable` 提供；
2. 这个文件**不能被 Node 测试 import**（它是经典脚本，要插桩 `__ModuleLoader__` 才能跑）；
3. 服务端字节挡在 Desktop 的能力校验后面——`/plugins` 一律 403，因为 Electron 渲染进程会带一个 32 字节令牌头（`x-dsh-desktop-renderer`），普通浏览器默认被拒。

我确实去试着取回那份字节，确认了它取不回来。**那是对的**：那是渲染进程与普通浏览器之间的边界，不该被绕过。

所以改产品本身：标签页底部现在印一行

```
dsh-skill-router v1.6.9 · 第 0 页 · 无进展停止
```

版本号、已读页数、以及**翻页为什么停下**（已读完 / 读取中 / 无进展停止 / 超时停止 / 到上限停止 / 出错）。这样"你跑的是哪一版"从猜测变成一眼可读，我不用再让你描述现象来反推代码版本。

标签能漂移就比没有标签更糟，所以 `test/package-contract.mjs` 把 `client.js` 里的 `VERSION` 与 `package.json` 钉在一起。

## 另一个更可能的解释：8 秒太长

看门狗挂起期间标签页显示的是「正在读取更早的记录…」——**也就是说，刷新之后的 8 秒里，新代码显示的是和 bug 一模一样的文案**。

调试这个修复的过程把代价摆得很清楚：连续两轮反馈都落在这个窗口里，看起来都像"没修好"，其实是"还没到期"。看门狗慷慨到超过读者的耐心，就让每一次检查都变成抛硬币。

所以降到 **4 秒**。不是为了让修复变对，是为了让**修复可被观察**。

## English

This release fixes **observability**, not data — because the previous round was wasted on guessing.

After v1.6.8 shipped, the report was the same sentence as before: "已读到第 0 页更早的记录，仍在继续". But in v1.6.8 that sentence has two exits (a 4-second watchdog and a run-of-no-ops rule) and neither should leave it standing. So either the code had not reached the page, or the judgement still had a hole — and I could not tell which, so I kept guessing.

Three things made that blind spot: the Client half is served with `cache-control: public, max-age=31536000, immutable`; the file **cannot be imported by a Node test** (it is a classic script that has to be run with an instrumented `__ModuleLoader__`); and the served bytes sit behind the Desktop capability check — `/plugins` answers 403 to an ordinary browser because the Electron renderer attaches a 32-byte token header (`x-dsh-desktop-renderer`). I did try to fetch those bytes, and confirmed I cannot. **That is correct behaviour**: it is the boundary between the renderer and an ordinary browser, and it should not be worked around.

So the product now states it. The tab's footer reads `dsh-skill-router v1.6.9 · 第 0 页 · 无进展停止` — version, pages read, and **why paging stopped** (finished / reading / no progress / timed out / hit the cap). "Which build are you running" becomes readable instead of inferred from a description of symptoms, and a label that can drift would be worse than none, so `test/package-contract.mjs` pins the `VERSION` in `client.js` to `package.json`.

**And the likelier explanation: eight seconds was too long.** While the watchdog is pending the tab says "正在读取更早的记录…" — meaning that for eight seconds after a refresh, the fixed code displays exactly the sentence the bug displayed. Two consecutive reports landed inside that window and both looked like "not fixed" when they were really "not yet due". A watchdog generous enough to outlast a reader's patience turns every check into a coin flip, so it is now four seconds — not to make the fix correct, but to make it observable.
