// Skill library router — search/load a staged .skill-src library as native model tools.
//
// Why: the session skill catalog is injected into every model request, so resident
// skills cost tokens on every turn. Keeping the library OUT of the catalog and
// reachable through three tools moves that cost to "paid only when used".
//
// One implementation, two seams. The registration seam is a parameter, so the same code
// works whether it is driven by the durable DSH plugin entry (`apply` at the bottom of
// this file) or by a caller that passes its own `register`:
//   buildSkillRouterTools(ctx, register)
// Only the durable entry point ships with this repository.
//
// PORTABILITY RULE (learned the hard way, 2026-09-23): this file must not depend on
// which `defineTool` it receives. A dev-only shim once sat in the package's own
// node_modules and shadowed @deepseek-ai/dsh-tools, so `defineTool` became an identity
// function, the author DSL (`output.schema: { type: 'json' }`) reached the tool registry
// uncompiled, and the whole plugin tree refused to load:
//   unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
// Hence: parameters are built locally in compiled JSON Schema shape, and every schema
// literal below is already valid JSON Schema. `defineTool` then only attaches behaviour.

const MAX_LISTED = 8
const DEFAULT_DESC = 220
const LOAD_CAP = 120000

/**
 * Words that carry no signal in a keyword search, dropped before scoring.
 *
 * Deliberately short: it holds English function words and the most generic verbs, not
 * domain vocabulary. A word like `test` or `config` is common but meaningful — filtering
 * by "appears everywhere" instead of by "means nothing" would break the queries that
 * work. Single characters are dropped separately in `tokenize`.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for',
  'from', 'get', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'make',
  'me', 'my', 'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'use', 'using', 'want', 'was', 'we',
  'what', 'when', 'which', 'will', 'with', 'you', 'your',
])

/**
 * Build a registry-ready tool definition without relying on the runtime's defineTool.
 *
 * `parameters` is accepted in either shape and normalized to standard JSON Schema, so
 * the result is registration-safe whether the runtime compiles schemas or passes them
 * through untouched:
 *   - author DSL: a property map whose entries may carry the author-only `required: true`;
 *   - already-compiled JSON Schema: an object-rooted schema, passed through unchanged
 *     (re-compiling it would nest the schema under a `type` property).
 *
 * @param definition - tool definition whose `parameters` is one of those two shapes.
 * @returns the same definition with standard-schema `parameters`.
 */
export function definePortableTool(definition) {
  const spec = definition.parameters
  const looksCompiled =
    spec !== null &&
    typeof spec === 'object' &&
    !Array.isArray(spec) &&
    spec.type === 'object' &&
    typeof spec.properties === 'object' &&
    spec.properties !== null
  // Already-compiled schema: pass it through, adding only the strictness the registry
  // expects. Re-compiling it would nest the whole schema under a `type` property.
  if (looksCompiled) {
    return {
      ...definition,
      parameters: {
        ...spec,
        required: Array.isArray(spec.required) ? spec.required : [],
        additionalProperties: spec.additionalProperties ?? false,
      },
    }
  }

  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    const emitted = { ...value }
    if (emitted.required === true) {
      delete emitted.required
      required.push(key)
    }
    properties[key] = emitted
  }
  return {
    ...definition,
    parameters: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false,
    },
  }
}

export const SEARCH_DESCRIPTION =
  'Search every skill available to this agent: the session skill catalog plus the staged library (a .skill-src/skill-index.tsv found at or above the session workspace). ' +
  'Anything the library holds sits OUTSIDE the catalog, so it exists for you only through this tool. ' +
  'Plain lowercase keywords, AND-ed across skill name, description and upstream repo. ' +
  'This is how the agent selects its own skills — do not ask the user which one to use. ' +
  'Call it before any non-trivial task, whenever the subject may have a specialized procedure: ' +
  'test authoring, security or dependency review, documentation, deployment, performance, accessibility, a specific framework or protocol. ' +
  'Also call it before telling the user a capability is missing, and before improvising a process you suspect already exists. ' +
  'Returns names, repos, a copies count and absolute SKILL.md paths; load what fits with skill_load.'

export const LOAD_DESCRIPTION =
  'Load the full instructions of one or more skills into context, then follow them. Searches the staged library first, then the resident catalog (the session skill catalog and its bundled skills); the `source` field says which one answered. ' +
  'If neither has the name, the error explains which was searched and what to do about it. ' +
  'Use it right after skill_search, with every skill the task needs in one call — pass `names` (comma-separated) for several, or call it twice. The returned text IS the task instructions, and a skill often points at further files. ' +
  'Also the way to load a skill that is not in the catalog for automatic invocation. ' +
  'Resolve any relative path a skill mentions (scripts/, references/, assets/) against the returned base directory.'

function isRecord(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * Drop trailing forward slashes without a regular expression.
 *
 * This was `.replace(/\/+$/, '')`, which CodeQL flagged as polynomial (js/polynomial-redos).
 * The flag is correct and measurable: `/\/+$/` anchored at `$` makes the engine retry from
 * every start position, eating the remaining slashes and then backtracking to compare the
 * anchor, so a string of N slashes that does **not** end in a slash costs O(N²). Timed here:
 * 64,000 slashes took ~2,000 ms against ~0 ms for this loop, a 775,000× ratio, with the
 * growth quadrupling each time N did.
 *
 * The input is a skill name read from the index or a tool argument, so the practical exposure
 * is small — it is a local file, and there is no network path. It is still a free fix, and a
 * loop is not merely faster: it cannot backtrack at all.
 *
 * It strips BOTH separators, because the regex it replaces (`/[\\/]+$/`) did: a Windows path
 * ending in `\` must lose it too. It first stripped only `/`, which silently made it an
 * inequivalent substitute for the three other call sites still using that regex — measured, it
 * disagreed on 8 of 19 cases, all backslash-terminated, and the first of those call sites reads
 * the session cwd (a Windows cwd commonly ends in `\`).
 */
function stripTrailingSlashes(text) {
  let end = text.length
  while (end > 0) {
    const code = text.charCodeAt(end - 1)
    if (code !== 47 && code !== 92) break
    end -= 1
  }
  return end === text.length ? text : text.slice(0, end)
}

function normName(value) {
  let text = stripTrailingSlashes(String(value ?? '').trim().replace(/\\/g, '/'))
  // Both of these are anchored single-character or fixed alternatives: no quantifier can
  // match the same input two ways, so neither can backtrack.
  text = text.replace(/^@/, '').replace(/\/SKILL\.md$/i, '')
  const parts = text.split('/')
  return (parts[parts.length - 1] ?? '').trim()
}

function isSafeName(name) {
  return /^[a-z0-9][a-z0-9-]*$/.test(name)
}

/**
 * Normalize one requested skill name into a single string.
 *
 * Multi-name calls reach a tool as any of three shapes depending on the transport, and a
 * bare `["a","b"]` that arrives as the string `'["a","b"]'` silently matches a string
 * branch of a `oneOf` and is then treated as one (nonexistent) skill name. Handling all
 * three here is what makes batch loading robust:
 *   - a real array (direct in-process callers, tests);
 *   - a JSON-encoded array (a stringified argument);
 *   - a plain name, possibly with several names separated by commas, semicolons or newlines.
 */
function splitRequestedNames(value) {
  const out = []
  const push = (entry) => {
    const text = String(entry ?? '').trim()
    if (text !== '') out.push(text)
  }
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item)
      return
    }
    if (entry === null || entry === undefined) return
    const text = String(entry).trim()
    if (text === '') return
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          visit(parsed)
          return
        }
      } catch {
        /* not JSON after all: fall through and treat it as a literal name */
      }
    }
    if (/[,;\n]/.test(text)) {
      for (const part of text.split(/[,;\n]+/)) push(part)
      return
    }
    push(text)
  }
  visit(value)
  return out
}

function joinPath(dir, child) {
  if (dir === '') return child
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + child : dir + '/' + child
}

// A note for whoever comes looking for `collectSkillUsage` in this file: it was here, and it
// was DELETED — along with `usageArgsOf` and `USAGE_MAX_NAMES` — because its data contract was
// false. It read the conversation out of `useChat`'s `legacy.nodes` and treated those nodes as
// the session history. They are not: a live snapshot held 210 nodes with ZERO tool calls while
// the session ledger held 2,778+ events including them. Anything that wants skill usage must
// read `ctx.sessions.binding(sessionId).eventSource`; that is what the Client tab does now, and
// `test/usage-ledger.mjs` pins the shape it reads. A second, host-side copy of the same logic is
// how the two drifted apart to begin with, so it is not coming back.

/**
 * Collapse a path to forward slashes with `.` and `..` resolved, without importing
 * `node:path` — this plugin has no imports at all, and the containment check for
 * `skill_ref` needs one canonical spelling to compare against.
 *
 * Pure string work on purpose: it must not touch the filesystem, because the whole point
 * is to reject `../` before any I/O happens. Exported so the containment rule can be unit
 * tested directly rather than only through a live tool call.
 *
 * @param path - any mix of separators.
 * @returns the normalized path (a leading `/` or `X:` root is preserved).
 */
export function resolvePath(path) {
  const text = String(path ?? '').replace(/\\/g, '/')
  const root = /^[A-Za-z]:\//.test(text) ? text.slice(0, 3) : text.startsWith('/') ? '/' : ''
  const parts = []
  for (const segment of text.slice(root.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return root + parts.join('/')
}

function splitLines(text) {
  const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Split one TSV row, honoring double-quoted fields with doubled-quote escaping. */
function splitFields(line) {
  const fields = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === '\t') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/**
 * Normalize an index description. The scanner emits the raw frontmatter value,
 * so a YAML block scalar arrives with its `>`/`|` marker still attached
 * (`>- Runs a Semgrep scan…). Left in place, that marker is just noise the
 * keyword matcher must skip; strip it here so both the model text and the
 * matching see a clean sentence.
 */
