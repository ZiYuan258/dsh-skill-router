# v1.2.0 — skill_ref, search fallback, honest truncation

Adds a third tool, makes keyword search degrade instead of failing, and fixes a boundary bug that made the truncation warning impossible to trigger.

**Documentation:** [English](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.md) | [中文](https://github.com/ZiYuan258/dsh-skill-router/blob/main/README.zh.md)

## Install

```sh
dsh plugin --profile <profile> add github:ZiYuan258/dsh-skill-router
```

Upgrading from v1.1.0 needs a restart, like any plugin change.

## New: `skill_ref` — read one bundled file instead of a whole directory

A `SKILL.md` routinely points at `references/`, `scripts/` and `assets/` that the task never needs, and `skill_load` only listed them by name. `skill_ref` reads exactly the file the instructions asked for:

```
skill_ref  name: "semgrep"  path: "references/rulesets.md"
skill_ref  name: "semgrep"  list: true
```

Paths are resolved with a containment check **before any I/O**, so `../` cannot reach outside the skill directory — covered by unit tests on the resolver itself, not just through a live call. This is where the token saving actually lives.

## New: partial-match fallback in `skill_search`

Keyword search was a strict AND, so a two-word query that no single skill matched returned nothing at all. Search now retries with a partial match and says so:

```
fallback: "or"          // was "none"
matchCount: 1           // out of 2 keywords, per hit
```

A near-miss is never presented as a real hit, and a single-keyword query never falls back — there is nothing to degrade to.

## Fix: the truncation warning could never fire

`clampBody` replaces a helper whose callers tested `text.length > cap` **after** clamping, which can never be true — so an oversized `SKILL.md` was silently shortened and reported clean. A body of exactly the cap was also quietly shortened by one character.

Now the clamp returns the truncation fact alongside the text:

```
truncated: true
error: "content truncated at 120000 of 130095 characters; read the full file at …/SKILL.md"
```

Both boundary cases are pinned by tests.

## Fix: one source of truth for `host.js`

The plugin file had been edited in two places at once (the deployed package and a dev checkout) and the copies silently diverged — one went a whole edit behind, and a test run against it "passed" a state the package never had. `tools/sync-host.mjs` now keeps a second checkout in step, with `--check` exiting 1 on drift so CI or a hook can refuse a split brain.

```sh
SKILL_ROUTER_DEV_DIR=/path/to/other/checkout npm run check:host
```

## Tests: 9 scripts, no dependencies

Two new ones: `robustness.mjs` (fallback labelling, both truncation boundaries) and `skill-ref.mjs` (path containment including traversal attempts, listing, missing files). Both build their own fixture library, so a bare clone still runs the whole suite. CI covers Node 20, 22 and 24 with no install step.

## Requirements

- DSH `>= 0.1.5-rc.1`
- Node `>= 20.18.0`
