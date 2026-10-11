# Phase-2 Experiments (Archived)

**Status:** Experiment complete. Code retained for reproducibility.
**Decision:** See `../../DECISION.md` — automatic routing rejected.

---

## What this is

This directory contains the tests for the phase-2 experiment infrastructure that
evaluated whether automatic skill routing improves agent behavior.

The experiment ran a four-arm design:

| Arm | What it does | Result |
|---|---|---|
| **A** (control) | No injection | Baseline |
| **B** (hint) | Inject skill names as a hint | Not differentiated from A |
| **C** (auto-discover) | Plugin selects + injects content | 1/4 injected, 0/4 correct |
| **D** (oracle) | Human-specified correct skill | 4/4 correct |

## What it concluded

- **Automatic injection does not improve skill usage.** 45 injected turns
  produced 0 spontaneous loads; 181 control turns produced 12.
- **The bottleneck is task-skill semantic alignment, not skill availability.**
  A keyword heuristic cannot solve this better than the model itself.
- **Discovery ≠ decision.** The plugin makes skills findable; the model decides
  whether to use them.

## What remains in the runtime

The phase-2 support code (`phase2-control.js`, `discovery.js`) stays in the
repository root because `host.js` imports it. It is gated behind environment
variables (`DSH_SKILL_ROUTER_INJECT_TIERS`, `DSH_PHASE2_ARM`) and is inert
by default. This code is not on any hot path in production.

## Files

- `phase2-control.test.mjs` — unit tests for the four-arm parser and manual
  skill list parser.
- `phase2-conditions.test.mjs` — condition tests for phase-2 eligibility gates.

## Reproducing

```sh
# The injection layer is off by default. To re-enable for reproduction:
DSH_SKILL_ROUTER_INJECT_TIERS=HIGH

# To run a specific arm:
DSH_PHASE2_ARM=A  # or B, C, D
```

The full 120-run pilot (6 tasks × 4 arms × 5 repeats) was not completed — the
core question was answered by the mechanism validation and census above. See
`../../DECISION.md` for the full rationale.
