---
name: scope-before-building
description: Use when a request is underspecified - "build me X" without saying for whom, why now, or what done means - and before writing a plan or any implementation code. Establishes the smallest slice worth building and how it will be judged.
---

# Scope before building

An underspecified request is not an invitation to guess well. It is a request for **one round of
questions**, because the cost of guessing wrong is the whole implementation.

## Ask, in this order

1. **Who is this for, and what do they do today instead?** The current workaround usually defines the
   real requirement better than the feature description does.
2. **What does done look like, observably?** "Works" is not observable. "The report renders without
   network access" is.
3. **What is explicitly out of scope?** Without this, scope grows during implementation and nobody
   notices until the end.
4. **What is the smallest version that is still worth having?** Ship that understanding first.

Ask these as **one batch**, not one at a time — a turn spent per question is a turn the user spends
waiting. If a question can be answered by reading the code, read the code instead of asking.

## Then write the slice down

Before implementing, state in a few lines: the goal, the acceptance check, and what you are
deliberately not doing. This takes a minute and is the artifact everyone re-reads later.

## Signs you skipped this

- You are about to write a large amount of code with no checkpoint in the middle.
- You cannot say how you will know it works, other than "I will try it".
- You are adding a configuration option for a case nobody has described.
- A requirement appeared halfway through that changes the design.

## When the request is already specific

Then do not perform an interview. State your understanding in one line, name the acceptance check,
and start — the goal here is a shared definition, not a ceremony.
