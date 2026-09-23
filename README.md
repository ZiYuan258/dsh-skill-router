# dsh-skill-router

A DeepSeek Harness **Host plugin** that adds two tools — `skill_search` and `skill_load` — so an agent can pick its own skills from a library instead of paying for every skill on every turn.

- **Zero dependencies.** No `import` of any kind, no `node_modules`, nothing to install.
- **Zero catalog cost.** The tools cost a few hundred characters of schema; the library itself is never injected.
- **Agent-driven selection.** The routing rules live in the tool descriptions, so the model decides — the user is not asked to pick.

## Why this exists

DSH injects the session skill catalog into **every** model request (`dsh-tool-skill` emits a `source.kind='skill-catalog'` user message from its `agent/pre-step` listener). So every resident skill is a recurring token cost, which pushes people to keep the resident set small.

But the catalog is also the model's **only** skill entry point: the built-in `skill` tool resolves names through `ctx.skills.list()`, which only knows what the filesystem providers discovered. Anything outside those roots is invisible to the model — a staged library of 1000+ skills may as well not exist.

This plugin closes that gap. Skills you want auto-triggered stay resident; everything else stays in the library and costs nothing until the moment it is used.

## Install

Requires a DSH installation (`dsh >= 0.1.5-rc.1`) and a profile. `dsh plugin` forwards to `pnpm` in the profile directory and reconciles the bundle list.

```sh
# from git (recommended)
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# or from a downloaded release tarball / checkout
dsh plugin --profile <profile> add /absolute/path/to/dsh-skill-router
```

Restart DSH once. Then check the tool list: `skill_search` and `skill_load` should both be present.

Uninstall:

```sh
dsh plugin --profile <profile> remove dsh-skill-router
```

