# v1.1.0 — first public release

A DeepSeek Harness **Host plugin** that adds two tools, `skill_search` and `skill_load`, so an agent can find and load any skill from a staged library instead of paying for every skill in the session catalog.

## Install

```sh
# from git (recommended)
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# or from the tarball attached to this release
dsh plugin --profile <profile> add /path/to/dsh-skill-router-1.1.0.tgz
```

Restart DSH once, then confirm `skill_search` and `skill_load` appear in the tool list.

No registry publication: DSH composes a plugin from any package it can resolve, so a git URL or a local path is enough. The package is `private: true` on purpose.

## What it does

| Tool | Purpose |
|---|---|
| `skill_search` | AND-ed keyword lookup over a staged index (skill name / description / upstream repo), returning names, repos, a duplicate count and absolute `SKILL.md` paths |
| `skill_load` | Loads one or more skill bodies into context as `<skill_content>` blocks with their base directories, so `scripts/`, `references/` and `assets/` resolve correctly |

The index is `<workspace>/.skill-src/skill-index.tsv` (`repo`, `relpath`, `name`, `description`, `files`, `KB`), located by walking up from the session working directory — nothing is hard-coded to a drive or path. The README documents the columns and includes a reference generator.

## Highlights

- **Zero dependencies, zero imports.** No `node_modules`, nothing to install, no build step.
- **Zero catalog cost.** The tools are a few hundred characters of schema; the library is never injected.
- **Agent-driven selection.** The routing rules live in the tool descriptions, so the model decides which skills to use — the user is not asked to pick.
- **Robust batch loading.** `skill_load` accepts a real array, a JSON-encoded array, or a comma/newline-separated string, because array arguments can arrive stringified.
- **Deterministic duplicate handling.** `skill_search` reports `copies`, `skill_load` takes `repo` to disambiguate, and without a hint the shallowest path wins — a `repo` filter matching nothing says which repos do have the skill instead of silently falling back.

## Two bugs this release fixes, each with a regression test

An earlier local build took the DSH host down at startup. A dev-only stub in the package's own `node_modules` shadowed `@deepseek-ai/dsh-tools`, so the author DSL (`output.schema: { type: 'json' }`) reached the tool registry uncompiled and the whole plugin tree refused to load:

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

Definitions are now built locally in standard JSON Schema, and `test/boot-safety.mjs` fails if the package ever ships a `node_modules` or declares a DSH host package as a dependency again.

The second: `skill_load` originally accepted `name` as `oneOf: [string, array]`, which reads well and fails in practice — a stringified array quietly became one nonexistent skill name.

## Tests

```sh
npm test
```

Six dependency-free scripts. They run against a real staged library when one is reachable and otherwise generate a throwaway fixture, so this tarball is self-testing. CI runs them on Node 20, 22 and 24 with no install step.

## Requirements

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`
