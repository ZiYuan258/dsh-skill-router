# v1.5.2 — 修掉上一版自己引入的 CI 失败，并移除一个已经失效的本地工具

[English](#english) | 中文

这一版有三个来源：上一版新加的测试在 CI 上崩了、文档里留着作者本机的实名路径、以及一个只对作者机器有意义的工具还在仓库里。

## 修复：`workflow-config.mjs` 在 CI 上 ENOENT

上一版新增的 CI 配置检查写死了 `C:/Users/21450/dsh-plugins/dsh-skill-router/.github/workflows`。在作者机器上它"恰好"通过（工作目录正好是那个包），在 GitHub 的 `/home/runner` 上第一步就崩：

```
Error: ENOENT: no such file or directory, scandir 'C:/Users/.../.github/workflows'
```

现在路径相对检查脚本自身解析（`new URL('../.github/workflows/', import.meta.url)`），已验证从包目录和 `%TEMP%` 两处运行都通过。**这类错误在同一批改动里已经出现过四次**，所以下面多了一个专门扫描它的测试。

## 新增：`test/no-local-paths.mjs`

扫描仓库里所有可执行文件与配置（`.mjs` `.js` `.cjs` `.json` `.yml` `.yaml` `.ps1` `.sh`），找出本机绝对路径（`C:\Users\…`、`/home/<user>/…`）。

**Markdown 有意排除在外**：README 里的 Windows 路径是"把库放在这里"的示范，不是本机耦合。第一版连文档一起扫，报出 16 条，没有一条是真问题——检查器沦为噪音的典型方式。

## 文档：示例路径改为占位符

README 双语的示例改用 `<你的工作区>` / `D:\work`，不再出现作者的实际工作区名。示例是给读者的模板，写具体到某个人的路径会让读者误以为要照抄。

## 移除：`tools/sync-host.mjs` 与 `sync:host` / `check:host`

v1.2.0 加它是为了解决当时真实存在的问题：`host.js` 在**已部署的包**和**开发检出**两处被同时编辑，静默分叉。现在开发检出已删除，包是唯一真源，工具失去存在理由。

更要紧的是它的失败方式：默认目标是作者机器上的固定路径，那个目录不存在时 `npm run check:host` 直接退出 1。**一个开箱即坏的命令比没有这个命令更糟**——它会把"环境已变"伪装成"仓库有问题"。v1.2.0 的发布说明保留原样（那是历史记录），但工具本身不再随包发布。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

## 测试

十三个（原十二个 + `no-local-paths.mjs`），CI 在 Node 20 / 22 / 24 上全绿。

---

## English

This release has three sources: a test added in the previous version crashed on CI, the docs carried the author's real machine paths, and a tool that only meant something on the author's machine was still in the repo.

### Fixed: `workflow-config.mjs` ENOENT on CI

The CI-config check added last version hardcoded `C:/Users/21450/dsh-plugins/dsh-skill-router/.github/workflows`. On the author's machine it "passed" by accident (the working directory happened to be that package); on GitHub's `/home/runner` it died on the first step:

```
Error: ENOENT: no such file or directory, scandir 'C:/Users/.../.github/workflows'
```

The path is now resolved relative to the checking script itself (`new URL('../.github/workflows/', import.meta.url)`), verified passing from both the package directory and `%TEMP%`. **This class of mistake had already appeared four times in the same batch of changes**, hence the dedicated scanner below.

### New: `test/no-local-paths.mjs`

Scans every executable file and config in the repo (`.mjs` `.js` `.cjs` `.json` `.yml` `.yaml` `.ps1` `.sh`) for machine-specific absolute paths (`C:\Users\…`, `/home/<user>/…`).

**Markdown is deliberately excluded**: a Windows path in the README is a demonstration of where to put the library, not machine coupling. The first version scanned the docs too and reported 16 hits, none of them real — the classic way a checker becomes noise.

### Docs: example paths are now placeholders

The bilingual README examples use `<your-workspace>` / `D:\work` instead of the author's actual workspace name. An example is a template for the reader; hardcoding one person's path invites them to copy it literally.

### Removed: `tools/sync-host.mjs` and `sync:host` / `check:host`

v1.2.0 added it for a real problem at the time: `host.js` was being edited in two places at once — the deployed package and a dev checkout — and diverged silently. That dev checkout is gone, the package is the single source of truth, and the tool lost its reason to exist.

Its failure mode matters more: it defaulted to a fixed path on the author's machine, so with that directory absent `npm run check:host` exited 1. **A command that is broken out of the box is worse than no command** — it disguises "the environment moved" as "the repo is wrong". The v1.2.0 release notes stand as written (they are a historical record); the tool itself no longer ships.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`

### Tests

Thirteen (twelve plus `no-local-paths.mjs`), green on Node 20 / 22 / 24.
