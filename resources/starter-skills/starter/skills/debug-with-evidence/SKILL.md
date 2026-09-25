---
name: debug-with-evidence
description: Use when something fails and the cause is not yet known - a failing test, an unexpected result, a bug report. Instrument to get evidence before changing code, and change one thing at a time.
---

# Debug with evidence

The expensive failure in debugging is not a wrong guess. It is **four wrong guesses in a row**, each
one a plausible fix applied to code that was never executing, or to a cause that was never confirmed.

## Order of operations

1. **Reproduce it.** A failure you cannot trigger on demand is not yet a bug you can fix. If it is
   intermittent, that fact is the first finding.
2. **Get evidence before changing anything.** Print the value, log the branch, count the calls, read
   the actual payload. Do not reason about what the code "should" be doing — the interesting bugs
   are precisely where it does something else.
3. **State the cause as a falsifiable sentence.** "The guard returns early because `loadOlder` is
   undefined on this object" is falsifiable. "Something is wrong with paging" is not.
4. **Then change one thing**, and re-run the same evidence-gathering step.

## Two habits that carry most of the weight

**Instrument the assumption you did not know you were making.** The bugs that survive several fixes
are the ones where the code is correct *for a contract that does not hold* — the method lives on a
different object, the field is absent for this input, the window is bounded. A count or a log line
settles in one run what reasoning settles in an hour.

**Prefer a fixture that copies reality.** A test built on a shape you inferred will pass while the
product fails. If you can capture the real payload — a log line, a serialized event, a saved
response — build the fixture from that, not from what the shape obviously ought to be.

## When a fix does not work

That is information about the diagnosis, not about the fix. Do **not** apply a second fix to the
same place hoping for a different outcome. Go back to step 2 and instrument: if a fix had no effect
at all, the most likely explanation is that **the code path never runs**.

## Reporting a diagnosis

Say what you observed, what it rules out, and what you still cannot distinguish. "The request
returns 200 with an empty list, so the filter is rejecting everything or the source is empty — I have
not yet separated those" is far more useful than a confident wrong cause.