function cleanDescription(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim()
  text = text.replace(/^[>|][+-]?\s*/, '')
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) text = text.slice(1, -1)
  return text.trim()
}

/**
 * `skill-index.tsv` — rows. Header is `repo  relpath  name  description  files  KB`.
 *
 * A byte-order mark on the first line used to turn the header into a data row, because the
 * mark glues itself to the first field: `repo === 'repo'` compared against `\uFEFF"repo"`
 * and never matched. The result was a skill literally named `name`, living at
 * `\uFEFF"repo/relpath/SKILL.md`, which search would happily return and load would then
 * report as missing. BOM-prefixed UTF-8 is what several Windows writers produce — including
 * PowerShell's `Export-Csv` — so this is the normal case, not a corner one.
 */
function parseIndex(text) {
  const rows = []
  for (const line of splitLines(text)) {
    if (line === '') continue
    const fields = splitFields(line)
    // Strip a leading BOM and any stray wrapping quotes before reading the row: the column
    // names may or may not be quoted depending on which writer produced the file.
    const cell = (index) => String(fields[index] ?? '').replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim()
    const repo = cell(0)
    const relpath = cell(1).replace(/\\/g, '/')
    const name = cell(2)
    // Skip the header by shape, not by an exact string, so a quoted, unquoted or BOM-
    // prefixed header all read the same.
    if (repo === 'repo' && name === 'name') continue
    if (name === '' || relpath === '') continue
    rows.push({
      name,
      repo,
      relpath,
      description: cleanDescription(fields[3]),
      files: cell(4),
      // Optional 7th column. A skill may carry a `whenToUse` frontmatter field, which
      // upstream libraries usually leave empty (in the library this was developed against,
      // 0 of 1025 rows), so its absence must stay a normal case rather than a parse error.
      // When a writer does emit it, it is trigger phrasing by definition and is scored as
      // such.
      whenToUse: cleanDescription(fields[6]),
    })
  }
  return rows
}

function tokenize(query) {
  const tokens = []
  const normalized = String(query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#._-]+/g, ' ')
  for (const token of normalized.split(' ')) {
    if (token === '' || tokens.includes(token)) continue
    if (tokens.length >= 12) break
    tokens.push(token)
  }
  // Drop articles and other filler, but never to the point of having no keyword at all: a
  // query of "the" alone must still say something useful rather than "no keywords".
  //
  // Measured: searching "make a movie" against a 1026-row library returned the whole
  // library, top-ranked on rows containing "make" and "a" — "a" alone scored +130 because
  // the weights reward any name/path hit equally. Words with no discriminative power do
  // not belong in a ranking.
  const meaningful = tokens.filter((token) => token.length > 1 && STOP_WORDS.has(token) === false)
  return meaningful.length > 0 ? meaningful : tokens
}

/**
 * Field weights, in one place because two callers rank with them.
 *
 * `name` beats `whenToUse` because a name hit is the thing itself; `whenToUse` beats
 * `description` because trigger phrasing says more about *intent* than prose does; `path`
 * is a weak tiebreaker. An exact name match short-circuits the lot.
 */
const WEIGHT = { name: 100, whenToUse: 40, description: 24, path: 6, exactName: 400 }

/**
 * Score one index row against a token list.
 *
 * Pure, and deliberately free of any query POLICY: whether a partial match is acceptable, and
 * what to do when nothing matches everything, belongs to the caller. `skill_search` runs it
 * twice (strict AND, then the all-but-one rescue); the discovery layer runs it once with
 * `requireAll: false` — see `discoverRows` for why that difference is not a detail.
 *
 * @param row - one parsed index row.
 * @param context - `{ tokens, requireAll, explaining, exactText }`.
 * @returns the scored hit, or `undefined` when `requireAll` is set and a token missed.
 */
function scoreRow(row, context) {
  const ctx = context === null || context === undefined ? {} : context
  const tokens = Array.isArray(ctx.tokens) ? ctx.tokens : []
  const requireAll = ctx.requireAll === true
  const explaining = ctx.explaining === true
  const nameText = String(row.name ?? '').toLowerCase()
  const descText = String(row.description ?? '').toLowerCase()
  // `whenToUse` is optional in the index; an absent one must not match every token.
  const whenRaw = row.whenToUse === null || row.whenToUse === undefined ? '' : String(row.whenToUse)
  const whenText = whenRaw.toLowerCase()
  const pathText = String(row.repo ?? '') + '/' + String(row.relpath ?? '')
  const lowerPath = pathText.toLowerCase()

  let score = 0
  let nameHits = 0
  let matchCount = 0
  const why = explaining ? [] : undefined
  for (const token of tokens) {
    let part = 0
    const fields = []
    if (nameText.includes(token)) {
      part += WEIGHT.name
      nameHits += 1
      fields.push('name')
    }
    if (descText.includes(token)) {
      part += WEIGHT.description
      fields.push('description')
    }
    if (whenText !== '' && whenText.includes(token)) {
      part += WEIGHT.whenToUse
      fields.push('whenToUse')
    }
    if (lowerPath.includes(token)) {
      part += WEIGHT.path
      fields.push('path')
    }
    if (part === 0) {
      if (requireAll) return undefined
      if (why !== undefined) why.push(token + ': -')
      continue
    }
    matchCount += 1
    score += part
    if (why !== undefined) why.push(token + ': +' + String(part) + ' (' + fields.join('+') + ')')
  }
  const exact = String(ctx.exactText ?? '').trim().toLowerCase() !== '' && nameText === String(ctx.exactText).trim().toLowerCase()
  if (exact) score += WEIGHT.exactName
  if (why !== undefined && exact) why.push('exact name: +' + String(WEIGHT.exactName))
  return { row, score, matchCount, nameHits, why, listed: tokens.length > 0 && nameHits === tokens.length ? 1 : 0 }
}

/** Shorten one display line (search hit descriptions). Silent by design: this is presentation. */
function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '\u2026'
}

