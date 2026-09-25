# dsh-skill-router

English | [中文](README.md)

**Agent-driven skill discovery and on-demand loading.** A **Host plugin** for DeepSeek Harness. It adds three tools — `skill_search`, `skill_load`, `skill_ref` — so an agent can find and load a skill from a library on demand.

```sh
dsh plugin --profile web add github:ZiYuan258/dsh-skill-router
```

> **Two things to check before installing.**
>
> **1. The owner has to be `ZiYuan258`.** Eight repositories on GitHub share this name (this one is the newest, created 2026-09-23). Several of them **auto-inject**: they read the user's message before the model answers and put a skill's full body straight into the prompt.
>
> **2. This plugin does not auto-inject, deliberately.** It puts candidates in front of the agent and **lets the agent decide what to load**, including nothing at all. A comparison table of the same-named repositories is further down.

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

The default is **strict AND**. Only when AND returns nothing and there is more than one keyword does it try a **partial match**, and a candidate must then hit every keyword but one — otherwise it answers "nothing found" and sets `fallback: "weak"`. Partial hits carry `matchCount`, the result carries `strict: 0`, and even the header the model reads says "0 exact match(es); N partial match(es)": **a near-miss is never dressed up as a real hit**. A single-keyword query never falls back, because there is nothing to degrade to.

> That threshold was forced by measurement. On the 1026-row reference library, `test setup config helper` used to return **1026 entries**, nearly all of them sharing one common word; tightened, it returns **7**. In the same experiment `make a movie` matched the whole library on `make` and `a`, so words with no discriminative power — `a`, `the`, `make`, `use` — are dropped during tokenization (`STOP_WORDS` in `tokenize`).

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

**Eight** repositories on GitHub are called `dsh-skill-router` (this one is the newest, created 2026-09-23), so installing the wrong one gets you a different plugin:

| | This repository | The other family |
|---|---|---|
| Install command | `github:ZiYuan258/dsh-skill-router` | `github:lau4tin1/dsh-skill-router` (holds the bare npm name `dsh-skill-router`) |
| Mechanism | **tool-driven**: the model calls `skill_search` / `skill_load` / `skill_ref` itself | **routing plus auto-injection**: embeds tasks and skills with a local model, keeps the clearly-relevant ones by a gap rule, and puts their bodies in the prompt |
| Problem it solves | library skills are **invisible to the model** | the model **does not use a skill it should have** |
| Who chooses | **the agent** — it reads the candidates and may pick none | **the plugin** — a routing hit is injected |
| Dependencies | zero dependencies, zero imports | varies; some need a local model or embeddings |

**The two take opposite positions, and that is this plugin's deliberate design rather than a gap.** See the task-aware discovery section below: that layer only discovers, and currently only measures rather than injecting.

Others in the family include `MJorgin/dsh-skill-router` (rule-first pre-step routing) and `Phantomcyber-ai/dsh-skill-router` (intent-level auto-routing); some are placeholders or unfinished. **Check that the owner is `ZiYuan258` before installing.**

> If a tool reports this repository as unreachable, check which kind of failure it is: GitHub rate-limits
> **unauthenticated API** calls to 60/hour and answers `403 API rate limit exceeded`, while the web page and raw
> files keep working — and `dsh plugin add` uses those.

## Usage

### 0. It works once installed (nothing to set up first)

**The plugin ships with a starter library** (5 skills covering *search before guessing*, *evidence before claims*, *debug with evidence*, *scope before building*, and *report results clearly*). When you have no library of your own, that is the library — restart DSH and `skill_search` has something to find immediately:

```
skill_search "debug"
→ debug-with-evidence     ← from the starter library bundled with the plugin
```

The result carries **`starterLibrary: true`** and a `library:` path inside the plugin package. **Seeing that flag means you are reading the starter library, not your own** — the two situations call for completely different diagnosis, so they have to be distinguishable.

> **The starter skills never enter the resident catalog.** They live under the plugin's `resources/starter-skills/` and go through `skill_search` / `skill_load` like any other library skill; not one byte reaches the per-turn model catalog. Putting them in `.dsh/skills/` would inject them into every turn — which would destroy the entire point of this plugin. `test/starter-library.mjs` asserts this.

