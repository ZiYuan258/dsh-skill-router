# v1.18.0 — 架构澄清版：决策记录 + phase-2 归档

[English](#english) | 中文

**不改任何运行代码。** 这一版只做三件事：把结论写下来、把实验代码归档、
把版本号推上去。目的是让未来的读者（或半年后的自己）一眼知道这个插件为什么
存在、哪些部分被证明有效、哪些被证明无效。

## 改了什么

### 1. 新增 `DECISION.md`

一份架构决策记录（ADR），记录"自动技能路由"假设被实验否定、最终架构定为
"技能发现 + 按需加载"的完整推理过程。含：

- 三个候选方案（全常驻 / 库+检索 / 自动注入）及取舍
- 三条证据线（discovery 注入实验 45 vs 181、phase-2 四臂 A/B/C/D、132 转录普查）
- 最终架构图（常驻目录 + 冷库 + 模型自主选择）
- 未来方向（metadata index / quality ranking）与不做项（embedding / 自动注入）

### 2. phase-2 实验测试归档至 `experimental/phase2/`

- `test/phase2-control.mjs` → `experimental/phase2/phase2-control.test.mjs`
- `test/phase2-conditions.mjs` → `experimental/phase2/phase2-conditions.test.mjs`
- 新增 `experimental/phase2/README.md`：说明这是历史实验、结论是什么、怎么复现
- `phase2-control.js` 加了文件头注释标明是实验代码、默认惰性
- `package.json` 测试脚本路径同步更新

运行时支持代码（`phase2-control.js`、`discovery.js`）保留在仓库根目录——
`host.js` 导入它们，但它们在 env flag 后面，默认不激活。

### 3. 版本 1.17.3 → 1.18.0

`package.json` + `client.js` + README 版本示例同步。

## 没改什么

- `host.js` 行为逻辑 — 不动
- 搜索算法 — 不动
- 注入 flag — 不动（仍是 `DSH_SKILL_ROUTER_INJECT_TIERS=HIGH` 重开，默认关）
- phase-2 runner — 不动

---

## English

**No runtime code changes.** This release does three things: records the
decision, archives the experiment code, and bumps the version. The goal is to
make it clear to future readers why this plugin exists, what works, and what
does not.

### What changed

1. **`DECISION.md`** — an Architecture Decision Record documenting why automatic
   skill routing was rejected and why the final architecture is "discovery +
   on-demand loading." Includes three evidence lines (discovery injection
   experiment, phase-2 four-arm, 132-transcript census).

2. **Phase-2 experiment tests archived** to `experimental/phase2/` with a README
   explaining the experiment, its conclusion, and how to reproduce. Runtime
   support code stays in root (imported by `host.js`, gated behind env flags).

3. **Version 1.17.3 → 1.18.0** in `package.json`, `client.js`, and READMEs.

### What did not change

- `host.js` behavior, search algorithm, injection flag, phase-2 runner — all
  untouched. This is a documentation and organization release, not a feature
  release.
