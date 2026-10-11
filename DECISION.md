# Decision: Skill Library vs Automatic Routing

**Status:** Accepted
**Date:** 2026-10-13
**Supersedes:** The original "automatic skill router" design (v1.0–v1.16.1)

---

## Context

DSH (DeepSeek Harness) supports a resident skill catalog: a set of skills whose
names and descriptions are injected into the model's context every turn, so the
model can trigger them autonomously. This works well for tens of skills.

The problem arises at scale. The workspace has **7,746** candidate skills
collected from public repositories. Loading all of them into the resident catalog
is physically impossible:

| Skills | Characters | Tokens | 128k window |
|---|---|---|---|
| 40 (current resident) | 12,915 | ~3.6k | 3% |
| 7,746 (all) | ~2.5M | ~715k | 558% |

The project started with a three-part hypothesis:

1. **Store** the long tail in a cold library (no resident cost). ✅ Correct.
2. **Search** the library on demand via `skill_search` / `skill_load`. ✅ Correct.
3. **Automatically route** — read the user's message, guess which skills are
   relevant, and inject their names as a hint before the model responds. ❌ Wrong.

This decision record is about part 3.

---

## Considered approaches

### A. Keep all skills resident

**Rejected.** Context overflow at 7,746 skills (~715k tokens/turn). Even at
200k or 256k context windows, this exceeds capacity. Signal-to-noise ratio
degrades: the model must scan thousands of descriptions every turn.

### B. Skill library + on-demand retrieval

**Accepted.** Skills live in a cold index (`skill-index.tsv`). The model
discovers them via `skill_search` and loads full instructions via `skill_load`.
Resident cost is zero for the 7,700+ long tail; the model pays only when it
actually searches. This is the architecture that shipped.

### C. Automatic heuristic injection (the "router")

**Rejected by experiment.** A heuristic in the plugin's `pre-step` hook reads
the user's task text, runs a keyword scorer over the library, and — when the
top candidate exceeds a threshold — injects a "Maybe relevant skills…" hint
into the model's context as a synthetic user message.

The design assumption was: *the model doesn't know which skills exist, so the
plugin must tell it.*

The experiments below test this assumption directly. It is false.

---

## Evidence

### Discovery injection experiment (v1.16.1)

A/B comparison across 226 conversation turns. The plugin's injection layer was
the treatment; the model's spontaneous skill usage was the outcome.

| Group | Turns | Any skill used | Spontaneous (not user-specified) |
|---|---|---|---|
| **Injected** (treatment) | 45 | 1 | **0** |
| **Not injected** (control) | 181 | 12 | **12** |

The single "success" in the injected group was a user-specified replay, not a
spontaneous model decision. The control group — where the plugin did nothing —
produced 12 spontaneous loads, all from the **resident catalog** (the 40
always-present skills), not from the library.

**Interpretation:** the condition for skill use is "the user's request is about
the skill's subject," not "the skill was made available." The model's own
judgment, operating on resident descriptions, outperforms the heuristic router.

### Phase-2 four-arm experiment (v1.16.2)

A pre-registered experiment with four arms across 6 tasks × 4 arms × 5 repeats
= 120 runs (mechanism validated; full 120 not run — see below):

| Arm | What it does | Result |
|---|---|---|
| **A** (control) | No injection | Baseline |
| **B** (hint) | Inject skill *names* as a hint | Not differentiated from A |
| **C** (auto-discover) | Plugin's `discover()` selects + injects *content* | 1/4 tasks injected, 0/4 correct skill chosen |
| **D** (oracle) | Human-specified correct skill injected | 4/4 correct |

Arm C — the automatic router — picked the wrong skill in the one case it
injected (a legal contract skill for a compiler error task). Arm D — human
selection — was 4/4. The gap is in **selection**, not **injection**.

### Transcript census (132 sessions)