// ── discovery: cheap, local, and deliberately NOT a search ───────────────────────────────
//
// The problem this exists for: a library skill is invisible to the model, so using one requires
// the model to first THINK of searching. That is a trigger problem, not a retrieval problem, and
// it is the gap between "the agent can find a skill" and "the agent always considers one".
//
// So discovery answers a weaker question than `skill_search` does — not "which skill matches
// this query" but "which few names are worth the agent's attention here" — and it is allowed to
// be wrong in the direction of saying nothing.
//
// Two properties are load-bearing:
//
//   * It NEVER loads anything. Choosing stays with the agent; a discovery that pre-empted the
//     choice would be the "router replaces the agent" shape this repository exists to avoid.
//   * It shares `scoreRow` with `skill_search` and shares NOTHING of that tool's query policy.
//     `skill_search` demands every token, then rescues with all-but-one, then refuses a "weak"
//     rescue — correct for a short model-written query, and fatal for a task sentence. A task is
//     prose: "分析这个 React 项目的性能问题" has no interpretation under strict AND.

/** How many candidate names discovery may offer. Five is about a line of text, not a list. */
const DISCOVERY_LIMIT = 5
/** Below this, a row is not a candidate — one `path` fragment (+6) must not earn a mention. */
const DISCOVERY_MIN_SCORE = 24
/** A task sentence longer than this gets truncated to its first tokens, in order. */
const DISCOVERY_MAX_TOKENS = 12
/**
 * Independent tokens required for the top tier. One lucky word matching one `whenToUse` line is
 * a coincidence; two different words landing is a signal.
 */
const DISCOVERY_STRONG_MATCHES = 2

/**
 * Rank index rows for a task sentence. Pure — no I/O, no clock, no telemetry.
 *
 * @param rows - parsed index rows.
 * @param taskText - the raw user task; may be any language.
 * @param limit - maximum candidates.
 * @returns `{ candidates, tokens, tier, reason }`. `reason` is a code, never user text.
 */
export function discoverRows(rows, taskText, limit) {
  const capped = typeof limit === 'number' && limit > 0 ? limit : DISCOVERY_LIMIT
  const list = Array.isArray(rows) ? rows : []
  // `tokenize` is the same tokenizer the search tool uses — the index is one Latin-script
  // token set, and inventing a second one would let the two disagree about what a keyword is.
  const all = tokenize(taskText)
  const tokens = all.slice(0, DISCOVERY_MAX_TOKENS)
  // A Chinese or Japanese task yields no tokens at all, because the index is matched on Latin
  // script. That is a property of the index, not a bug to paper over: report the code and let
  // the dry run measure how often it happens.
  if (tokens.length === 0) return { candidates: [], tokens: [], tier: 'NONE', reason: 'no-searchable-token' }

  const hits = []
  for (const row of list) {
    const scored = scoreRow(row, { tokens, requireAll: false, explaining: false, exactText: taskText })
    if (scored === undefined || scored.score < DISCOVERY_MIN_SCORE) continue
    hits.push(scored)
  }
  if (hits.length === 0) return { candidates: [], tokens, tier: 'NONE', reason: 'no-candidate' }

  // Deterministic: score, then how many tokens landed, then how many hit the name, then the
  // name — so the same task always yields the same list, which the dry run depends on.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
    return String(a.row.name).localeCompare(String(b.row.name))
  })

  const candidates = hits.slice(0, capped).map((hit) => ({
    name: String(hit.row.name),
    repo: String(hit.row.repo),
    relpath: String(hit.row.relpath),
    score: hit.score,
    matched: hit.matchCount,
    nameHits: hit.nameHits,
    // WHICH fields matched, not why the agent should care — names only, no prose, because the
    // injection budget is the whole point (measured: five names plus a hint is ~142 bytes).
    fields: matchedFields(hit.row, tokens),
  }))

  const best = hits[0]
  const runnerUp = hits[1]
  let tier = 'MEDIUM'
  if (best.nameHits > 0 && best.matchCount >= DISCOVERY_STRONG_MATCHES) tier = 'HIGH'
  // A single candidate that just clears the floor is not a strong suggestion, and two candidates
  // that score about the same mean the ranking itself is unsure. Both are the same fact to the
  // dry run: this task's outcome should be read with care.
  else if (runnerUp === undefined || best.score < runnerUp.score * 1.25) tier = 'NONE'
  return { candidates, tokens, tier, reason: 'ok' }
}

/** Which of the four weighted fields each matched token landed in — for telemetry, not display. */
function matchedFields(row, tokens) {
  const fields = []
  const nameText = String(row.name ?? '').toLowerCase()
  const descText = String(row.description ?? '').toLowerCase()
  const whenText = String(row.whenToUse ?? '').toLowerCase()
  const pathText = (String(row.repo ?? '') + '/' + String(row.relpath ?? '')).toLowerCase()
  if (tokens.some((t) => nameText.includes(t))) fields.push('name')
  if (tokens.some((t) => whenText !== '' && whenText.includes(t))) fields.push('whenToUse')
  if (tokens.some((t) => descText.includes(t))) fields.push('description')
  if (tokens.some((t) => pathText.includes(t))) fields.push('path')
  return fields
}
/**
 * Clamp a body to `max` characters and say whether anything was dropped.
 *
 * The previous version returned only the text and its callers guessed with
 * `text.length > max`, which can never be true after a clamp — so an oversized body was
 * reported as clean. Returning the truncation fact alongside the text is what makes the
 * warning trustworthy.
 *
 * @param text - the full body.
 * @param max - inclusive character cap.
 * @returns the body (clamped to `max` when needed) and whether it lost characters.
 */
function clampBody(text, max) {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length }
  return { text: text.slice(0, max - 1) + '\u2026', truncated: true, originalLength: text.length }
}

/** The tool runtime requires lossless-JSON return values: no undefined, no live objects. */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Build the two tool definitions against one plugin context.
 *
 * The definitions are assembled with `definePortableTool`, so they reach the registry
 * as standard JSON Schema. That is what makes them registration-safe regardless of the
 * runtime's own defineTool: `tools.register` validates `output.schema` at registration
 * and compiles `parameters` at execution, and both are already in the enforced subset.
 *
 * @param ctx - Cordis context exposing `fs` (and optionally `skills`).
 * @param register - runtime-specific registration seam: `(toolName, tool) => void`.
 */
