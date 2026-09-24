# Security policy

[中文](SECURITY.zh.md) | English

## Scope

This policy covers **the `dsh-skill-router` plugin**: its source, its published releases, and the artifacts attached to them.

It does **not** cover the skill libraries the plugin reads. Those are third-party content, and what they may instruct a model to do is their authors' responsibility and yours to review — see [Untrusted content](#untrusted-content-is-the-real-boundary) below.

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository: *Security* → *Report a vulnerability*. That keeps the report private until a fix ships.

Please include what you did, what happened, and what you expected. A minimal reproduction against the fixture library (`npm test` builds one) is worth more than a description.

There is **no SLA and no bounty**. This is a personal project maintained on a best-effort basis; the honest commitment is that a report will be read and answered.

## What the plugin does — and therefore what it cannot do

Stated as facts about the code, so the policy is checkable rather than aspirational:

| Property | Status | How it is enforced |
|---|---|---|
| Executes code from a skill | **Never** | No `eval`, no `new Function`, no child process anywhere in `host.js` or `client.js` |
| Runs a shell or any command | **Never** | No `ctx.shell`, no `subprocess`, no `bash` |
| Makes network requests | **Never** | No `ctx.web`, no `fetch`, no HTTP client in either half |
| Writes, deletes or renames anything | **Never** | The only `ctx.fs` calls are `resolve`, `stat`, `readText`, `listDir` |
| Installs or removes skills | **Never** | It reports paths; installation is a separate `dsh plugin` / your script |
| Sends data anywhere | **Never** | Nothing leaves the process; there is no telemetry |
| Reads credentials or environment variables | **Never** | No `process.env` access; `process` is not even available in the dynamic-plugin sandbox |
| Touches the page DOM | **Two calls, both reversible** | `client.js` does only `document.createElement('style')` and `document.head.appendChild` (removed again on unload). It queries and modifies no product-owned DOM node |

In short: the plugin is a **read-only index lookup plus file reader**, with a read-only Client tab on top. Every risk it carries comes from *which files it reads* and *what the model then does with their contents*.

### What the Client half reads

The usage tab's **entire** input is the `useChat` seat the slot hands the component: it reads `legacy.nodes`, takes those whose `kind` is `assistant`, and from their `blocks` reads only the scalar leaves `kind`, `name` and `arguments` — enough to tell which tool ran and what the skill was called. It copies no node, serializes no node, and sends conversation content nowhere; **nothing reaches the model's context**. The Client half imports no package either (React is supplied by the host), so there is no supply chain to speak of.

## Untrusted content is the real boundary

A skill library is **untrusted input**. When a skill body reaches the model's context, the model may treat it as instructions — that is the entire point of a SKILL.md — so a malicious skill is a prompt-injection vector, and a skill containing `curl … | sh` is an offer the model may accept.

The plugin's job is to be **transparent about provenance**, not to sandbox content it cannot judge:

- Loaded text is wrapped in `<skill_content name="…" source="…">` so it is distinguishable from user messages.
- Every hit and every load reports `source` (`library` or `resident`), the upstream `repo`, and the absolute `path`.
- The tool card prints the base directory, so any script a skill references is visible as a path before anything is executed.

What the plugin deliberately does **not** do: scan skill bodies for dangerous patterns, or block content. A reviewer who needs that should read the files themselves; a keyword scanner would give false assurance without stopping a determined injection. Measured on the reference library (1025 `SKILL.md` files): 3 contain `curl … | sh` inside a code block, 10 contain `rm -rf`, 50 contain environment-variable reads, and none contain zero-width or hidden-instruction characters. Those are not defects in the library — they are what a library of real engineering skills looks like, and they are why **you** review what you install.

## Path containment

`skill_ref` resolves a requested path and refuses anything outside the skill's own directory, **before any I/O happens** — the check is pure string work on a normalized path, so a `../` traversal never reaches the filesystem.

- `resolvePath` is exported and unit tested directly (`test/skill-ref.mjs`), because a containment rule that is only tested through the tool is a rule that can silently stop holding.
- **Known limitation:** containment is lexical, not symlink-aware. If a skill directory contains a symlink pointing outside the library, a read through it would follow the link. The reference library contains zero symlinks, so this is theoretical today; it is stated here rather than left implicit. A fix would resolve links before comparing — worth doing if you maintain a library that uses them.

## Supply chain

- **Zero dependencies and zero imports.** `host.js` imports nothing at all; there is no `node_modules` in the published package and no build step.
- **No DSH host package may be declared as a dependency.** `test/boot-safety.mjs` fails the build if `dependencies`, `optionalDependencies` or `peerDependencies` ever name an `@deepseek-ai/*` package. This is not style: a pinned copy is how the host's own modules get shadowed, and a shadowed `@deepseek-ai/dsh-tools` once took the entire host down at startup.
- **Distributed from GitHub, not a registry.** The package is `private: true`; releases are git tags with an attached tarball. Installing pins to a tag or commit of your choosing, which you can read in full before adding it to a profile — the package is small enough to audit in one sitting.
- **CI runs the full suite** on Node 20/22/24 for every push, with no install step (there is nothing to install), so the tested artifact is exactly the published source.

## What will not be added without review

These are recorded so that a future change has to argue against them explicitly, rather than slipping in as a convenience:

1. executing any content from a skill;
2. network access of any kind;
3. installing, deleting or modifying skills;
4. sending library content anywhere off the machine;
5. scanning skill bodies for "dangerous" patterns as a security guarantee.

(4) and (5) are the ones most likely to be proposed as features. (5) in particular would make the plugin look safer while changing nothing about the actual trust decision.

## Supported versions

The latest release. Fixes land on `main` and in a new tag; older tags are not back-ported.
