---
name: report-results-clearly
description: Use when finishing a task and writing the summary the user will actually read, especially for long or multi-step work, and when a result needs a decision from the user. Leads with the outcome and keeps the evidence attached.
---

# Report results clearly

A correct result that is hard to find is a worse deliverable than a slightly less complete one that
is easy to read. The reader is deciding what to do next, and they are reading on a small screen.

## Shape

1. **The outcome first**, in one sentence. If the user asked a question, the answer is the first
   line, not the last.
2. **Then the evidence**: the command and what it printed, the file and line, the number measured.
   Enough that the claim can be checked without asking you.
3. **Then what is unresolved**, if anything: what you could not verify, what you assumed, what you
   chose not to do.
4. **Then anything the reader must decide.** Ask it directly; do not bury a question in prose.

## Habits that help

- **Numbers over adjectives.** "2,580 ms at 64,000 characters" beats "very slow". A measured claim
  can be argued with; an impression cannot.
- **Quote failures exactly.** The verbatim message is searchable and diagnosable; a paraphrase is
  neither.
- **Do not re-narrate the process.** The steps you took are rarely the result. A reader who wants
  them can look at the diff; a reader who does not is slowed down by them.
- **Name the files you changed** so they can be opened without a search.
- **Say the same thing once.** Repetition reads as uncertainty.

## For multi-part work

If the work has parts, say how many succeeded and how many did not, up front. "3 of 5 migrated; two
blocked on X" is a report. Five sections the reader must tally is not.

## When the news is bad

Lead with it. A failure buried under three paragraphs of context costs the reader the time they
needed to react to it. State the failure, state what you know about the cause, state what you
recommend — in that order.
