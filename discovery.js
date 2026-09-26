// Discovery telemetry for the dry run.
//
// The dry run exists to answer three questions with real data instead of design intuition:
// how often discovery finds something worth showing, how often it is wrong, and how often it
// finds nothing at all. None of those need the user's words.
//
// **The raw task text is never written.** It is not needed for any of the three questions, and
// storing it would turn a feature that observes the router into one that accumulates session
// content — a new privacy surface, created by an observability feature. What IS written is what
// was matched: which tokens landed, in which fields, with which scores.
//
// Bounded by design: a byte cap with rotation to a single `.1` file, so leaving it on for weeks
// cannot grow without limit.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where the recorder writes. One line per discovered task, JSONL. */
export function defaultDiscoveryLogPath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : process.env.USERPROFILE !== undefined && process.env.USERPROFILE !== '' ? process.env.USERPROFILE + '/.dsh' : undefined
  return home === undefined ? undefined : home + '/skill-router/discovery.jsonl'
}

/**
 * One JSONL telemetry sink.
 *
 * `appendFileSync` on purpose: the record is one line, the alternative is a write stream whose
 * lifecycle outlives the plugin, and a dropped stream is how telemetry silently stops looking
 * like data and starts looking like nothing happened.
 *
 * @param path - file to append to; `undefined` disables recording.
 * @param maxBytes - rotate to `<path>.1` past this size.
 */
export function makeDiscoveryRecorder(path, maxBytes) {
  const target = path === undefined || path === null || path === '' ? undefined : String(path)
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 4 * 1024 * 1024
  let ready = false
  return {
    path: target,
    /**
     * Append one record. Never throws: telemetry is not worth a broken turn.
     *
     * @param record - counters and names only; the caller must not pass user text.
     */
    write(record) {
      if (target === undefined) return false
      try {
        if (ready === false) {
          mkdirSync(dirname(target), { recursive: true })
          ready = true
        }
        try {
          if (statSync(target).size >= cap) renameSync(target, target + '.1')
        } catch {
          /* no file yet, or rotation refused: appending to it is still correct */
        }
        appendFileSync(target, JSON.stringify(record) + '\n', 'utf8')
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Build the record for one discovery attempt.
 *
 * Kept a pure function so the shape can be pinned by a test: the guarantee that no user text
 * reaches the file is a property of this function, and a guarantee nothing checks is a comment.
 *
 * @param input - `{ turn, step, result, elapsedMs, indexRows, injected, hintBytes }`.
 * @returns a flat, JSON-safe record with no free-form user content.
 */
export function discoveryRecord(input) {
  const source = input === null || input === undefined ? {} : input
  const result = source.result === null || source.result === undefined ? {} : source.result
  const candidates = Array.isArray(result.candidates) ? result.candidates : []
  return {
    at: new Date().toISOString(),
    turn: typeof source.turn === 'number' ? source.turn : null,
    step: typeof source.step === 'number' ? source.step : null,
    tier: typeof result.tier === 'string' ? result.tier : 'NONE',
    reason: typeof result.reason === 'string' ? result.reason : 'unknown',
    // How many keywords the task yielded. A count, never the words themselves.
    tokenCount: Array.isArray(result.tokens) ? result.tokens.length : 0,
    indexRows: typeof source.indexRows === 'number' ? source.indexRows : null,
    elapsedMs: typeof source.elapsedMs === 'number' ? Math.round(source.elapsedMs) : null,
    candidateCount: candidates.length,
    // The one field that would be tempting to fill with prose. It stays names.
    candidates: candidates.map((c) => ({
      name: String(c.name),
      score: typeof c.score === 'number' ? c.score : null,
      matched: typeof c.matched === 'number' ? c.matched : null,
      nameHits: typeof c.nameHits === 'number' ? c.nameHits : null,
      fields: Array.isArray(c.fields) ? c.fields.slice() : [],
    })),
    injected: source.injected === true,
    // How many bytes the hint actually added to this turn's context. Recorded rather than
    // assumed: the whole case for injecting rests on this number being small, and an estimate
    // in a design note is not evidence. 0 when nothing was injected.
    hintBytes: typeof source.hintBytes === 'number' && source.hintBytes > 0 ? Math.round(source.hintBytes) : 0,
  }
}

/**
 * Build the record written when a turn's tool calls are counted.
 *
 * **Why this is a separate record, and why it is written at the END of a turn.** The discovery
 * record above is written at `step === 1`, which is *before* the model has done anything — at that
 * moment nobody can know whether this turn will end up calling `skill_search`. Asking the trigger
 * question ("did the hint make the agent search?") therefore needs a second observation taken
 * after the turn is over, joined to the first by `turn`.
 *
 * Only counts. No tool arguments, no skill bodies, no user text — the question is whether the
 * agent searched and loaded, not what it said.
 *
 * @param input - `{ turn, tier, injected, calls }`.
 * @returns a flat, JSON-safe record.
 */
export function turnCallsRecord(input) {
  const source = input === null || input === undefined ? {} : input
  const calls = source.calls === null || source.calls === undefined ? {} : source.calls
  const count = (value) => (typeof value === 'number' && value > 0 ? Math.round(value) : 0)
  return {
    at: new Date().toISOString(),
    kind: 'turn-calls',
    turn: typeof source.turn === 'number' ? source.turn : null,
    // Copied in so a reader can join this to the discovery record without a second pass, and so
    // the A/B comparison (injected vs not) works on one line.
    tier: typeof source.tier === 'string' ? source.tier : null,
    injected: source.injected === true,
    skillSearchCalls: count(calls.skill_search),
    skillLoadCalls: count(calls.skill_load),
    skillRefCalls: count(calls.skill_ref),
    // The native DSH `skill` tool, i.e. the resident catalog. Counted separately because it is a
    // different question: "did the agent use a resident skill" is not "did it use the library".
    residentSkillCalls: count(calls.skill),
    otherToolCalls: count(source.otherToolCalls),
  }
}