export function buildSkillRouterTools(ctx, register) {
  let indexCache = null
  let rootDir = ''
  // name (lowercased) -> copies in the current library. Filled by loadIndex.
  let nameCounts = new Map()

  /** How many library rows share this skill name; >1 means skill_load needs a repo hint. */
  function copiesOf(name) {
    return nameCounts.get(String(name).toLowerCase()) ?? 1
  }

  /**
   * Turn one index row into a path on disk. Never throws.
   *
   * `ctx.fs.resolve` is only called on a path that exists (it throws otherwise), so a row
   * whose directory has been deleted used to take down the whole tool call: a single stale
   * entry — the expected result of deleting a skill directory and not regenerating the
   * index — made `skill_search` throw ENOENT instead of answering. Search is a read-only
   * lookup; it must not fail because one row in the index is out of date.
   *
   * `missing` is what lets a caller distinguish "this row is stale" from "this row is
   * fine", so the stale entries can be reported rather than silently offered.
   */
  async function resolveRow(row) {
    const joined = joinPath(joinPath(joinPath(rootDir, row.repo), row.relpath), 'SKILL.md')
    let path = joined
    let directory = stripTrailingSlashes(joined.slice(0, Math.max(0, joined.length - 'SKILL.md'.length)))
    let missing = false
    try {
      const target = await ctx.fs.resolve(joined)
      const display = String(target.displayPath ?? joined)
      path = display
      directory = stripTrailingSlashes(display.slice(0, Math.max(0, display.length - 'SKILL.md'.length)))
      const info = await ctx.fs.stat(target)
      missing = info === undefined
    } catch {
      missing = true
    }
    return { directory, path, missing }
  }

  /**
   * 与插件一起发布的入门技能库的绝对路径。
   *
   * 它让"装完就能用"成立：用户不必先准备自己的库，`skill_search` 就有东西可搜。**它不是常驻技能**——
   * 它在 `resources/starter-skills/` 下、以 `identifier === 'starter'` 出现在同一个索引契约里，所以
   * 它走的是 `skill_search` / `skill_load` 这条路，一个字节都不会进 DSH 的常驻目录。把入门技能放进
   * `.dsh/skills/` 会立刻让它们每轮进上下文，那正好毁掉这个插件的全部意义。
   *
   * 只在用户自己的库缺失时才用。`import.meta.url` 在这里可用（本文件以 ESM 加载，已实测），
   * 而整段都在 try 里：`import.meta` 万一不可用（例如某个宿主把它当经典脚本拼接），回退只是不生效，
   * 绝不能因此让插件加载失败。
   */
  async function bundledLibraryRoot() {
    try {
      const here = dirnamePath(fileURLToPath(import.meta.url))
      const root = joinPath(joinPath(here, 'resources'), 'starter-skills')
      const target = await ctx.fs.resolve(joinPath(root, 'skill-index.tsv'))
      const info = await ctx.fs.stat(target)
      return info !== undefined && info.type === 'file' ? { root, target, version: String(info.version) } : undefined
    } catch {
      return undefined
    }
  }

  /** Walk up from the session cwd to the directory holding .skill-src/skill-index.tsv. */
  async function resolveRoot(cwd) {
    let dir = stripTrailingSlashes(String(cwd ?? ''))
    // Eight levels is a floor, not a recommendation: the library is normally at the
    // workspace root, and this only has to cover a session started in a nested project.
    for (let i = 0; i < 8 && dir !== ''; i += 1) {
      let target
      try {
        target = await ctx.fs.resolve(joinPath(joinPath(dir, '.skill-src'), 'skill-index.tsv'))
      } catch {
        target = undefined
      }
      if (target !== undefined) {
        let info
        try {
          info = await ctx.fs.stat(target)
        } catch {
          info = undefined
        }
        if (info !== undefined && info.type === 'file') {
          const display = target.displayPath
          const parent = display.slice(0, Math.max(0, display.length - 'skill-index.tsv'.length))
          return { root: stripTrailingSlashes(parent), indexTarget: target, version: String(info.version), bundled: false }
        }
      }
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (cut <= 0) break
      dir = dir.slice(0, cut)
    }
    // 用户没有自己的库：用随插件发布的入门库。标记 `bundled`，好让工具返回值说清"这些是入门技能、
    // 不是你自己的库"，否则用户会以为自己的库被读到了。
    const bundled = await bundledLibraryRoot()
    if (bundled !== undefined) return { root: bundled.root, indexTarget: bundled.target, version: bundled.version, bundled: true }
    return { root: '', indexTarget: undefined, version: '', bundled: false }
  }

  /** Parse + cache the index; the fs version invalidates the cache when the file changes. */
  async function loadIndex(cwd, signal) {
    const located = await resolveRoot(cwd)
    if (located.root === '') {
      return {
        rows: [],
        root: '',
        bundled: false,
        error:
          'no .skill-src/skill-index.tsv at or above the session workspace ' +
          (String(cwd) === '' ? '(unknown)' : String(cwd)) +
          '. The plugin README covers where the library goes and how to generate its index.',
      }
    }
    rootDir = located.root
    const key = located.root + '|' + located.version
    if (indexCache !== null && indexCache.key === key) return indexCache.value
    const text = await ctx.fs.readText(located.indexTarget, signal)
    const rows = parseIndex(text)
    const counts = new Map()
    for (const row of rows) {
      const key = row.name.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    nameCounts = counts
    // `bundled` 一路带到工具返回值：用户看到的是入门技能时必须说清楚，否则他会以为
    // 自己的库被读到了（而那时真正的诊断方向完全不同）。
    const value = { rows, root: located.root, error: '', bundled: located.bundled === true }
    indexCache = { key, value }
    return value
  }

  /** Bounded fallback scan for a library skill missing from the index. */
  async function walkForSkill(dir, wanted, budget, depth, signal) {
    if (budget.left <= 0 || depth > 3) return ''
    budget.left -= 1
    let entries
    try {
      entries = await ctx.fs.listDir(await ctx.fs.resolve(dir, { signal }), signal)
    } catch {
      return ''
    }
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const child = joinPath(dir, entry.name)
        if (entry.name.toLowerCase() === wanted) {
          try {
            const probe = await ctx.fs.resolve(joinPath(child, 'SKILL.md'), { signal })
            const info = await ctx.fs.stat(probe, signal)
            if (info !== undefined && info.type === 'file') return child
          } catch {
            /* keep walking */
          }
        }
        const found = await walkForSkill(child, wanted, budget, depth + 1, signal)
        if (found !== '') return found
      } else if (entry.name.toLowerCase() === wanted + '.md') {
        return dir
      }
    }
    return ''
  }

  async function scanForSkill(wanted, signal) {
    if (rootDir === '') return ''
    return await walkForSkill(rootDir, wanted, { left: 120 }, 0, signal)
  }

  /**
   * Resolve a skill name (plus optional repo hint) to its directory on disk.
   * Shared by skill_load and skill_ref so both agree on which copy of a name wins.
   * @returns `{ directory, repo, copies }`, or `{ error }` when nothing matches.
   */
  async function locateSkill(rawName, repoHint, cwd, signal, exec) {
    const wanted = normName(String(rawName ?? ''))
    const wantedLower = wanted.toLowerCase()
    const wantedRepo = String(repoHint ?? '').trim().toLowerCase()
    if (wanted === '') return { error: 'a skill name is required' }
    const loaded = await loadIndex(cwd, signal)
    if (loaded.rows.length > 0) {
      // Deterministic pick among duplicates: explicit repo first, then the shallowest
      // relpath, which selects `skills/<name>` over `plugins/<x>/skills/<name>`.
      const byName = loaded.rows.filter((row) => row.name.toLowerCase() === wantedLower)
      let candidates = byName
      if (wantedRepo !== '') candidates = candidates.filter((row) => row.repo.toLowerCase().indexOf(wantedRepo) >= 0)
      if (byName.length > 0 && candidates.length === 0) {
        const repos = [...new Set(byName.map((row) => row.repo))].sort()
        return { error: 'skill "' + wanted + '" is not in a repo matching "' + wantedRepo + '"; it exists in: ' + repos.join(', ') }
      }
      candidates.sort((a, b) => {
        const depthA = a.relpath.split('/').filter(Boolean).length
        const depthB = b.relpath.split('/').filter(Boolean).length
        if (depthA !== depthB) return depthA - depthB
        if (a.relpath.length !== b.relpath.length) return a.relpath.length - b.relpath.length
        return a.relpath < b.relpath ? -1 : 1
      })
      const winner = candidates[0]
      if (winner !== undefined) {
        const located = await resolveRow(winner)
        return { directory: located.directory, repo: winner.repo, copies: copiesOf(winner.name) }
      }
    }
    if (isSafeName(wantedLower)) {
      const scanned = await scanForSkill(wantedLower, signal)
      if (scanned !== '') return { directory: scanned, repo: '', copies: 1 }
    }
    if (wantedRepo !== '') {
      return { error: 'no skill named "' + wanted + '" in a repo matching "' + wantedRepo + '"' }
    }
    return { error: 'no skill named "' + wanted + '" in the library. Call skill_search to find the exact name.' }
  }

  const searchTool = definePortableTool({
    name: 'skill_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword(s) describing the task or subject, e.g. "kubernetes helm", "seo", "remotion video", "rust cli".',
        },
        limit: { type: 'integer', description: 'Maximum matches to return (1-40, default 12).' },
        repo: {
          type: 'string',
          description: 'Optional repo filter, matched case-insensitively against the upstream directory name, e.g. "trailofbits" or "microsoft-skills".',
        },
        names_only: { type: 'boolean', description: 'Return only names and repos, with no descriptions, when you just need to see what exists.' },
        explain: {
          type: 'boolean',
          description: 'Also return how each hit scored, per keyword and per field. Use it to diagnose a search that returned nothing or the wrong thing — it shows which field matched and by how much.',
        },
      },
      required: ['query'],
    },
    output: {
      // Standard JSON Schema, valid whether or not the runtime compiles it.
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const result = isRecord(value) ? value : {}
        const hits = Array.isArray(result.hits) ? result.hits : []
        // When the strict pass found nothing and the loose pass rescued the query, the
        // header must not read like a normal result set. "1026 match(es)" for a query that
        // matched nothing exactly is the misleading case: measured on a 1026-row library,
        // "make a movie" reported the whole library as matches, every one of them ranked on
        // words that carry no signal.
        const loose = Number(result.strict) === 0 && result.fallback === 'or'
        const weak = result.fallback === 'weak'
        const headline = loose
          ? '0 exact match(es); ' + String(result.total) + ' partial match(es) in ' + String(result.library)
          : weak
            ? 'no match in ' + String(result.library)
            : String(result.total) + ' match(es) in ' + String(result.library)
        const lines = [
          headline +
            '; showing ' +
            String(hits.length) +
            (result.more === true ? ' (more available)' : '') +
            (loose ? ' — no entry contained every keyword, so these match all but one' : ''),
        ]
        for (const hit of hits) {
          lines.push(
            '- ' + String(hit.name) + '  [' + String(hit.repo) + ']' + (String(hit.description) === '' ? '' : '\n    ' + String(hit.description)),
          )
          // Surface the trigger phrasing only when it says something the description does
          // not, so a library that fills both does not pay for the duplication twice.
          if (String(hit.whenToUse) !== '' && String(hit.whenToUse) !== String(hit.description)) {
            lines.push('    when: ' + String(hit.whenToUse))
          }
          if (Array.isArray(hit.why)) {
            lines.push('    why: ' + hit.why.join('; '))
          }
          // A stale row is the one case where the skill cannot be loaded at all, so say it
          // where the model is choosing, not only when the load fails later.
          if (hit.stale === true) lines.push('    STALE: SKILL.md is missing — regenerate the index')
        }
        if (String(result.error) !== '') lines.push('error: ' + String(result.error))
        // The note tells the model to pass `repo` when copies > 1, so the count has to be
        // visible: the JSON carries it, but the model reads this text, not the JSON.
        const duplicated = hits.filter((hit) => Number(hit.copies) > 1)
        const duplicatedRepos = new Set(duplicated.map((hit) => String(hit.repo)))
        if (duplicated.length > 1 && duplicatedRepos.size > 1) {
          lines.push(
            'note: ' + String(duplicated.length) + ' of these are copies of a name that exists in several repos (' + [...duplicatedRepos].join(', ') + '); pass repo to skill_load to choose.',
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = isRecord(args) ? args : {}
      const limit =
        typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.max(1, Math.min(40, Math.floor(input.limit))) : 12
      const namesOnly = input.names_only === true
      const explaining = input.explain === true
      const descLength = namesOnly ? 0 : DEFAULT_DESC
      const repoFilter = typeof input.repo === 'string' ? input.repo.toLowerCase() : ''
      const query = typeof input.query === 'string' ? input.query : ''
      const cwd = exec.agent === undefined ? '' : String(exec.agent.session.header.cwd)
      const loaded = await loadIndex(cwd, exec.signal)
      if (loaded.rows.length === 0) {
        return jsonSafe({ library: loaded.root, starterLibrary: loaded.bundled === true ? true : undefined, total: 0, shown: 0, hits: [], error: loaded.error === '' ? 'the skill index is empty' : loaded.error })
      }
      const tokens = tokenize(query)
      if (tokens.length === 0 && repoFilter === '') {
        // Latin script only, and that is a property of the index rather than a bug to hide:
        // a query written in Chinese or Japanese yields no keywords at all. Say what to do
        // instead of reporting only what went wrong.
        return jsonSafe({
          library: loaded.root,
          starterLibrary: loaded.bundled === true ? true : undefined,
          total: 0,
          shown: 0,
          hits: [],
          error: 'the query has no searchable keyword — this index is matched on Latin script (letters and digits), so pass keywords in English, e.g. "video render" rather than "做视频"',
        })
      }
      // Two passes over the same scoring: `all` requires every keyword, `any` accepts a
      // partial match. The strict pass runs first and wins whenever it finds anything, so
      // the loose pass only rescues a query that would otherwise return nothing — the
      // common case for keyword-AND search. Loose hits are labelled with matchCount so the
      // model can tell a real hit from a near-miss instead of trusting them equally.
      //
      // The scorer itself is the module-level `scoreRow`, shared with the discovery layer: the
      // weights are one set of numbers and must not be copied. What stays HERE is the query
      // policy — strict AND, then the all-but-one rescue — because that policy is what makes
      // `skill_search` behave predictably for a model-written query, and it is exactly what the
      // discovery layer must not inherit (see `discoverRows`).
      const collect = (requireAll) => {
        const found = []
        for (const row of loaded.rows) {
          if (repoFilter !== '' && !row.repo.toLowerCase().includes(repoFilter)) continue
          const scored = scoreRow(row, { tokens, requireAll, explaining, exactText: query })
          if (scored !== undefined) found.push(scored)
        }
        return found
      }

      let scored = collect(true)
      // How many entries contained every keyword — 0 whenever the loose pass is what
      // produced the results. Reported so the header cannot read like a normal match set.
      const strict = scored.length
      let fallback = 'none'
      if (scored.length === 0 && tokens.length > 1) {
        scored = collect(false)
        if (scored.length > 0) fallback = 'or'
        // A loose hit that matched one keyword out of five is not a weaker rescual, it is a
        // false positive: measured on a 1026-row library, "test setup config helper" pulled
        // in 1026 entries, most sharing a single common word. A rescue has to at least match
        // every keyword but one, otherwise saying "found nothing" is the truthful answer.
        const meaningful = scored.filter((entry) => entry.matchCount >= tokens.length - 1)
        if (meaningful.length > 0) {
          scored = meaningful
        } else if (scored.length > 0) {
          fallback = 'weak'
          scored = []
        }
      }

      scored.sort((a, b) => {
        if (b.listed !== a.listed) return b.listed - a.listed
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
        if (b.score !== a.score) return b.score - a.score
        if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
        if (a.row.name.length !== b.row.name.length) return a.row.name.length - b.row.name.length
        return a.row.name < b.row.name ? -1 : 1
      })
      const hits = []
      for (const entry of scored.slice(0, limit)) {
        const located = await resolveRow(entry.row)
        hits.push({
          name: entry.row.name,
          repo: entry.row.repo,
          description: descLength === 0 ? '' : truncate(entry.row.description, descLength),
          // Empty for every skill whose frontmatter has no whenToUse, which is all of them
          // in most libraries; the field exists so a writer that fills it is rewarded.
          whenToUse: descLength === 0 ? '' : truncate(String(entry.row.whenToUse ?? ''), descLength),
          files: entry.row.files,
          // Upstream repositories do ship one skill several times over (the same
          // directory reachable as skills/<name>, plugins/<x>/skills/<name> and
          // antigravity/skills/<name>). Reporting the copy count is what tells the
          // model `copies` is worth disambiguating.
          copies: copiesOf(entry.row.name),
          matchCount: entry.matchCount,
          // A row whose SKILL.md is gone means the index is out of date — the normal
          // result of deleting a skill directory without regenerating it. Reporting it
          // here lets the model say so instead of offering a skill that cannot load.
          stale: located.missing,
          // Only present when the caller asked to explain, so the normal path pays nothing
          // for it. This is the answer to "why did this query match / not match".
          ...(entry.why === undefined ? {} : { score: entry.score, why: entry.why }),
          path: located.path,
          libraryRelative: entry.row.repo + '/' + entry.row.relpath,
        })
      }
      return jsonSafe({
        library: loaded.root,
        // 只有当这次真的读的是随插件发布的入门库时才出现。用户必须能分辨"我的库被读到了"和
        // "这是入门示例"——那两种情况下的诊断方向完全不同。第一版这个标记加在了上面那条
        // "没有可搜索关键词"的分支上，于是有结果时它反而不出现：分支选错，功能就等于没有。
        starterLibrary: loaded.bundled === true ? true : undefined,
        query,
        total: scored.length,
        strict,
        shown: hits.length,
        names_only: namesOnly,
        more: scored.length > hits.length,
        fallback,
        hits,
        error: '',
        explain: explaining,
        note:
          hits.length === 0
            ? fallback === 'weak'
              ? 'Nothing contained every keyword, and the closest partial matches each shared only one of ' +
                String(tokens.length) +
                ' — too weak to offer. Search again with fewer or different keywords.'
              : 'No library match. Try broader or different keywords, or drop the repo filter; rerun with explain: true to see how each keyword scored against each field.'
            : fallback === 'or'
              ? 'No skill matched every keyword, so these match all but one (matchCount of ' + String(tokens.length) + '). Search again with fewer words to get an exact match.'
              : 'Call skill_load with one exact name to read its full instructions; pass repo too when copies > 1.',
      })
    },
    presentCall(args) {
      const query = String((isRecord(args) ? args.query : '') ?? '')
      return { card: 'generic', title: 'Search skill library: ' + query, kind: 'search', rawInput: query }
    },
  })

  /** Resolve one name (+optional repo hint) to a skill and read it. Never throws. */
  async function loadSkill(rawName, repoHint, cwd, signal, exec) {
    const raw = String(rawName ?? '')
    const wanted = normName(raw)
    const wantedLower = wanted.toLowerCase()
    const wantedRepo = String(repoHint ?? '').trim().toLowerCase()
    const missing = { name: raw, source: '', repo: '', copies: 0, path: '', resourceDir: '', content: '', referenceFiles: [], stale: false, error: '' }
    if (wanted === '') {
      missing.error = 'a skill name is required'
      return jsonSafe(missing)
    }
    const loaded = await loadIndex(cwd, signal)
    let directory = ''
    let chosen = null
    if (loaded.rows.length > 0) {
      // A name can exist many times in one library (a repository that mirrors its skills
      // into plugin and antigravity layouts ships each one three times over). Pick
      // deterministically instead of by file order: the explicit repo filter first, then
      // the shallowest relpath, which selects `skills/<name>` over
      // `plugins/<x>/skills/<name>`.
      const byName = loaded.rows.filter((row) => row.name.toLowerCase() === wantedLower)
      let candidates = byName
      if (wantedRepo !== '') candidates = candidates.filter((row) => row.repo.toLowerCase().indexOf(wantedRepo) >= 0)
      if (byName.length > 0 && candidates.length === 0) {
        // The index knows this name but not under the requested repo. Scanning
        // the directory tree would defeat the filter by finding it anyway, so
        // stop here and say which repos do have it.
        const repos = [...new Set(byName.map((row) => row.repo))].sort()
        missing.error = 'skill "' + wanted + '" is not in a repo matching "' + wantedRepo + '"; it exists in: ' + repos.join(', ')
        return jsonSafe(missing)
      }
      candidates.sort((a, b) => {
        const depthA = a.relpath.split('/').filter(Boolean).length
        const depthB = b.relpath.split('/').filter(Boolean).length
        if (depthA !== depthB) return depthA - depthB
        if (a.relpath.length !== b.relpath.length) return a.relpath.length - b.relpath.length
        return a.relpath < b.relpath ? -1 : 1
      })
      const winner = candidates[0]
      if (winner !== undefined) {
        chosen = winner
        const resolved = await resolveRow(winner)
        directory = resolved.directory
        // The index names this skill but its SKILL.md is gone: the index is out of date.
        // Say that, rather than letting the read failure below report a raw fs error that
        // reads like a permissions problem.
        if (resolved.missing) {
          missing.path = resolved.path
          missing.resourceDir = resolved.directory
          missing.stale = true
          missing.error =
            'the index lists "' +
            wanted +
            '" at ' +
            winner.repo +
            '/' +
            winner.relpath +
            ' but its SKILL.md is missing — the index is stale; regenerate it (see the plugin README)'
          return jsonSafe(missing)
        }
      }
    }
    if (directory === '' && isSafeName(wantedLower)) directory = await scanForSkill(wantedLower, signal)
    if (directory === '') {
      // Not in the library: fall back to the resident registry, which also covers
      // the bundled skills and any name the filesystem roots did not index.
      //
      // `ctx.get` is itself optional: on a host that does not expose it the fallback is
      // simply unavailable, and saying so beats throwing `ctx.get is not a function`
      // (which is what this did before a minimal-host test caught it).
      const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
      if (skills !== undefined) {
        let definition
        try {
          definition = await skills.get(wantedLower, { cwd, signal, scope: exec.agent })
        } catch {
          definition = undefined
        }
        if (definition !== undefined) {
          const resourceBase = definition.resourceBase
          const body = String(definition.content)
          const clamped = clampBody(body, LOAD_CAP)
          return jsonSafe({
            name: String(definition.name),
            source: 'resident',
            repo: '',
            copies: 1,
            path: definition.path === undefined ? '' : String(definition.path),
            resourceDir: resourceBase !== undefined && resourceBase.kind === 'directory' ? String(resourceBase.path) : '',
            content: clamped.text,
            referenceFiles: [],
            truncated: clamped.truncated,
            error: clamped.truncated
              ? 'content truncated at ' + String(LOAD_CAP) + ' of ' + String(clamped.originalLength) + ' characters; read the full file at ' + (definition.path === undefined ? 'its path' : String(definition.path))
              : '',
          })
        }
      }
      missing.error =
        'no skill named "' +
        wanted +
        '" in the library' +
        (loaded.error === '' ? '' : ' (' + loaded.error + ')') +
        ' or in the resident catalog. Call skill_search to find the exact name.'
      return jsonSafe(missing)
    }
    const skillPath = joinPath(directory, 'SKILL.md')
    let body = ''
    try {
      body = await ctx.fs.readText(await ctx.fs.resolve(skillPath, { signal }), signal)
    } catch (error) {
      missing.path = skillPath
      missing.resourceDir = directory
      missing.error = 'failed to read ' + skillPath + ': ' + String(error)
      return jsonSafe(missing)
    }
    const referenceFiles = []
    try {
      const entries = await ctx.fs.listDir(await ctx.fs.resolve(directory, { signal }), signal)
      for (const entry of entries) {
        if (entry.name.toLowerCase() === 'skill.md') continue
        if (referenceFiles.length >= MAX_LISTED) break
        referenceFiles.push(entry.name + (entry.type === 'directory' ? '/' : ''))
      }
    } catch {
      /* a listing failure is not fatal: the body is what matters */
    }
    const text = body.trim()
    const clamped = clampBody(text, LOAD_CAP)
    return jsonSafe({
      name: wanted,
      source: 'library',
      repo: chosen === null ? '' : chosen.repo,
      copies: chosen === null ? 0 : copiesOf(chosen.name),
      path: skillPath,
      resourceDir: directory,
      content: clamped.text,
      referenceFiles,
      truncated: clamped.truncated,
      error: clamped.truncated
        ? 'content truncated at ' + String(LOAD_CAP) + ' of ' + String(clamped.originalLength) + ' characters; read the full file at ' + skillPath
        : '',
    })
  }

  const loadTool = definePortableTool({
    name: 'skill_load',
    description: LOAD_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'One skill name, e.g. "gh-cli". A full path to a SKILL.md is also accepted. For several skills use names instead.',
        },
        names: {
          type: 'string',
          description: 'Several skill names in one call, separated by commas or newlines, e.g. "test-driven-development, verification-before-completion".',
        },
        repo: {
          type: 'string',
          description: 'Optional upstream repo filter for a name that exists several times (skill_search reports copies > 1), e.g. "superpowers" or "trailofbits". Applies to every name in this call.',
        },
      },
    },
    output: {
      // Standard JSON Schema, valid whether or not the runtime compiles it.
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const result = isRecord(value) ? value : {}
        if (String(result.loaded) === '') return [{ type: 'text', text: 'No skill was loaded.' }]
        const skills = Array.isArray(result.skills) ? result.skills : []
        const lines = []
        for (const skill of skills) {
          if (String(skill.content) === '') {
            lines.push('Could not load skill "' + String(skill.name) + '": ' + String(skill.error))
            continue
          }
          const reference = Array.isArray(skill.referenceFiles) ? skill.referenceFiles : []
          lines.push(
            '<skill_content name="' + String(skill.name) + '" source="' + String(skill.source) + '">',
            'Base directory for this skill: ' +
              String(skill.resourceDir) +
              '.' +
              (reference.length === 0 ? '' : ' Bundled: ' + reference.join(', ') + '.'),
            'Resolve relative paths (scripts/, references/, assets/) against that base directory before using them.',
            '',
            String(skill.content),
            '</skill_content>',
          )
          if (String(skill.error) !== '') lines.push(String(skill.error))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = isRecord(args) ? args : {}
      const requested = splitRequestedNames([input.name, input.names]).slice(0, MAX_LISTED)
      const repoHint = input.repo
      const cwd = exec.agent === undefined ? '' : String(exec.agent.session.header.cwd)
      const skills = []
      for (const entry of requested) {
        skills.push(await loadSkill(entry, repoHint, cwd, exec.signal, exec))
      }
      const loadedNames = skills.filter((skill) => String(skill.content) !== '').map((skill) => String(skill.name))
      const failed = skills.filter((skill) => String(skill.content) === '').map((skill) => String(skill.name))
      return jsonSafe({
        requested: requested.join(', '),
        loaded: loadedNames.join(', '),
        skills,
        failed: failed.join(', '),
        note:
          loadedNames.length === 0
            ? requested.length === 0
              ? 'No name was given. Pass name for one skill, or names for several.'
              : 'Nothing loaded. Call skill_search first to get exact names.'
            : 'Follow these instructions for the current task; a skill may point at further files under its base directory.',
      })
    },
    presentCall(args) {
      const names = splitRequestedNames([(isRecord(args) ? args.name : ''), (isRecord(args) ? args.names : '')])
      const label = names.length === 0 ? '(none)' : names.join(', ')
      return { card: 'generic', title: 'Load skill ' + label, kind: 'read', rawInput: label }
    },
  })

  /**
   * Read one file bundled with a skill, instead of loading the whole directory.
   *
   * A SKILL.md routinely points at references/, scripts/ and assets/ that the task may
   * never need; reading them on demand is where the token saving actually lives.
   */
  const refTool = definePortableTool({
    name: 'skill_ref',
    description:
      'Read one file bundled with a skill (a path under its base directory), or list what is bundled with `list: true`. ' +
      'Use it after skill_load when the instructions point at a reference, script or asset and you do not want to pull the whole directory into context. ' +
      'The skill name must be one skill_search reported, and `path` is relative to the base directory that skill_load returned.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name, e.g. "semgrep".' },
        path: {
          type: 'string',
          description: 'File path relative to the skill base directory, e.g. "references/rulesets.md". Omit it when listing.',
        },
        repo: { type: 'string', description: 'Optional upstream repo filter, for a name that exists several times.' },
        list: { type: 'boolean', description: 'List every bundled file under the base directory instead of reading one; the tree is capped, so a deep skill may report more entries than it shows.' },
      },
      required: ['name'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const result = isRecord(value) ? value : {}
        if (String(result.error) !== '') {
          return [{ type: 'text', text: 'skill_ref failed for "' + String(result.name) + '": ' + String(result.error) }]
        }
        if (Array.isArray(result.files)) {
          const lines = [
            'Bundled with ' + String(result.name) + ' (' + String(result.baseDir) + '):',
            ...result.files.map((file) => '  ' + String(file)),
          ]
          if (result.more === true) lines.push('  … (' + String(result.total) + ' entries total)')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [
          '# ' + String(result.name) + ' :: ' + String(result.path) + '  (' + String(result.bytes) + ' bytes)',
          '',
          String(result.content),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = isRecord(args) ? args : {}
      const rawName = String(input.name ?? '')
      const base = { name: rawName, repo: '', path: '', baseDir: '', content: '', bytes: 0, files: undefined, total: 0, more: false, error: '' }
      const cwd = exec.agent === undefined ? '' : String(exec.agent.session.header.cwd)
      const located = await locateSkill(rawName, input.repo, cwd, exec.signal, exec)
      if (located.error !== undefined) {
        base.error = located.error
        return jsonSafe(base)
      }
      base.baseDir = located.directory
      base.repo = located.repo
      const root = resolvePath(located.directory)

      if (input.list === true) {
        const files = []
        const walk = async (dir, prefix, budget) => {
          if (budget.left <= 0) return
          budget.left -= 1
          let entries
          try {
            entries = await ctx.fs.listDir(await ctx.fs.resolve(dir, { signal: exec.signal }), exec.signal)
          } catch {
            return
          }
          for (const entry of entries) {
            if (files.length < MAX_LISTED * 8) files.push(prefix + entry.name + (entry.type === 'directory' ? '/' : ''))
            if (entry.type === 'directory') await walk(joinPath(dir, entry.name), prefix + entry.name + '/', budget)
          }
        }
        await walk(located.directory, '', { left: 40 })
        const shown = files.slice(0, MAX_LISTED * 4)
        base.files = shown
        base.total = files.length
        base.more = files.length > shown.length
        return jsonSafe(base)
      }

      const relative = String(input.path ?? '').trim()
      if (relative === '') {
        base.error = 'pass a path relative to the skill base directory, or list: true to see what is bundled'
        return jsonSafe(base)
      }
      const target = resolvePath(joinPath(located.directory, relative))
      // Containment check on the resolved path: a skill's own references must not be a way
      // to read arbitrary files. `../` is rejected before any I/O happens.
      if (target !== root && !target.startsWith(root.endsWith('/') ? root : root + '/')) {
        base.path = relative
        base.error = 'path escapes the skill base directory; skill_ref only reads files bundled with "' + rawName + '"'
        return jsonSafe(base)
      }
      let text
      try {
        text = await ctx.fs.readText(await ctx.fs.resolve(target, { signal: exec.signal }), exec.signal)
      } catch (error) {
        base.path = relative
        base.error = 'could not read ' + relative + ' (' + String(error) + '); use list: true to see what is bundled'
        return jsonSafe(base)
      }
      const clamped = clampBody(text, LOAD_CAP)
      base.path = relative
      base.content = clamped.text
      base.bytes = clamped.originalLength
      base.error = clamped.truncated ? 'file truncated at ' + String(LOAD_CAP) + ' of ' + String(clamped.originalLength) + ' characters' : ''
      return jsonSafe(base)
    },
    presentCall(args) {
      const input = isRecord(args) ? args : {}
      const label = String(input.name ?? '') + (input.list === true ? ' (list)' : ' :: ' + String(input.path ?? ''))
      return { card: 'generic', title: 'Read skill file ' + label, kind: 'read', rawInput: label }
    },
  })

  register(searchTool.name, searchTool)
  register(loadTool.name, loadTool)
  register(refTool.name, refTool)

  /**
   * Rank the library for a task sentence, reusing this builder's index cache.
   *
   * Read-only: it never loads a body, never writes, and never caches a decision. The agent still
   * decides what to load — see the note on `discoverRows`.
   *
   * @param taskText - the raw user task.
   * @param cwd - session workspace, used to locate the library exactly as the tools do.
   * @param signal - abort signal.
   */
  async function discover(taskText, cwd, signal) {
    const loaded = await loadIndex(cwd, signal)
    // An unloaded index is not "nothing matched" — the dry run has to be able to tell those two
    // apart, or a broken library would look like a well-behaved silent router.
    if (loaded.root === '') return { candidates: [], tokens: [], tier: 'NONE', reason: 'no-library', indexRows: 0, bundled: false }
    const result = discoverRows(loaded.rows, taskText, DISCOVERY_LIMIT)
    return { ...result, indexRows: loaded.rows.length, bundled: loaded.bundled === true }
  }

  return { searchTool, loadTool, refTool, discover }
}