Across 132 real conversation transcripts, the model spontaneously loaded a
library skill (via `skill_search` → `skill_load`) **8 times**. Of those 8,
**0** were relevant to the task. The resident catalog (40 skills) accounted for
all meaningful skill usage.

**Interpretation:** the long tail is rarely needed. When it is needed, the
model's keyword search is sufficient if the query terms match the skill
description. The bottleneck is not discovery — it is task-skill semantic
alignment, which a heuristic router cannot solve better than the model itself.

### Why the full 120 runs were not completed

The core question — "does automatic injection help?" — was answered by the
evidence above. Arm C is not a valid treatment (it fails at selection, not
delivery), so A-vs-C is not a meaningful comparison. A-vs-D (does correct skill
content help when properly selected?) has preliminary evidence from task T12
(arm D costs 2.6× time, 3.4× tokens) but is a separate question that does not
affect the routing decision.

---

## Final architecture

```
                 User task
                    │
                    ▼
         ┌──────────────────────┐
         │   LLM self-selection  │
         │  (primary selector)   │
         └──────────────────────┘
                    │
            ┌───────┴───────┐
            ▼               ▼
     Resident catalog    Skill library
      (~40 skills)       (~7,700 skills)
     Description         Cold storage
     always present      Search on demand
            │               │
            ▼               ▼
     Model triggers    skill_search()
     directly          → skill_load()
```

The plugin provides:

| Component | Status | Rationale |
|---|---|---|
| `skill_search` | ✅ Kept | Discovery entry point for the long tail |
| `skill_load` | ✅ Kept | On-demand full instruction loading |
| `skill_ref` | ✅ Kept | Read bundled skill files |
| Usage tab | ✅ Kept | Visibility into what the session actually used |
| CJK tokenizer fix | ✅ Kept (v1.16.2) | Chinese queries were silently zeroed out |
| Stem + synonym matching | ✅ Kept (v1.17.0) | Reduces ~70% of lexical miss cases |
| **HIGH injection layer** | ❌ **Disabled by default** (v1.16.2) | Experimentally shown to have 0 spontaneous conversions |
| **Phase-2 runner** | ⚠️ **Archived** (v1.18.0) | Experiment complete; code kept for reproducibility |

The injection layer is not deleted — it is gated behind
`DSH_SKILL_ROUTER_INJECT_TIERS=HIGH` so the experiment can be reproduced.
Default is off.

---

## What this means

**The plugin is not a router.** It is a skill discovery and library access layer.

The name `dsh-skill-router` is retained for package continuity (npm, installed
profiles, existing issues). The README positions it as "Agent-driven skill
discovery and on-demand loading."

**Discovery ≠ decision.** The plugin can make skills *findable*; it should not
decide which skills the model *uses*. That decision belongs to the model, which
has more context and better judgment than any keyword heuristic.

---

## Future work

**Planned (when ROI justifies):**

1. **Skill metadata index** — pre-compute `name`, `description`, `category`,
   `language`, `triggers`, `quality_score` into a single index file. Avoids
   scanning 7,700 files per search; enables structured queries
   (`skill_search({ category: "security" })`).
2. **Quality ranking** — surface high-quality skills, demote duplicates and
   stubs.
3. **Duplicate detection** — already tested (`test/stale-and-duplicates.mjs`);
   promote to a management tool.

**Not planned:**

- Automatic injection / heuristic routing — rejected by experiment.
- Embedding-based semantic search — ROI too low (library skills are searched
  ~8/132 sessions, 0 relevant; the bottleneck is search *frequency*, not search
  *quality*). Revisit if usage patterns change.

---

## References

- Experiment data and analysis: `experimental/phase2/`
- Policy document: `.dsh/SKILLS-POLICY.md` §35 (workspace)
- Release notes: `docs/release-notes-v1.16.2.md` (injection disabled),
  `docs/release-notes-v1.18.0.md` (this decision recorded)
- Census: 132 transcripts, 8 library loads, 0 relevant
