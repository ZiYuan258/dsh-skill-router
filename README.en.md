# dsh-skill-router

English | [中文](README.md)

A **Host plugin** for DeepSeek Harness. It adds three tools — `skill_search`, `skill_load`, `skill_ref` — so an agent can find and load a skill from a library on demand.

> **Only a dozen or two skills? This plugin is not for you.**
> A single task usually uses just a few skills, so **when the set is small, keeping them resident is cheaper** — the catalog is DSH's native mechanism and it works. This plugin addresses the other situation: **more skills than will fit in the catalog.**

## Do you need it

Two questions decide it: **how big is the library**, and **how many does one task use**.

| Your situation | What to do |
|---|---|
| Fewer than ~30 skills | **Not needed.** Keep them all resident; the catalog stays cheap and the built-in `skill` tool works |
| Tens to hundreds, a few per task | **The typical case.** Keep the frequent dozen resident; the rest live in the library |
| Several upstream repos, a thousand-plus skills | **Where it matters most.** All-resident is infeasible (1000 entries ≈ 150k characters per turn) but you do not want to lose access to any of them |
| A small library, but you want skills to trigger automatically | **Not needed.** That is pre-step routing, a different kind of plugin |

In one line: **it is built for "a big library, a few skills per task".** If you already keep your frequently used skills resident, its value is negative — you are paying for tool schemas and getting nothing back.

## The technical problem it solves

DSH injects the session skill catalog into **every** model request (`dsh-tool-skill` emits a `source.kind='skill-catalog'` user message from its `agent/pre-step` listener). Therefore:

- **Resident count costs continuously**: every resident skill adds its name and description to **every turn**. A thousand skills ≈ 150k characters per turn, whether or not they are relevant.
- **But the catalog is the model's only entry point**: the built-in `skill` tool resolves names through `ctx.skills.list()`, which only knows the roots the filesystem providers scanned. Anything outside those roots **does not exist** for the model — a library of 1000+ skills may as well be empty.

That leaves two options: **put everything in the catalog (expensive every turn)** or **leave everything outside it (unreachable)**. This plugin offers a third: the library stays outside, and the agent **searches and loads it itself** when a task calls for it. The cost moves from "per turn, fixed" to "only when used".

## Cost (measured, not estimated)

Tool-driven retrieval is not free. It costs in two places:

| Cost | Measured | Nature |
|---|---|---|
| Resident tool schemas | **3,603 B ≈ 1,001 tokens/turn** | **Fixed**, independent of library size — the essential difference from catalog injection |
| One search round-trip | one tool call + about **1,533 B ≈ 426 tokens** (`limit=12`) | On demand; the extra step compared with picking from an injected catalog |

For scale: a 28-skill resident catalog measured **1,541 tokens/turn**. Swapping 1,541 + 3,603 B for "six resident plus the tools" is where the arithmetic works — which is why **a small library should not use this** (see the section above).

Two ways to cut the round-trip: **lower `limit`** (or `names_only: true`, roughly 60% smaller), and **call `skill_load` directly when the name is known**, skipping search.

## How it works

### Data flow

```
user message
   │
   ├─ resident skills (native DSH)      ← catalog injected every turn, auto-triggered
   │
   └─ library skills (this plugin)
        the model decides it needs specific knowledge
          │
          ├─ skill_search  ← keyword lookup over the index (reads no skill body)
          │     returns: name / repo / copies / absolute path
          │
          ├─ skill_load    ← loads only the chosen ones as <skill_content> + base directory
          │
          └─ skill_ref     ← reads one bundled references/ or scripts/ file, on its own
```

The key property: **search and load are separate**. `skill_search` only queries the index and never reads a skill body; `skill_load` reads only what you named. Searching 12 hits therefore costs metadata, and only the loaded skills cost their text.

### The index is a contract, not a cache

The plugin reads `<workspace>/.skill-src/skill-index.tsv` — tab-separated, one row per skill:

| Column | Required | Meaning |
|---|---|---|
| `repo` | yes | upstream directory name, used for disambiguation and filtering |
| `relpath` | yes | path under that repo; with `repo` it locates the `SKILL.md` |
| `name` | yes | the skill name, and the key `skill_load` takes |
| `description` | yes | the retrieval corpus, and the text shown to the model |
| `files` | no | how many files the skill directory holds |
| `KB` | no | size |
| `whenToUse` | no | trigger phrasing, scored above the description (0 of 1025 `SKILL.md` files in the reference library carry it — absent is normal) |

