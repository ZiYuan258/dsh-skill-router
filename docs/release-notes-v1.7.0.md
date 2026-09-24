# v1.7.0 — 定案：effect 重入让翻页变成「没有任何计时器在跑」

[English](#english) | 中文

上一版把版本号印在界面上，用一次反馈换来一个决定性事实：

```
dsh-skill-router v1.6.9 · 第 0 页 · 读取中
```

**新代码确实在页面上跑**（v1.6.9），而看门狗没有兜住。这一下把可能性收敛到一种，剩下的只是把它复现出来。

## 机制：重入时，取消一次尝试的是 effect 自己的清理

v1.6.9 的翻页 effect 有一个清理函数：

```js
return () => {
  live = false                       // 让在途尝试作废
  clearTimeout(watchdog)
}
```

而 `inFlightRef` 只在**尝试结束时**才被清掉。于是：

1. effect 跑第一遍：设 `inFlightRef = true`，挂上 4 秒看门狗，发出请求；
2. **effect 被重入**（父组件重渲染，props 引用变化）→ 清理执行 → `live = false`，看门狗被清掉；
3. effect 跑第二遍：`inFlightRef` 仍是 `true`，在守卫处直接 `return`；
4. 结果：**一个谁也结束不了的尝试，加上一个已经不存在的计时器**。状态永远停在"加载中"。

第 2 步为什么发生：渲染器把注册项 `inject` 的结果展开成 props，父组件每次给出新的 props 对象时，任何"每次渲染都产生新引用"的值都会让 effect 重新进入。这不依赖我预测对具体哪个值变了——**只要可能发生，就必须扛得住**。

## 复现，然后修

测试里复现的方式就是"父组件每次传新 props"：关掉注入缓存，每次渲染重新算一份。

修复前：`loadOlder=1`、永远「读取中」、连把受控时钟推进 4 秒看门狗也不到期——**和你屏幕上的三行完全一致**。

修法是把**尝试的寿命与启动它的 effect 解耦**：

- 看门狗句柄存进 ref（原先存在 effect 局部变量里）；
- 启动尝试的 effect **不再写清理函数**——它的职责只是"没有在途尝试时启动一个"，结束尝试属于尝试自己；
- 只有**真正卸载**才取消（`unmountedRef`，在挂载期 effect 的清理里设置）；
- 卸载后的 promise 回调也不再对已卸载组件写状态。

新增 9 条断言钉住这条路径，其中 5 条在修复前必红。

## 关于这一轮的方法

我在这条 bug 上连续错了四次判断（数据契约、注入契约、空转语义、重入寿命），每一次都写了"这次找到根因了"。真正起作用的不是第四次推理更聪明，而是**上一版先把界面上的版本号做出来**——它把"代码到底有没有到页面"从一个我猜不出来、又取不回证据的问题，变成一行用户可以直接粘给我的文本。

**看不到的东西没法调试。** 这句话本身比任何一个具体修复都值钱。

## English

The previous release printed the running version in the tab, and one report bought a decisive fact:

```
dsh-skill-router v1.6.9 · 第 0 页 · 读取中
```

The new code **is** running in the page (v1.6.9) and the watchdog still did not fire. That collapsed the possibilities to one, leaving only the job of reproducing it.

**The mechanism: an effect's own cleanup was cancelling the attempt.** The paging effect returned `() => { live = false; clearTimeout(watchdog) }`, while `inFlightRef` was only cleared when an attempt *ended*. So: the effect sets `inFlightRef = true`, arms a 4-second watchdog and sends the request; the effect is **re-entered** (a parent re-render with a new props object) so its cleanup runs, setting `live = false` and clearing the watchdog; the second run finds `inFlightRef === true` and returns at its guard. The result is an attempt nothing can finish plus a timer that no longer exists — the state sits on "loading" forever.

The re-entry happens because the renderer spreads the registration's `inject` result into props, so any value that is a fresh reference on every render arms that trap. It does not depend on my predicting *which* value changes: if it can happen, it has to survive.

Reproducing it in a test is simply "hand over new props on every render" (cache off, recomputed each time). Before the fix: `loadOlder=1`, stuck on "读取中" forever, and advancing the controlled clock past the 4-second watchdog did nothing — the same three lines the user reported.

The fix decouples an attempt's lifetime from the effect that starts it: the watchdog handle lives in a ref rather than an effect-local variable, the starting effect writes **no** cleanup (its only job is to start an attempt when none is running; ending one belongs to the attempt), only a real unmount cancels anything, and post-unmount promise callbacks no longer write state. Nine assertions pin the path, five of which were red before the change.

**On method:** I got this bug wrong four times in a row (data contract, inject contract, no-op semantics, re-entry lifetime), each time writing "found the root cause". What actually worked was not the fourth inference being cleverer — it was the previous release putting the version in the UI, converting "did my code even reach the page", which I could neither guess nor fetch evidence for, into one line the user could paste. **What you cannot see, you cannot debug** — and that is worth more than any single fix here.
