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

function normName(value) {
  let text = String(value ?? '').trim().replace(/\\/g, '/')
  text = text.replace(/^@/, '').replace(/\/SKILL\.md$/i, '').replace(/\/+$/, '')
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

/** skill-index.tsv — rows. Header is `repo  relpath  name  description  files  KB`. */
function parseIndex(text) {
  const rows = []
  for (const line of splitLines(text)) {
    if (line === '') continue
    const fields = splitFields(line)
    const repo = fields[0] ?? ''
    const relpath = (fields[1] ?? '').replace(/\\/g, '/')
    const name = fields[2] ?? ''
    // Skip the header by shape, not by an exact string: the column names may or
    // may not be quoted depending on which writer produced the file.
    if (repo === 'repo' && name === 'name') continue
    if (name === '' || relpath === '') continue
    rows.push({
      name,
      repo,
      relpath,
      description: cleanDescription(fields[3]),
      files: fields[4] ?? '',
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
  return tokens
}

/** Shorten one display line (search hit descriptions). Silent by design: this is presentation. */
function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '\u2026'
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

  async function resolveRow(row) {
    const skillFile = joinPath(joinPath(joinPath(rootDir, row.repo), row.relpath), 'SKILL.md')
    const target = await ctx.fs.resolve(skillFile)
    const display = target.displayPath
    const directory = display.slice(0, Math.max(0, display.length - 'SKILL.md'.length))
    return { directory: directory.replace(/[\\/]+$/, ''), path: display }
  }

  /** Walk up from the session cwd to the directory holding .skill-src/skill-index.tsv. */
  async function resolveRoot(cwd) {
    let dir = String(cwd ?? '').replace(/[\\/]+$/, '')
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
          return { root: parent.replace(/[\\/]+$/, ''), indexTarget: target, version: String(info.version) }
        }
      }
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (cut <= 0) break
      dir = dir.slice(0, cut)
    }
    return { root: '', indexTarget: undefined, version: '' }
  }

  /** Parse + cache the index; the fs version invalidates the cache when the file changes. */
  async function loadIndex(cwd, signal) {
    const located = await resolveRoot(cwd)
    if (located.root === '') {
      return {
        rows: [],
        root: '',
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
    const value = { rows, root: located.root, error: '' }
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
        const lines = [
          String(result.total) +
            ' match(es) in ' +
            String(result.library) +
            '; showing ' +
            String(hits.length) +
            (result.more === true ? ' (more available)' : ''),
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
        }
        if (String(result.error) !== '') lines.push('error: ' + String(result.error))
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
        return jsonSafe({ library: loaded.root, total: 0, shown: 0, hits: [], error: loaded.error === '' ? 'the skill index is empty' : loaded.error })
      }
      const tokens = tokenize(query)
      if (tokens.length === 0 && repoFilter === '') {
        return jsonSafe({ library: loaded.root, total: 0, shown: 0, hits: [], error: 'the query must contain at least one letter or digit' })
      }
      // Two passes over the same scoring: `all` requires every keyword, `any` accepts a
      // partial match. The strict pass runs first and wins whenever it finds anything, so
      // the loose pass only rescues a query that would otherwise return nothing — the
      // common case for keyword-AND search. Loose hits are labelled with matchCount so the
      // model can tell a real hit from a near-miss instead of trusting them equally.
      const scoreRow = (row, requireAll) => {
        const nameText = row.name.toLowerCase()
        const descText = row.description.toLowerCase()
        const whenText = String(row.whenToUse ?? '').toLowerCase()
        const pathText = (row.repo + '/' + row.relpath).toLowerCase()
        let score = 0
        let nameHits = 0
        let matchCount = 0
        const why = explaining ? [] : undefined
        for (const token of tokens) {
          let part = 0
          const fields = []
          if (nameText.includes(token)) {
            part += 100
            nameHits += 1
            fields.push('name')
          }
          if (descText.includes(token)) {
            part += 24
            fields.push('description')
          }
          // A whenToUse value IS trigger phrasing, so a hit there says more about intent
          // than a hit in prose does — scored above description, below the name.
          if (whenText !== '' && whenText.includes(token)) {
            part += 40
            fields.push('whenToUse')
          }
          if (pathText.includes(token)) {
            part += 6
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
        const exact = nameText === query.trim().toLowerCase()
        if (exact) score += 400
        if (why !== undefined && exact) why.push('exact name: +400')
        return { row, score, matchCount, nameHits, why, listed: tokens.length > 0 && nameHits === tokens.length ? 1 : 0 }
      }

      const collect = (requireAll) => {
        const found = []
        for (const row of loaded.rows) {
          if (repoFilter !== '' && !row.repo.toLowerCase().includes(repoFilter)) continue
          const scored = scoreRow(row, requireAll)
          if (scored !== undefined) found.push(scored)
        }
        return found
      }

      let scored = collect(true)
      let fallback = 'none'
      if (scored.length === 0 && tokens.length > 1) {
        scored = collect(false)
        if (scored.length > 0) fallback = 'or'
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
          // Only present when the caller asked to explain, so the normal path pays nothing
          // for it. This is the answer to "why did this query match / not match".
          ...(entry.why === undefined ? {} : { score: entry.score, why: entry.why }),
          path: located.path,
          libraryRelative: entry.row.repo + '/' + entry.row.relpath,
        })
      }
      return jsonSafe({
        library: loaded.root,
        query,
        total: scored.length,
        shown: hits.length,
        names_only: namesOnly,
        more: scored.length > hits.length,
        fallback,
        hits,
        error: '',
        explain: explaining,
        note:
          hits.length === 0
            ? 'No library match. Try broader or different keywords, or drop the repo filter; rerun with explain: true to see how each keyword scored against each field.'
            : fallback === 'or'
              ? 'No skill matched every keyword, so these match only some (see matchCount of ' + String(tokens.length) + '). Search again with fewer words to get an exact match.'
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
    const missing = { name: raw, source: '', repo: '', copies: 0, path: '', resourceDir: '', content: '', referenceFiles: [], error: '' }
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
        directory = (await resolveRow(winner)).directory
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
  return { searchTool, loadTool, refTool }
}

/**
 * Durable DSH plugin entry: registers all three tools on the global tool registry.
 *
 * `name` mirrors the package and the composed row id rather than a private working title:
 * this file is published, and a name that only made sense in the author's setup is the
 * kind of leftover that makes a reader wonder which plugin they actually installed.
 */
export const name = 'dsh-skill-router'
export const inject = ['fs', 'tools']

export function apply(ctx) {
  buildSkillRouterTools(ctx, (toolName, tool) => {
    ctx.effect(() => ctx.tools.register(tool), 'skill-router: ' + toolName)
  })
}