Why TSV rather than YAML or JSON: the index is machine-generated, and TSV has the least structural ambiguity — whereas YAML is exactly what this project was bitten by in practice (a frontmatter block scalar `>-`/`|-` leaks its marker into the description). The parser is hand-written, because the plugin has zero imports and cannot use `node:path` or a CSV library; it follows CSV quoting rules, and it finds the header **by shape** rather than by literal text, so adding a column never breaks an existing file: **a 6-column index keeps working, and a missing column reads as an empty string**.

The index is located by walking up to 8 levels from the session working directory, so no drive or path is hard-coded. When it is absent, the tools say so and list where they looked.

### Retrieval: weighted AND with an honest fallback

Scoring accumulates per keyword. The weight order reflects information density:

| Field matched | Weight | Reason |
|---|---|---|
| `name` | **+100** | the skill name is the strongest signal |
| `whenToUse` | **+40** | trigger phrasing by definition |
| `description` | **+24** | descriptive prose |
| `path` (`repo/relpath`) | **+6** | weak, but it rescues "find by repository" queries |
| exact name equality | **+400** | an exact hit dominates |

Sort order: all-keywords-match → matched-keyword count → score → name hits → name length → lexicographic (deterministic: the same query always yields the same order).

The default is **strict AND**. When AND returns nothing and there is more than one keyword, the search retries as a **partial match** and sets `fallback: "or"`, labelling each hit with its `matchCount` — **a near-miss is never dressed up as a real hit** — and a single-keyword query never falls back, because there is nothing to degrade to.

With `explain: true` the score breakdown shows why something did or did not match:

```
- beta-gadgets  [beta-skills]
    why: widgets: -; beta: +130 (name+description+path)
```

### Duplicates: determinism over guessing

Libraries assembled from several upstreams carry the same name more than once — one repo publishes every skill under `skills/`, `plugins/<name>/skills/` *and* `antigravity/skills/` (the reference library holds **5 copies** of `test-driven-development`).

The handling: `skill_search` reports `copies`, making the ambiguity **visible**; `skill_load` accepts `repo` to disambiguate; with no hint it picks deterministically (**shallowest path wins**, so `skills/<name>` beats `plugins/<x>/skills/<name>`); and a `repo` filter that matches nothing **lists the repos that do have the skill** instead of silently falling back to another.

### Lookup order and limits

`skill_load` searches the library (`.skill-src`) first, then the resident catalog (`ctx.skills`); the `source` field says which won. Limits: 8 names per call, 120,000 characters per skill body, 8 bundled entries listed. An oversized body is truncated **and reported** (`truncated: true`, plus the original length and the path to read in full) rather than silently shortened.

### Path containment

`skill_ref` runs a containment check on the normalized path **before any I/O**, so `../` never reaches the filesystem. Known limitation: the check is **lexical** and not symlink-aware (the reference library has zero symlinks, so this is theoretical today). `resolvePath` is exported and **unit tested directly** — a security rule verified only through the tool is a rule that can quietly stop holding.

## Install

Requires a DSH installation and a profile. `dsh.engines.dsh` declares `>=0.1.5-rc.1` — that is the **verified** floor, not a claim that newer is required: the plugin uses only `ctx.tools.register` and `ctx.fs.*`, with no event hooks and no imports. Older versions have not been verified, and **over-claiming compatibility would be worse than being conservative**. `ctx.get`, `ctx.effect` and `ctx.skills` are all **optional** and degrade rather than crash when absent, which `test/minimal-host.mjs` pins.

```sh
# from git (recommended)
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router

# or from a downloaded release tarball / checkout
dsh plugin --profile <profile> add /absolute/path/to/dsh-skill-router
```

Restart DSH once, then confirm all three tools appear in the tool list. Uninstall:

```sh
dsh plugin --profile <profile> remove dsh-skill-router
```