Shipping 5 rather than 1,000 is **deliberate**: the problem this plugin solves is *a large library that must not stay resident*. Bundling a large one would bring package size, update lag, license mixing and version coupling all at once. For real coverage, attach your own library (section 1).

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

The plugin looks for `cwd/.skill-src`, so when the library lives elsewhere, put a **directory link** in the workspace. Measured to work (Windows junction / POSIX symlink; verify with `node tools/check-link-support.mjs`):

```powershell
# Windows: a junction needs no administrator rights
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

```sh
node tools/build-index.mjs <library-root>          # writes <library-root>/skill-index.tsv
node tools/build-index.mjs <library-root> --check  # reports drift only (exit 1 when stale)
node tools/doctor.mjs --root <library-root>        # check-up: path / count / stale / duplicates
```

Zero dependencies, cross-platform. It does four things: finds every `SKILL.md`, parses the YAML frontmatter, computes `relpath` **relative to the repo root** (not the library root — one extra level and nothing resolves, which is the bug its first version shipped), and writes real TSV escaping so a description containing a tab, quote or newline cannot break the columns. The `whenToUse` column is written only when at least one row has it.

**After this you never hand-edit the index again.** Re-run it when the library changes; if you forget, `doctor` says so — it compares "on disk" against "in the index" in both directions.

<details>
<summary>Why the "write your own generator" advice is gone (the old PowerShell reference implementation)</summary>

That block was a script you had to copy and edit a `$root` in. It worked, with two problems:

1. **the index format is the plugin's internal data model**, and it should not be part of the install flow;
2. it **scanned one level only** (`$root/<repo>/**`), **never emitted `whenToUse`**, and **missed skills without frontmatter** — the reference library had 3 of those (in a Microsoft monorepo), so they could never be found. Measured: `build-index.mjs` produces 1,028 rows for that library while the old reference implementation's index held 1,025.

The index is still a **public contract**: anything that emits those 7 columns can replace `build-index.mjs`. The contract is the table above.
</details>

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

Returns `total`, `strict`, `shown`, `more`, `fallback`, and per hit: `name`, `repo`, `description`, `copies`, `matchCount`, `stale`, `whenToUse`, `files`, `path`, `libraryRelative`; with `explain` also `score` and `why`.

`stale: true` means the index has the row but its `SKILL.md` is gone — the library changed and the index was not regenerated. Such rows do **not** make the search fail (an earlier version threw `ENOENT`, so one stale row took down the whole retrieval); they are flagged instead, and the flag is visible to the model.

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

## Skill usage tab (`conversation.view`)

The plugin ships a Client half that adds a **技能 / Skills** tab to the conversation view ring — the row holding Chat, Trajectory, Approval and Context — listing what this session actually loaded:

```
技能调用清单
本会话共 17 次技能调用，涉及 10 个技能。其中 1 次调用一次点名了多个技能，故按技能名分行列出；

1   cordis·插件·开发 (cordis-plugin-development)   skill        第 1 轮
2   editing-cordis-compositions                     skill        第 1 轮
3   remotion·创建 (remotion-create)                 skill_load   第 1 轮
…
16  验证·前置·完成 (verification-before-completion)  skill_load   第 63 轮
17  系统化·调试 (systematic-debugging)              skill_load   第 67 轮
18  系统化·调试 (systematic-debugging)              skill_ref    第 67 轮

已读到本会话最早一条记录，上面的数字是完整的。
dsh-skill-router v1.11.0 · 第 43 页 · 已读完 · 可翻页 是
```

**Zero model tokens.** The data comes entirely from the **session ledger**, handed to the component by the session-scoped slot:

```js
// The registration. `conversation.view` is declared scope: "session", so the renderer calls inject
// with the scope binding's key and spreads the result over the component's props. (That is also the
// mechanism behind following a session switch: injected props are cached per scope.)
inject: (sessionId, binding) => {
  const b = ctx.get('sessions').binding(sessionId ?? binding?.key)
  return { source: b.eventSource, session: b.session }
}
```

| You might assume | The actual contract |
|---|---|
| `eventSource` can page | ❌ `SessionEventSource = ObservableSnapshot<SessionEventWindow>` — **only `getSnapshot()` and `subscribe()`** |
| Then how is older history read | ✅ `loadOlder(): Promise<void>` is on the **`session`** (`SessionFace extends ISession`), which is also how the shipped trajectory tab calls it |
| Subscriptions are cancelled with `unsubscribe()` | ❌ No such method; cancelling is the **return value of `subscribe(fn)`** |
| Where `turn` / `callId` come from | ✅ `{ type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }` (measured, not inferred). **Identity is the envelope's `seq`, not `callId`** |

**It reads the whole history, and says only what it knows.** The ledger window is **bounded** (observed ~1,664–1,900, seen resetting 3,336 → 1,664) and `hasMore` is **true on the newest page**, so page 0 is the recent end — a skill loaded five pages back is invisible until paging reaches it. The tab backfills to the oldest record in the session (43 pages in practice), and:

- `本会话共 N 次技能调用…` is printed **only once** the oldest record has been reached; until then it says how many names it has read and that older records remain;
- with **no ledger to read it says only that** and prints no count at all (missing service / no binding / no eventSource are three different sentences);
- paging can stop for three reasons and **they are stated separately** — no answer (a 4-second deadline), an answer that moved nothing, or the 200-page cap. "I gave up on the rest of the history" and "the history ended here" are different claims.

**Why the row count and the call count can differ.** This is **correct**, not double counting:

- the row key is **`event identity + normalized name`** and the call count groups by event identity, so **one call naming several skills becomes several rows** (in practice a single `skill_load` loaded both `code-review-and-quality` and `gh-cli`);
- the event identity is the **`seq`** on the event envelope (`SessionEvent` declares `seq: SessionSeq` on every event, so it is contractually unique, and one `tool/call` event is one call). `callId` is the **pairing id** between a tool call and its result, and nothing in the contract says two different calls cannot share one — deduping on it would silently merge two real calls into one row and report a quietly low count. So `callId` is only part of the fallback token for an event that carries **no numeric `seq`**;
- **the call count is derived from the final rows**, never accumulated alongside them — two sources for one fact drift, and that is exactly what a live report's "18 rows / 17 calls" forced into the open;
- when the two differ, the header explains why, so nobody has to stare at the numbers.

**The order is the session's, not the arrival's.** Events arrive newest-first and older pages are **prepended**, so ordering by arrival gives you the reverse (a live report had turn 31 above turn 5). Records are sorted ascending by the event's own `seq`, whatever order the pages happen to arrive in.

**Paging is judged by whether the window reached further back — not by the promise, and not by its length.** The real `session.loadOlder()` **silently does nothing** in several conditions (a session still opening, `events` not yet arrived, a concurrent read) and returns an already-resolved promise, so "resolved" does not mean "a page arrived". The judgement is:

```
the OLDEST seq in the window decreased   <- primary: only acquiring older history can do this
or
the window grew                          <- secondary: a live append can grow it too
```

**Length alone is wrong**: the window is bounded, so it can **slide** — constant length while the whole content moves older. Such a page was judged "no progress", and after two of those the tab gave up with "无进展停止", reporting *giving up* as *nothing there*. `test/usage-tab.mjs` pins this with a true sliding window (constant capacity 40, advancing 20 per page) that hides a skill in the older history.

**Every page is folded into the accumulator the moment it is read.** This matters more than the judgement: the accumulator used to be written only when the ledger **notified**, and a notification can be a long time coming. That produced a successful read that was never kept — `loadOlder()` brought a page into the window, the UI rendered it, it slid out before the next notification, and **the accumulator never saw it**. Pages are now folded in while they are still on screen. Stopping the paging does **not** stop the live tail — calls arriving later still show up immediately.

**The last line says which build you are running.** The Client half is served with `cache-control: immutable`, cannot be imported by a Node test, and its served bytes sit behind the Desktop capability check — so "which build is the browser running" used to be unanswerable. It is now printed in the tab: `dsh-skill-router v1.11.0 · 第 43 页 · 已读完 · 可翻页 是`.

**The Chinese name is display only.** A skill name is the match key for `skill_load`, for index search and for the `/skill` command, so:

- what actually gets called is always the English name; the Chinese form never leaves the render layer;
- search still runs against the English text, and neither `SKILL.md` nor the index is **changed by a single byte**;
- proper nouns (`azure`, `vercel`, `semgrep`, `figma`…) are left alone — the most frequent tokens in this library's names are `azure` (148) and `google` (44), and translating those only makes a name harder to recognise.

The translation is a **glossary plus a proper-noun allow list**, not 872 hand-written pairs: phrases first (`best-practices` → 最佳实践), then single words (`troubleshooting` → 故障排查), with filler words (`and`, `from`, `the`) dropped.

> **This tab used to be empty, and the reason is worth keeping.** It read the wrong source four times: a guessed node shape; per-turn tool **declarations** from request headers (counting skills merely *offered* to the model as loaded); `useChat().legacy.nodes` (measured at one instant: 210 nodes with **zero tool calls**, against a ledger holding 2,778+ events); and paging written against `source.loadOlder`, which lives on the `session` — so the guard returned on the first line every time and **four "fixes" changed a code path that never executed**. None of the four crashed and all four rendered a plausible list, which is exactly why the data contract had to be measured rather than inferred. The retrospective is in `docs/release-notes-v1.8.0.md`.

## Task-aware skill discovery (**currently a dry run: it measures, it does not inject**)

The three tools above solve "there are many skills — how does the agent find one". They do not solve the other half:

> **Will the agent think to look at all?**

A library skill is invisible to the model, so using one requires the model to *first* remember that searching is possible. If the user says "run a Semgrep security audit" and the model decides to just answer, `skill_search` never happens. This layer exists for that gap.

It hooks `agent/pre-step` — DSH's waterfall that runs before a request is assembled — and at **step 1 of a turn** ranks the library for the incoming task, **locally, with zero model calls**:

```
the user task (step 1 only)
   ↓
the same tokenizer and the same scoreRow used by skill_search (weights live in one place)
   ↓
but NOT that tool's query policy: no strict AND, no all-but-one rescue
   ↓
top 5, or an explicit "nothing"
```

**Why the scorer is shared and the query semantics are not.** `skill_search`'s strict AND is built for a short query written by a model; a task is prose, and "分析这个 React 项目的性能问题" has no interpretation under strict AND — which would make this layer fail silently. So the difference stays in the caller and the weights stay in one function.

**This version injects nothing.** It appends one line of telemetry to `~/.dsh/skill-router/discovery.jsonl` and returns the decision untouched. What it measures is what only real data can answer: how often a candidate is meaningful, how often it is wrong, and how often there is nothing at all.

```json
{"at":"…","turn":3,"step":1,"tier":"HIGH","reason":"ok","tokenCount":7,"indexRows":2,"elapsedMs":11,
 "candidateCount":1,"candidates":[{"name":"semgrep","score":210,"matched":3,"nameHits":1,"fields":["name","whenToUse"]}],"injected":false}
```

**The raw task text is never written** — only match counts, candidate names and scores. A feature that observes the router should not also start accumulating session content. The log is byte-capped and rotates, so leaving it on for weeks cannot grow without limit.

`tier` is the reading that matters at this stage: **HIGH** (a name hit and at least two distinct tokens landing), **MEDIUM** (description-only, or a single weak keyword), **NONE** (not enough signal, or too close to the runner-up). Thresholds get chosen from a few days of data, not from intuition.

**Two known boundaries, deliberately not fixed yet — measuring them is the point of a dry run:**

- **The index matches Latin script only.** The tokenizer is `[^a-z0-9+#._-]`, so a Chinese task ("帮我做一次安全审计") yields zero keywords. That is a property of the index rather than a bug to paper over: such tasks are recorded as `reason: "no-searchable-token"`, and the dry run will say what share of traffic they are. If that share is high, aliases or a bilingual `whenToUse` are the next conversation — **not embeddings, not now**.
- **`reason` separates "nothing matched" from "no library"** (`no-library`), so a broken index cannot masquerade as a quiet, well-behaved router.

When injection is switched on it will change in exactly one place, and that place has already been verified: the hint goes into `decision.messages`, **not** through `agent.inject()`. `preStep` calls `inbox.claim()` *before* dispatching the waterfall, so anything injected lands in `next-step` and is only claimed at the **next** step — while this layer has to work on the first one. `decision.messages` is the authoritative batch for the current step (and becomes the session's `user/message`).


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

Twenty-eight dependency-free scripts. They run against a real staged library when one is reachable and otherwise **generate a fixture** in the OS temp directory, so a bare clone can test the plugin:

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
| `index-header.mjs` | all five header shapes (quoted / unquoted / BOM / both / LF endings) stay a header instead of becoming a skill named `name` |
| `minimal-host.mjs` | degradation with only `ctx.fs` injected: all three tools work, optional APIs absent without crashing |
| `link-support.mjs` | search and load still work when `.skill-src` is a directory link (Windows junction / POSIX symlink); reports a skip when the runner refuses to create one |
| `stale-and-duplicates.mjs` | a stale index (directory deleted) no longer makes `skill_search` throw and is flagged `stale`; the repo list for a duplicated name is visible to the model; weak matches are not offered as hits |
| `redos-guard.mjs` | the `js/polynomial-redos` guard: the replacement is equivalent to the regex it replaced **case by case** (including backslash-terminated Windows paths — the first version of it stripped only `/` and differed on 8 of 20), worst-case input stays constant-time, the call sites really go through the function instead of writing the regex back, and `host.js` may contain **exactly one** "quantifier + `$`" regex, because each additional one needs its own boundedness argument |
| `engine-range.mjs` | the `dsh.engines.dsh` range: every OR branch carries a prerelease tag (node-semver's rule — without one a tuple's rc is silently excluded), 0.1.5/0.1.6/0.1.7 are covered, 0.2 is excluded; and where a real semver is available it admits all 11 published versions, rejects 0.2.0, and confirms **the installed harness version falls inside the range** |
| `discovery-dry-run.mjs` | the discovery dry run, which **really calls `apply(ctx)` and drives `agent/pre-step` the way the agent loop does**: three tools plus the listener register, the decision is left untouched, telemetry is written, only step 1 is recorded, a Chinese task records `no-searchable-token`, a `reject` passes through, and **no user text appears in the telemetry** |
| `build-index.mjs` | the index generator: **every row resolves to an existing `SKILL.md` by the plugin's own path rule** (the first version added an extra `repo/` level, so 1,028 rows matched 1,028 while zero resolved — counting cannot catch that), `.git`/`node_modules` skipped, BOM/CRLF/block scalars/missing name/missing description, TSV escaping for tabs and quotes, `whenToUse` written only when needed, and the CLI's three `--check` states including CRLF not counting as drift; against a real library it re-checks every row and compares key sets with the existing index |
| `doctor.mjs` | every assertion of the library check-up **constructs a real failure and requires it to be reported** (missing index / stale / missing rows / no description / cross-repo duplicates), because a check-up that always says "healthy" would pass a test that only feeds it healthy libraries; `--json` parses and carries no full-library detail |
| `library-root-contract.mjs` | the **cross-layer contract**: one fixture drives both the runtime (`host.js`) and `doctor.mjs`, asserting they resolve the **same library root** from the same nested cwd, plus both divergence points (past 8 levels neither should find it; on an empty workspace only the runtime falls back to the starter library) |
| `starter-library.mjs` | the bundled starter library: index matches disk, `files` includes `resources`, an empty workspace can search and load a starter skill flagged `starterLibrary: true`, that flag disappears when you have your own library, and **the plugin makes no call that would register skills as resident** (a product invariant) |
| `usage-ledger.mjs` | the ledger's pure logic (59 assertions), with fixtures copying the observed event shape: all three loading tools count, `skill_search` does not, one event counts once across pages, **two different events sharing one `callId` still count as two**, a call naming `A+B` keeps both, a path and a bare name resolve to one skill, the three completeness states, **records survive window eviction**, **ordering follows `seq` (the session's order, not the arrival's)**, **the row/call relationship holds structurally** (`calls ≤ rows`, equality exactly when no call named several skills), and malformed input returns an empty ledger instead of throwing |
| `usage-tab.mjs` | the tab's wiring (87 assertions), taking the component through the **same load path the browser uses** and rendering it: the registration contract, both `inject` arguments, three "cannot read the ledger" explanations, a first paint that reads immediately with one page per request, a cap that holds when `hasMore` never clears, a call buried on page 5 being found, 200 streaming fragments scheduling one render, **the oldest record staying listed after the window evicts it**, **a parent re-render never stalling the paging**, **"reading" expiring on a deadline**, **a row/call difference explaining itself**, and no developer diagnostics left in the UI |
| `client-half.mjs` | verifies the Client half against the **real loading mechanism**: instruments `window.__ModuleLoader__`, materializes the factory the way `create()` does, asserts the `inject` declarations, and proves `apply()` survives four document timings; it also **scans for and rejects** the falsified data contracts returning (`legacy.nodes`, `useChat`, counting tool declarations as usage, **paging against `source.loadOlder` instead of `session.loadOlder`**) |
| `package-contract.mjs` | everything the loader reads: `exports`/`main`/`dsh.client`/`dsh.bundle`/`files`, the Client half compiling as a **classic script** and registering itself via `load()`, the Host exports, the composed row |
| `docs-parity.mjs` | bilingual docs do not drift: the README pair, the SECURITY pair, Chinese-first release notes |
| `workflow-config.mjs` | the CI config itself: explicit `permissions` limited to `contents: read`, actions pinned to a version, no tab indentation |
| `release-consistency.mjs` | release consistency, offline half: both version strings agree, every notes heading starts with its own version, every notes file is bilingual and correctly named, and the process doc plus the release script exist. It deliberately does **not** require notes for the current version — that would force a release for every commit (see the versioning policy in `RELEASING.md`) |
| `no-local-paths.mjs` | no machine-specific absolute paths in code or config; example paths in the docs are deliberately excluded |

Point them at a specific library with `SKILL_LIBRARY_ROOT=/path/to/workspace`; `node tools/audit-library-risk.mjs` audits any library for risky content.

The release process and its **versioning policy** are in `RELEASING.md`: the version number moves only when plugin behaviour changes; **a tag and a Release are two different objects**, `git push` only delivers the former, so the last step of a release is `node tools/publish-release.mjs`. Skipping it notifies nobody — this repository spent fourteen versions with tags but no Releases before anyone looked at the releases page.

`node tools/audit-client-halves.mjs` is deliberately **not** in `npm test`: it scans the Client halves of every plugin installed in **your** profile, so it is not self-contained. It should report a broken third-party plugin (that is the diagnostic), but it must not turn this repository's suite red for someone else's defect. It exists because this plugin broke DSH startup twice, and the report named only HMR while the broken file sat in the middle of the list.

## Layout

```
host.js                       the plugin: apply(), buildSkillRouterTools(), definePortableTool()
client.js                     the Client half: registers the 技能/Skills tab in conversation.view
cordis.patch.yml              the composed row (id: skill-router, name: dsh-skill-router)
SECURITY.md / SECURITY.zh.md  security policy (English / Chinese)
test/                         twenty-eight runs, plus a dev-only stand-in for @deepseek-ai/dsh-tools
tools/audit-library-risk.mjs  library risk audit (the policy's figures come from it)
tools/audit-client-halves.mjs packaging-contract diagnostic for this machine's Client halves
docs/                         per-version release notes (bilingual, Chinese first)
.github/workflows/            CI: npm test on Linux and Windows, Node 20 / 22 / 24
```

## Security

This plugin **never executes code, never touches the network, never writes a file and never reads an environment variable** — it performs index lookups and file reads. The skill bodies it reads are **untrusted third-party content**, and that is the real trust boundary.

The full policy — threat model, the known limitation of path containment, supply-chain constraints, and the list of features that will not be added without review — is in [`SECURITY.md`](SECURITY.md) | [中文](SECURITY.zh.md). Report vulnerabilities through this repository's private vulnerability reporting.

## License

MIT
