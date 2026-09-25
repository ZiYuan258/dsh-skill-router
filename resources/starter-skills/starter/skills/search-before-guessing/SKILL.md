---
name: search-before-guessing
description: Use when a task mentions a framework, protocol, tool, or a procedure you are about to improvise, and you are not certain the capability is already available locally. Search the staged skill library first instead of inventing a workflow.
---

# Search before guessing

A large library is not in your context. That does not mean it is absent — it means you have to ask
for it. The failure this skill prevents is **improvising a procedure that already exists**, which
produces a plausible answer that quietly ignores the team's actual conventions.

## When to run a search

Run `skill_search` before you start, when any of these is true:

- the task names a **framework, protocol, service, or tool** (`semgrep`, `kubernetes`, `playwright`);
- the task is a **process** you were about to make up — a review, an audit, a migration, a release;
- you are about to say **"there is no capability for this"**;
- the work is non-trivial and you have not looked yet.

Skip it when the task is genuinely small: a one-line fix, a question about the code in front of you,
a command you already know. Searching costs a round trip, and paying it on every trivial turn is
how a useful tool becomes noise.

## How to search

Search by **keywords, not by sentence**. The index is matched on words.

```
skill_search "kubernetes helm deployment"     # good: the words a skill would contain
skill_search "帮我做一个 K8s 的部署方案"          # bad: no Latin keywords, matches nothing
```

If a search returns nothing, that is information, not failure: widen it, or search for the *domain*
rather than the task (`helm` rather than `deploy my app with helm`).

## Then decide, and say so

The result is a **list of candidates**, not an instruction. Read the names and descriptions and pick
what actually fits — **including nothing**. Then load only those:

```
skill_load ["name-a", "name-b"]     # one call, several skills
skill_load "name" repo="upstream"   # when search reported copies > 1
```

Loaded text is the instruction for that task; its `resourceDir` is the base for any `scripts/`,
`references/` or `assets/` it mentions.

## What this is not

It is not "load everything related". Loading five skills to use one spends context on four that will
not be read. Two or three is usually the ceiling for one task; if you want more, the search was too
broad — narrow it instead.