// Zero dependencies, and that has to stay true of the discovery side as well: `discovery.js`
// imports node:fs and node:path only, and this entry imports it relatively. Keeping the
// integration column (reading a task, writing a line) in its own module is what lets the ranking
// stay pure and testable without a host.
import { dirname as dirnamePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDiscoveryLogPath, discoveryRecord, makeDiscoveryRecorder } from './discovery.js'

/**
 * Durable DSH plugin entry: registers all three tools on the global tool registry.
 *
 * `name` mirrors the package and the composed row id rather than a private working title:
 * this file is published, and a name that only made sense in the author's setup is the
 * kind of leftover that makes a reader wonder which plugin they actually installed.
 */
export const name = 'dsh-skill-router'
export const inject = ['fs', 'tools']

/**
 * Turn the user messages entering a step into the task text discovery reads.
 *
 * The content blocks are where the words are; anything that is not text (an image attachment, a
 * file reference) is skipped rather than stringified, because discovery matches Latin-script
 * keywords and a serialized block would only add noise.
 */
function taskTextOf(messages) {
  const parts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (Array.isArray(content) === false) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** The one-line hint. Names and matched fields only — the byte budget is the design. */
function discoveryHint(result) {
  const parts = result.candidates.map((c) => (c.fields.length === 0 ? c.name : c.name + ' (' + c.fields.join(', ') + ')'))
  return (
    'Maybe relevant skills for this task: ' + parts.join('; ') + '. ' +
    'Load any that fit with skill_load, or ignore this and continue without one.'
  )
}

export function apply(ctx) {
  const router = buildSkillRouterTools(ctx, (toolName, tool) => {
    ctx.effect(() => ctx.tools.register(tool), 'skill-router: ' + toolName)
  })

  // ── dry run: measure, do not act ────────────────────────────────────────────────────────
  //
  // At the first step of a turn the library is ranked for the incoming task, and ONLY the
  // outcome is recorded. `agent/pre-step` is the right seam because it runs before the request
  // is built — but it is also the seam where acting would change every turn's context, so the
  // first version of this deliberately writes a JSONL line and returns the decision untouched.
  //
  // Two facts about the seam that the eventual injection must respect, both verified in the
  // harness rather than assumed:
  //   * `step` must be 1. The waterfall runs per step, and the messages it replaces are that
  //     step's claimed batch, so hinting on every step would repeat the hint for one task.
  //   * `agent.inject()` is NOT the way to make the hint visible to the current step:
  //     `preStep` calls `inbox.claim()` before dispatching the waterfall, so an injected message
  //     lands in `next-step` and is only claimed at the NEXT step. The current step sees exactly
  //     `decision.messages` — so the hint belongs in that array, which is also what becomes the
  //     session's `user/message` for the first attempt.
  const discoveryLog = process.env.DSH_SKILL_ROUTER_DISCOVERY_LOG
  const recorder = makeDiscoveryRecorder(discoveryLog === undefined ? defaultDiscoveryLogPath() : discoveryLog, undefined)
  if (recorder.path !== undefined) {
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next()
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      if (step !== 1) return decision
      const taskText = taskTextOf(messages).trim()
      if (taskText === '') return decision
      try {
        const started = Date.now()
        const cwd = agent === undefined || agent === null ? '' : String(agent.session.header.cwd ?? '')
        const result = await router.discover(taskText, cwd, signal)
        recorder.write(
          discoveryRecord({
            turn,
            step,
            result,
            elapsedMs: Date.now() - started,
            indexRows: result.indexRows,
            // Not available yet, and recorded as false so a later reading of the log can tell
            // the measured period from the injected one.
            injected: false,
          }),
        )
      } catch (error) {
        // Telemetry is never worth a failed turn — but a silent catch is how a dry run produces
        // "three days, no data" and nothing to look at. Keep the failure observable in-process
        // (tests read this) without writing anything to the user's session.
        const sink = globalThis.__dshSkillRouterDiscoveryErrors
        if (Array.isArray(sink)) sink.push(String(error && error.message ? error.message : error))
      }
      return decision
    })
  }
}
