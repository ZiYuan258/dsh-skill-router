---
name: evidence-before-claims
description: Use when about to report work as done, fixed, or passing, and before committing, pushing, or opening a pull request. Requires running the verification command and reading its output before making any success claim.
---

# Evidence before claims

Every success claim is a factual claim about the world. Make it by **running the thing and reading
the output**, not by remembering that it worked before, and not by reasoning that it should.

## The rule

Before writing any of these — "fixed", "done", "tests pass", "works", "should now" — you must have,
in this session:

1. **run the command** that demonstrates it, and
2. **read its output**, including its exit code.

If you have not, the honest sentence is "I have not verified this yet."

## Why this is not pedantry

The characteristic failure is not lying; it is **inferring**. A change is made, the reasoning is
sound, the surrounding code obviously works, and so "this fixes it" is written — while the actual
command was never run, or was run before the last edit. That sentence is then repeated to the user,
who acts on it.

Corollary: **a claim that a previous run established something is stale the moment you edit the
file.** Evidence has a timestamp, and edits invalidate it.

## How to do it without wasting the turn

- Run the **narrowest** command that demonstrates the claim first; widen only if it passes.
- When the command fails, **quote the failure** rather than paraphrasing it — the exact message is
  what makes it diagnosable.
- If a check cannot be run here (no network, no device, no service), say that plainly and say what
  remains unverified. An honest gap is cheap; a fabricated green is expensive.

## Reporting shape

State what was run, what it printed, and what remains unproven. For example:

> `npm test` → 24 scripts, all OK. The Windows path case is covered by its own assertion. Not
> verified: the packaged install, which needs a packed tarball I have not built.

That last clause is the part people skip, and it is the part that keeps them honest.