> **No registry publication.** DSH composes a plugin from any package it can resolve, and a git URL or local path
> is enough — so this package is `private: true`. Release tarballs live on
> [GitHub releases](https://github.com/ZiYuan258/dsh-skill-router/releases) for offline installs.

### ⚠️ Check the name first: several repositories share it

At least eight repositories are called `dsh-skill-router`, so installing the wrong one gets you a different plugin:

| | This repository | The other family (e.g. `MJorgin/dsh-skill-router`) |
|---|---|---|
| Install command | `github:ZiYuan258/dsh-skill-router` | `github:akqwpeter-prog/dsh-skill-router` (that repo was renamed; the command is stale) |
| Mechanism | **tool-driven**: the model calls `skill_search` / `skill_load` / `skill_ref` | **pre-step routing**: reads each user message and pours matched skills in |
| Problem it solves | library skills are **invisible to the model** | the model **does not use a skill it should have** |
| Dependencies | zero dependencies, zero imports | varies; some need an LLM judge or embeddings |

The two are **not competitors and can be stacked** — they work at different layers. Check that the owner is `ZiYuan258` before installing.

> If a tool reports this repository as unreachable, check which kind of failure it is: GitHub rate-limits
> **unauthenticated API** calls to 60/hour and answers `403 API rate limit exceeded`, while the web page and raw
> files keep working — and `dsh plugin add` uses those.

## Usage

### 1. Where the library lives

The plugin walks up to 8 levels from the session working directory looking for `.skill-src/skill-index.tsv`, so the convention is to put the library at the **workspace root**:

```
<your-workspace>\                    ← you start DSH sessions here
├─ .skill-src\                      ← the library root; the name is what the plugin looks for
│  ├─ skill-index.tsv               ← the index (generated in step 3)
│  ├─ remotion-skills\              ← one upstream repo = one top-level directory
│  │  └─ skills\remotion-create\
│  │     └─ SKILL.md
│  └─ trailofbits-skills\
│     └─ plugins\semgrep\skills\semgrep\
│        └─ SKILL.md
├─ .dsh\skills\                     ← the DSH resident set (the plugin never touches it)
└─ AGENTS.md
```

Three rules:

1. **The directory must be named `.skill-src`.** The leading dot keeps it invisible to DSH’s skill scanner — that is precisely the mechanism that makes the library free. Name it `skills/`, or put it under `.dsh/skills/`, and DSH will inject **every** skill into every turn, defeating the point of installing this.
2. **It must sit at or above the session cwd.** If your session starts in `<your-workspace>\projects\foo`, the plugin walks up and finds `<your-workspace>\.skill-src` — that works.
3. **The layout inside does not matter.** The plugin only needs "some directory named like the `repo` column, then the `relpath` column, then `SKILL.md`". An upstream repo mixing `skills/`, `plugins/<name>/skills/` and `antigravity/skills/` can be dropped in as-is.

### 2. The library lives elsewhere (another drive, another directory)

The plugin looks for `cwd/.skill-src`, so put a **directory link** at that path pointing wherever the library actually is. This is tested (`node tools/check-link-support.mjs` re-verifies it):

```powershell
# Windows: a junction needs no elevated rights
New-Item -ItemType Junction -Path "D:\work\.skill-src" -Target "E:\skills-archive"
```

```sh
# Linux / macOS
ln -s /mnt/skills-archive "/home/me/work/.skill-src"
```

`skill_search` and `skill_load` both work through the link. **Known limitation:** the returned `path` is the link path, not the real one — when debugging, use `dir` or `ls -l` to see where it points.

> Do not use DSH's `customSkillDirs` for this. That setting **registers skills as resident**, which would put every skill into the per-turn catalog — the exact opposite of what this plugin is for.

### 3. Generate the index

Any writer will do, as long as it emits those columns. A reference implementation (PowerShell, for a library of upstream repos checked out under one directory):

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

**Use a real CSV writer** (`Export-Csv`, `csv.writer`, …). Hand-joining columns with tabs breaks the moment a description contains a tab, a quote or a newline — the reference implementation above was bitten by exactly that. Re-run it when the library changes (see "when the library changes" in step 6).

### 4. Verify it works

The install command is in the section above. **After restarting DSH** (a plugin row is composed only when a new host process starts), check in this order:

1. **Are the tools there?** Ask the agent which skill-related tools it has; `skill_search`, `skill_load` and `skill_ref` should all be listed.
2. **Did it find the index?** Have the agent run `skill_search` for a name you know is in the library. The result carries a `library` field — the root it actually used. **Check that path**; it is the fastest way to catch "it looked in the wrong place".
3. **Does loading work?** Have it `skill_load` one hit. `source` should read `library` (a `resident` value means it came from the resident set, not the library).
4. **Did the library leak into the catalog?** Confirm a new session's skill catalog did **not** grow because of this install. Anything under `.skill-src` should be absent from it.

Two fields separate the three failure modes: **no index** (the error lists where it looked), **an index that is not this library** (the `library` path is wrong), and **a malformed index** (a non-empty `error`). `explain: true` additionally shows why a search did not match.

Checking the index itself by hand:

```powershell
# header (6 or 7 columns) and row count
Get-Content "D:\work\.skill-src\skill-index.tsv" -TotalCount 1
(Import-Csv "D:\work\.skill-src\skill-index.tsv" -Delimiter "`t").Count
```

### 5. Day to day

**You do not need to remember skill names.** That is the point — the agent does the choosing:

- Just describe the task ("build me a video with Remotion"). The tool descriptions say to search before any non-trivial task, so the agent looks on its own.
- To see what is available, ask: "does your skill library have anything about X?" The agent will run `skill_search` and show you.
- To make a skill **auto-trigger** (no reminder needed each time), that skill has to become resident:
  ```powershell
  & "D:\work\.skill-src\install-more.ps1" -Name remotion-create
  ```
  The price is its entry in every turn's catalog — that is what you are buying.

### 6. When the library changes

| What you did | What to do |
|---|---|
| Added, removed or renamed a skill directory | **Regenerate the index**, or the search works from stale metadata |
| Edited a `SKILL.md` description | Same — the description is the retrieval corpus |
| Edited only a skill body | Nothing; `skill_load` reads files live every time |
| Moved the whole library | Update the link target; the old index's `repo`/`relpath` values stop resolving |

**Keep the generator as a script** (for example `.skill-src\scan-skills.ps1`) and run it after changing the library. A stale entry shows up as "searchable but unloadable": the path is still in the index, the file is gone. `skill_load` names the path it could not read rather than failing silently.

### 7. Backup and quarantine

- **Back the library up.** It is your capability set, usually assembled from several upstream repos. If those repos are re-cloneable, the minimum is `skill-index.tsv` plus your admission notes.
- **Quarantine first, investigate second.** Move a suspicious directory out of the library root (say `.skill-src\_quarantine\`) and regenerate the index; it disappears without uninstalling anything. For an audit, `node tools/audit-library-risk.mjs <library-root>` counts risky patterns separately for code blocks and prose — only the former is what a model may copy and run.

## Tool reference

### `skill_search`

Keywords are lowercased and matched with weights across `name` / `whenToUse` / `description` / `path`.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | e.g. `"kubernetes helm"`, `"remotion video"` |
| `limit` | integer | 1–40, default 12 |
| `repo` | string | case-insensitive filter on the upstream directory name |
| `names_only` | boolean | names and repos only, no descriptions (about 60% smaller) |
| `explain` | boolean | also return the score breakdown per hit, for diagnosis |

Returns `total`, `shown`, `more`, `fallback`, and per hit: `name`, `repo`, `description`, `copies`, `matchCount`, `whenToUse`, `files`, `path`, `libraryRelative`; with `explain` also `score` and `why`.

### `skill_load`

Loads the full text of one or more skills into context.

| Parameter | Type | Notes |
|---|---|---|
| `name` | string | one skill name; an absolute path to a `SKILL.md` also works |
| `names` | string | several names in one call, separated by commas or newlines |
| `repo` | string | upstream repo filter, applied to every name in the call |

Returns `requested`, `loaded`, `failed`, and a `skills[]` array of `name`, `source`, `repo`, `copies`, `path`, `resourceDir`, `content`, `referenceFiles`, `truncated`, `error`. The tool card renders each skill as a `<skill_content>` block with its base directory, so relative paths (`scripts/`, `references/`, `assets/`) resolve correctly.

> **Why `name` + `names` rather than an array.** An earlier version declared `name` as `oneOf: [string, array]`. It reads well in a schema and fails in practice: array arguments can arrive at the tool **stringified**, so `["gh-cli"]` becomes the literal `'["gh-cli"]'`, matches the string branch, and is treated as one nonexistent skill name. Three shapes are accepted now (a real array, a JSON string, comma/newline-separated) because robustness here should not depend on how the transport serializes arguments.

### `skill_ref`

Reads one file bundled with a skill, or lists what is bundled.

| Parameter | Type | Notes |
|---|---|---|
| `name` | string, required | a skill name `skill_search` returned |
| `path` | string | file relative to that skill's base directory, e.g. `references/rulesets.md` |
| `list` | boolean | list every bundled file instead of reading one |
| `repo` | string | upstream repo filter, for a name that exists several times |

The `referenceFiles` list from `skill_load` is usually enough to decide *whether* to read a file — this reads only that one instead of pulling the whole directory into context.

## Engineering constraints

**Why nothing is imported.** A previous version imported `defineTool` from `@deepseek-ai/dsh-tools`. Node resolves a bare specifier from the importing package first, so a stray dev shim in the package's own `node_modules` shadowed the real package, the author DSL (`output.schema: { type: 'json' }`) reached the registry uncompiled, and the **entire plugin tree failed to load**:

```
unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

The plugin now ships **no `node_modules` and no dependencies**, and builds its tool definitions locally in standard JSON Schema, so they are valid whether or not the runtime compiles schemas. The registry's compiler is stricter than its assertion in one place: an object schema must state `additionalProperties` explicitly. `test/boot-safety.mjs` turns all of this into assertions, including "the build fails if any `@deepseek-ai/*` appears in `dependencies`".

**Why there is no ledger or dedup state.** The plugin never injects anything automatically, so there is no "already injected this session" state to maintain. Whether to reload something is the model's decision — a structural simplification that tool-driven retrieval gets for free compared with pre-step routing.

## Tests

```sh
npm test
```

Thirteen dependency-free scripts. They run against a real staged library when one is reachable and otherwise **generate a fixture** in the OS temp directory, so a bare clone can test the plugin:

| Script | Covers |
|---|---|
| `boot-safety.mjs` | no shadowing `node_modules`, no host package in `dependencies`, schemas valid in the registry's enforced subset |
| `schema-forms.mjs` | which `output.schema` literal survives registration, and that the author DSL fails |
| `shape.mjs` | parameter shapes and the routing wording in the tool descriptions |
| `verify.mjs` | end-to-end search + load behaviour |
| `collisions.mjs` | duplicate-name resolution and `repo` hints |
| `batch.mjs` | every transport shape for a multi-skill request |
| `robustness.mjs` | partial-match fallback, `explain`'s score breakdown, `whenToUse`, both truncation boundaries |
| `skill-ref.mjs` | path containment including `../` traversal attempts, listing, missing files |
| `index-format.mjs` | the index-format contract: 6- and 7-column files both parse, the header is found by shape, the live index still works |
| `minimal-host.mjs` | degradation with only `ctx.fs` injected: all three tools work, optional APIs absent without crashing |
| `docs-parity.mjs` | bilingual docs do not drift: the README pair, the SECURITY pair, Chinese-first release notes |
| `workflow-config.mjs` | the CI config itself: explicit `permissions` limited to `contents: read`, actions pinned to a version, no tab indentation |
| `no-local-paths.mjs` | no machine-specific absolute paths in code or config; example paths in the docs are deliberately excluded |

Point them at a specific library with `SKILL_LIBRARY_ROOT=/path/to/workspace`; `node tools/audit-library-risk.mjs` audits any library for risky content.

## Layout

```
host.js                       the plugin: apply(), buildSkillRouterTools(), definePortableTool()
cordis.patch.yml              the composed row (id: skill-router, name: dsh-skill-router)
SECURITY.md / SECURITY.zh.md  security policy (English / Chinese)
test/                         thirteen runs, plus a dev-only stand-in for @deepseek-ai/dsh-tools
tools/audit-library-risk.mjs  library risk audit (the policy's figures come from it)
docs/                         per-version release notes (bilingual, Chinese first)
.github/workflows/            CI: npm test on Linux and Windows, Node 20 / 22 / 24
```

## Security

This plugin **never executes code, never touches the network, never writes a file and never reads an environment variable** — it performs index lookups and file reads. The skill bodies it reads are **untrusted third-party content**, and that is the real trust boundary.

The full policy — threat model, the known limitation of path containment, supply-chain constraints, and the list of features that will not be added without review — is in [`SECURITY.md`](SECURITY.md) | [中文](SECURITY.zh.md). Report vulnerabilities through this repository's private vulnerability reporting.

## License

MIT