> **No registry publication.** DSH composes a plugin from a package it can resolve, and a
> GitHub or local install is enough — this package is therefore `private: true`, and
> `dsh plugin add github:…` is the canonical path. Release tarballs are attached to
> [GitHub releases](https://github.com/ZiYuan258/dsh-skill-router/releases) for offline or
> air-gapped installs.

### What the plugin needs from your setup

A **skill index** describing the library. The plugin reads `<workspace>/.skill-src/skill-index.tsv` — a tab-separated file with the header `repo`, `relpath`, `name`, `description`, `files`, `KB`, where each row points at `<root>/<repo>/<relpath>/SKILL.md`.

The plugin walks up from the session working directory (up to 8 levels) to find it, so nothing is hard-coded to a drive or path. If the file is missing, both tools report exactly that and tell you which directory they searched.

There is nothing magic about the writer — any script that emits those columns works. A reference generator (PowerShell, for a library of upstream repos checked out under one directory) looks like:

```powershell
$rows = Get-ChildItem $root -Directory | ForEach-Object {
  $repo = $_
  Get-ChildItem $repo.FullName -Recurse -File -Filter 'SKILL.md' | ForEach-Object {
    $text = Get-Content $_.FullName -Raw
    $name = ''; $desc = ''
    if ($text -match '(?s)^\uFEFF?---\s*\r?\n(.*?)\r?\n---') {
      $fm = $Matches[1]
      if ($fm -match '(?m)^name:\s*(.+?)\s*$') { $name = $Matches[1].Trim() }
      if ($fm -match '(?ms)^description:\s*(.+?)(?=\r?\n[a-zA-Z_-]+:\s|\z)') {
        $desc = ($Matches[1] -replace '\s+', ' ').Trim() -replace '^[>|][+-]?\s*', ''
      }
    }
    [pscustomobject]@{
      repo = $repo.Name
      relpath = $_.Directory.FullName.Substring($repo.FullName.Length).TrimStart('\')
      name = $name; description = $desc
      files = 1; KB = [math]::Round($_.Length / 1KB)
    }
  }
}
$rows | Export-Csv -Path (Join-Path $root 'skill-index.tsv') -Delimiter "`t" -NoTypeInformation -Encoding UTF8
```

Emit it with a real CSV writer (`Export-Csv`, `csv.writer`, …). Hand-joining columns with tabs breaks on any description that contains a tab, a quote or a newline — the reference generator above needed a fix for exactly that.

## Tools

### `skill_search`

Find a skill. Keywords are lowercased and **AND**-ed across the skill name, its description and its upstream repo.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | e.g. `"kubernetes helm"`, `"remotion video"` |
| `limit` | integer | 1–40, default 12 |
| `repo` | string | case-insensitive filter on the upstream directory name |
| `names_only` | boolean | names and repos only, no descriptions |

Returns `total`, `shown`, `more`, and per hit: `name`, `repo`, `description` (truncated to 220 chars for display), `copies`, `files`, `path`, `libraryRelative`.

### `skill_load`

Load the full instructions of one or more skills.

| Parameter | Type | Notes |
|---|---|---|
| `name` | string | one skill name; a full path to a `SKILL.md` also works |
| `names` | string | several names in one call, separated by commas or newlines |
| `repo` | string | upstream repo filter, applied to every name in the call (see below) |

Returns `requested`, `loaded`, `failed`, and a `skills[]` array of `{ name, source, repo, copies, path, resourceDir, content, referenceFiles, error }`. The tool card renders each skill as a `<skill_content>` block followed by its base directory, so relative paths (`scripts/`, `references/`, `assets/`) resolve correctly.

Lookup order: **library first, then the resident catalog** (`ctx.skills`). The `source` field says which one won.

Limits: 8 names per call, 120 000 characters per skill body, 8 bundled entries listed.

## Design notes

**Why `name` and `names` instead of an array.** An earlier version declared `name` as `oneOf: [string, array]`. That reads well in a schema and fails in practice: array arguments can arrive at the tool **stringified**, so `["gh-cli"]` lands as the literal string `'["gh-cli"]'`, matches the string branch, and is treated as one nonexistent skill name. The current implementation accepts all three shapes anyway — a real array, a JSON-encoded array, and a comma/newline-separated string — because robustness here should not depend on how the transport serializes arguments.

**Why nothing is imported.** A previous version imported `defineTool` from `@deepseek-ai/dsh-tools`. Node resolves a bare specifier from the importing package first, so a stray dev shim in the package's own `node_modules` shadowed the real package, the author DSL (`output.schema: { type: 'json' }`) reached the registry uncompiled, and the **entire plugin tree failed to load**:

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

This plugin therefore ships **no `node_modules` and no dependencies**, and builds its tool definitions locally in standard JSON Schema, so they are valid whether or not the runtime compiles schemas. `test/boot-safety.mjs` enforces both rules.

**Duplicate names.** Libraries assembled from several upstream repos often carry the same skill name more than once — one popular repo publishes every skill under `skills/`, `plugins/<name>/skills/` *and* `antigravity/skills/`. `skill_search` reports `copies` so the ambiguity is visible, `skill_load` accepts `repo` to disambiguate, and without a hint it picks deterministically (shallowest path wins). A `repo` filter that matches nothing reports which repos do have the skill instead of silently falling back.

## Tests

```sh
npm test
```

Six dependency-free scripts. They run against a real staged library when one is reachable and otherwise **generate a throwaway fixture** in the OS temp directory, so a bare clone can test the plugin:

| Script | Covers |
|---|---|
| `boot-safety.mjs` | no shadowing `node_modules`, no DSH host package in `dependencies`, schemas valid in the registry's enforced subset |
| `schema-forms.mjs` | which `output.schema` literal survives registration, and that the author DSL fails |
| `shape.mjs` | parameter shapes and the routing wording in the tool descriptions |
| `verify.mjs` | end-to-end search + load behaviour |
| `collisions.mjs` | duplicate-name resolution and `repo` hints |
| `batch.mjs` | every transport shape for a multi-skill request |

Point them at a specific library with `SKILL_LIBRARY_ROOT=/path/to/workspace`.

## Layout

```
host.js              the plugin: apply(), buildSkillRouterTools(), definePortableTool()
cordis.patch.yml     the composed row (id: skill-router, name: dsh-skill-router)
test/                six runs, plus a dev-only stand-in for @deepseek-ai/dsh-tools
.github/workflows/   CI: npm test on Node 20 / 22 / 24
```

## License

MIT
