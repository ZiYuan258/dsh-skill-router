# v1.5.0 — 安全政策

[English](#english) | 中文

新增 `SECURITY.md` / `SECURITY.zh.md`：把威胁模型写成**对代码的可核查事实**，而不是愿望。

**文档：** [中文（默认）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md) | [安全政策](https://github.com/ZiYuan258/dsh-skill-router/blob/main/SECURITY.zh.md)

## 政策写了什么

**1. 插件不可能做什么**（逐条对应代码，不是承诺）：

没有 `eval`、没有 shell、没有网络、不写文件、不读 `process.env`。`ctx.fs` 只调用
`resolve` / `stat` / `readText` / `listDir`。因此它带来的全部风险都来自**它读了哪些文件**。

**2. 真正的信任边界是内容。** 技能正文是**不可信输入**，模型可能把它当指令——这正是 SKILL.md 的用途。
插件的职责是**来源透明**（`<skill_content>` 包裹、`source`、`repo`、绝对 `path`、base directory），
而不是沙箱化它无法判断的内容。政策明确写了**不做**模式扫描，因为那只会给出虚假的安全感。

**3. 路径包含性的已知局限。** 包含性校验是**词法**的，不感知符号链接——技能目录里若有指向库外的链接，
读取会跟随它。参考库中符号链接数为 **0**，所以这目前是理论风险；写下来而不是留作隐含。

**4. 供应链约束。** 零导入、发布包内无 `node_modules`、`@deepseek-ai/*` 永远不得出现在 `dependencies`
（由 `boot-safety.mjs` 强制）、从 GitHub 分发且 tarball 挂在 tag 上。

**5. 未经审阅不会加入的功能清单**：执行技能内容、任何网络访问、安装技能、把库内容发往本机之外、
以及把"扫描危险模式"当作安全保证。记下来是为了让将来的改动必须**明确反驳**它们。

## 数字是实测的，不是断言的

政策里的统计来自对 **1025 个 `SKILL.md`** 的扫描：**3 个**在代码块内含 `curl … | sh`、**10 个**含
`rm -rf`、**50 个**读环境变量、**4 个**在叙述里出现 "ignore previous instructions"（全部位于讲解攻击
手法的安全文档内）、**0 个**含零宽字符或隐藏指令。

复核脚本已固化：`node tools/audit-library-risk.mjs`，库变了可重跑，结论可重新推导。

## 双语保证扩大到全部文档对

`docs-parity.mjs` 从"两份 README"扩展为"**每一对双语文件**"：README 对、SECURITY 对、以及发布说明。
它同时钉住语言切换行的位置与"中文在前"。`release-notes.mjs` 已并入其中——把发布说明检查两遍对谁都没好处。

## 测试

11 个脚本（合并了一项重复检查）。文档一致性检查从 1 对扩到 3 组。

## 环境要求

- DSH `>= 0.1.5-rc.1`（已验证下限）
- Node `>= 20.18.0`

---

## English

Adds `SECURITY.md` / `SECURITY.zh.md`: the threat model written as **checkable facts about the code** rather than as aspirations.

**Documentation:** [中文（default）](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.en.md) | [Security policy](https://github.com/ZiYuan258/dsh-skill-router/blob/main/SECURITY.md)

### What the policy says

**1. What the plugin cannot do** (each mapped to the code, not to a promise): no `eval`, no shell, no network, no writes, no `process.env`. The only `ctx.fs` calls are `resolve`, `stat`, `readText` and `listDir`. Every risk it carries therefore comes from **which files it reads**.

**2. The real trust boundary is the content.** A skill body is **untrusted input** and the model may treat it as instructions — that is what a SKILL.md is for. The plugin's job is **provenance** (the `<skill_content>` wrapper, `source`, `repo`, absolute `path`, base directory), not sandboxing content it cannot judge. The policy states explicitly that it does **not** pattern-scan, because that would give false assurance.

**3. The known limitation of path containment.** The check is **lexical**, not symlink-aware: a link inside a skill directory pointing outside the library would be followed. The reference library contains **zero** symlinks, so this is theoretical today — written down rather than left implicit.

**4. Supply-chain constraints.** Zero imports, no `node_modules` in the published package, `@deepseek-ai/*` may never appear in `dependencies` (enforced by `boot-safety.mjs`), and distribution is from GitHub with the tarball attached to a tag.

**5. A list of features that will not be added without review:** executing skill content, any network access, installing skills, sending library content off the machine, and pattern scanning presented as a security guarantee. The list exists so a future change has to argue against them explicitly.

### The numbers are measured, not asserted

The policy's figures come from scanning **1025 `SKILL.md` files**: **3** hold `curl … | sh` inside a code block, **10** hold `rm -rf`, **50** read environment variables, **4** mention "ignore previous instructions" in prose (all inside security write-ups), and **0** contain zero-width or hidden-instruction characters.

The audit is a script — `node tools/audit-library-risk.mjs` — so the claims can be re-derived after the library changes.

### The bilingual guarantee now covers every document pair

`docs-parity.mjs` grew from "the two READMEs" to "**every bilingual pair**": the README pair, the SECURITY pair, and the release notes. It also pins the switcher line and that the Chinese side leads. `release-notes.mjs` is folded into it — checking the release notes twice helped nobody.

### Tests

11 scripts (one duplicate check merged away). Documentation consistency went from one pair to three groups.

### Requirements

- DSH `>= 0.1.5-rc.1` (verified floor)
- Node `>= 20.18.0`
