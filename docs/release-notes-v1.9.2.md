# v1.9.2 — 发版流程缺了一步：tag 推了，Release 没建

[English](#english) | 中文

有人问"发行版怎么没更新"，一查是这样：

| 页面 | 数量 |
|---|---|
| `/tags` | **30 个**（v1.1.0 → v1.9.1 全在） |
| `/releases` | **15 个**，停在 **v1.6.4** |

## 原因：tag 和 Release 是两个对象

`git push origin v1.9.1` 只推送 **tag 对象**；GitHub 的 **Release** 是另一个独立对象，必须在 `/releases` 上单独创建。我早期每个版本都做了这两步（v1.1.0–v1.6.4 都有 Release），从 v1.6.5 起**只做了第一步**，连续 14 个版本如此。

**这类漏做不会发出任何通知**：`git tag` 本地都在、`git push` 每次都成功、CI 每次都是绿的。两者在本地看起来完全一样，只有去翻发行版页面才看得出差别——而没人会每天去翻那个页面。所以这不是"忘了"，是**流程里没有任何一处会为此报警**。

已回填全部 14 个 Release（正文用对应的双语发布说明，标题取说明的 H1，与已有版本写法一致），现在 Releases 29 个、`latest` = v1.9.2。

## 防止再漏：把最后一步做成一条命令 + 一道检查

**`tools/publish-release.mjs`** —— 读 `package.json` 的版本、读对应的发布说明、创建 Release；已存在则跳过，可重复执行。

```sh
node tools/publish-release.mjs            # 当前版本
node tools/publish-release.mjs --check    # 只报告状态（缺则退出码 1）
node tools/publish-release.mjs --all      # 回填所有缺 Release 的版本
```

**`RELEASING.md`** —— 五步流程，并写明为什么第 5 步需要脚本而不是靠记性。

**`test/release-consistency.mjs`** —— 离线可判定部分纳入 `npm test`（第 21 个脚本）：两处版本号一致、当前版本有发布说明、**每份说明的标题以自己的版本号开头**（Release 标题取自此）、每份双语齐全、**每个版本 tag 都有对应说明**、流程文档与发布脚本都在。

Release **本身**是否存在必须联网查，不适合放进 `npm test`（CI 只有 `contents: read`，且应能离线跑），所以那半由 `--check` 负责——两者合起来覆盖整条链。

## 这一轮的教训与前几轮不同

前面几轮都是**代码里的错误假设**（数据契约、`loadOlder` 的对象、滑窗判据）。这一次是**流程里的错误假设**：我以为"推了 tag 就是发版了"。

相同的形状：**两个看起来一样的东西其实不一样，而没有任何信号会告诉你区别。** 按这个形状，唯一的防法不是在文档里加一句提醒，而是让"最后一步"变成一条命令，并让一致性变成一道会红的检查。

## English

Someone asked why the releases page had stopped updating. The state was: **30 tags** (v1.1.0 → v1.9.1) against **15 releases**, stuck at **v1.6.4**.

**A tag and a Release are two different objects.** `git push origin v1.9.1` delivers the tag; the Release is a separate object that has to be created on `/releases`. Early on I did both for every version (v1.1.0–v1.6.4 all have releases); from v1.6.5 I only did the first, for fourteen versions running.

**Nothing announces this kind of omission.** Every tag was present locally, every `git push` succeeded, every CI run was green. The two look identical from a working copy — the difference is only visible on the releases page, which nobody visits daily. So this is not "forgot"; it is that **no part of the process was capable of reporting it**. All fourteen are backfilled now (bilingual notes as the body, the notes' H1 as the title, matching how the earlier ones were written), and `latest` is v1.9.2.

**To stop it recurring:** `tools/publish-release.mjs` turns the last step into one command (idempotent, with `--check` and `--all`); `RELEASING.md` writes the five steps down and says why step five is a script rather than a habit; and `test/release-consistency.mjs` makes the locally decidable half of it a test — both version strings agreeing, notes existing for the current version, every notes heading starting with its own version, every notes file bilingual, every version tag having notes, and the process doc and script existing. Whether a Release *exists* needs the network, which `npm test` must not require, so `--check` covers that half; together they span the chain.

**A different lesson from the previous rounds.** Those were wrong assumptions in *code* (the data contract, which object owns `loadOlder`, the sliding-window judgement). This one was a wrong assumption in the *process*: that pushing a tag was shipping. Same shape though — two things that look alike are not alike, and nothing signals the difference. For that shape the only real defence is not a reminder in the docs but turning the last step into a command and making consistency a check that can go red.
