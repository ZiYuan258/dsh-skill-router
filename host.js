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
      // 来源标记：库行由索引提供。catalog 行（本会话目录）由 `catalogRow()` 造，标 'catalog'。
      // 搜索域合并了两个来源之后，下游必须能分辨它们：`repo`/`relpath` 只对库行有意义，
      // `resolveRow` 也必须按来源走不同的定位路径。
      origin: 'library',
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
  if (meaningful.length > 0) return meaningful
  // ── 回退：只有当剩下的 token 里还有**真正的词**时才放行 ──────────────────────────
  //
  // 这条回退的本意是"查询只由停用词组成时，总比说没有关键词好"（`the` / `a` / `of`）。
  // 但它有个没被想到的入口：
  //
  //     "C盘清理 系统盘治理 磁盘空间"  →  tokenizer 把每个汉字替换成空格，
  //                                      只留下 `C盘` 里的 ASCII 字母 `C`
  //                                    →  meaningful = []  →  回退  →  tokens = ["c"]
  //
  // 实测后果：`["c"]` 命中 **7,643 / 7,700 行（99.3%）**，top1 是毫不相关的 `c-review`。
  // 这不是"搜不到"，是**假成功** —— 模型看到 12 条像模像样的结果，无从知道其实一个关键词
  // 都没有。比直接报 no keyword 糟糕得多，因为后者会促使它换词。
  //
  // 判据：回退放行的前提是 token 里**至少有一个长度 ≥ 2 的**（`the` 算，`c` 不算）。
  // 长度 1 的拉丁字母在 7,700 行语料里没有任何区分力 —— 它不是词，是汉字段落里的残留。
  // 这样中文查询回到它应有的回答（no searchable keyword），而纯停用词查询（`the a of`）
  // 的返回值**逐字不变**（仍然回退到未过滤的 tokens），非退化路径完全不受影响。
  const fallback = tokens.filter((token) => token.length > 1)
  return fallback.length > 0 ? tokens : []
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
  // 名字命中的**形态**（0–4，越大越强）。`nameHits` 只回答"命中了几个 token"，
  // 回答不了"命中得多准"—— 而这两件事对"这一条是不是模型要找的"给出不同答案。
  // 详见 `nameMatchForm`。
  let nameForm = -1
  const why = explaining ? [] : undefined
  for (const token of tokens) {
    let part = 0
    const fields = []
    if (nameText.includes(token)) {
      part += WEIGHT.name
      nameHits += 1
      nameForm = Math.max(nameForm, nameMatchForm(nameText, token))
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
  return { row, score, matchCount, nameHits, nameForm, why, listed: tokens.length > 0 && nameHits === tokens.length ? 1 : 0 }
}

/**
 * 名字匹配的**形态**，四级，越大越强。回答"这一条命中得多准"，而不是"命中了几个词"。
 *
 *   3 NAME_EXACT   扁平化后完全相等          univer    → univer
 *   2 NAME_SEGMENT token 落在**词段边界**上   debugging → systematic-debugging
 *                                            univer    → univer-sheet
 *   1 NAME_PREFIX  名字以 token 开头，但切在词中间  univer → universal-checkout
 *   0 NAME_CONTAINS 仅子串                    test      → latest
 *  -1              名字里没有这个 token
 *
 * ── 为什么"词段"是一级，而"首段"不是单独一级 ────────────────────────────────
 *
 * 用户提的三级是「完全匹配 > 前缀匹配 > 子串匹配」。实现前先实测，发现两件事：
 *
 * **一、"前缀"混了两种完全不同的东西。** 而它们的置信度差得远：
 *
 *     univer → univer-sheet          `univer` 是完整词段
 *     univer → universal-checkout    `univer` 只是 `universal` 的开头，切在词中间
 *
 * 前者是"同一个概念"，后者只是拼写巧合 —— 这正是 `univer` 查询返回 44 条里 41 条是垃圾的原因。
 * 所以**词段边界必须高于裸前缀**，这一条同时满足用户的意图（前缀档仍在子串之上）和实测需要。
 *
 * **二、把"首段"再单独提一级会撞上既有回归判据。** 实测：
 *
 *     debugging-and-error-recovery   首段是 debugging  ⇒ 若"首段"独立成级，它第 1
 *     systematic-debugging           debugging 是尾段
 *
 * 而 `debugging` 是 t96 那次诊断的收窄查询，正确目标是 `systematic-debugging`（用户指定为
 * **回归底线**）。两条都是"系统性根因调试"（后者 description 逐字含 "Guides systematic
 * root-cause debugging"），所以更细的区分不是正确性，只是偏好 —— 而偏好不该压过底线。
 *
 * ⇒ **首段与中间段同为 NAME_SEGMENT**：词段边界统一高于裸前缀，首尾不再区分。
 *   同一形态内退回既有的 score → 名字长度 tiebreak（`systematic-debugging` 因此仍在前面）。
 */
const NAME_EXACT = 3
const NAME_SEGMENT = 2
const NAME_PREFIX = 1
const NAME_CONTAINS = 0
/** 扁平化：去掉分隔符，用于"完全相等"判定（`next-dev-loop` == `nextdevloop`）。 */
function flattenName(text) {
  return String(text).toLowerCase().replace(/[-_.\s]+/g, '')
}
/** 词段：技能名按分隔符切开（`systematic-debugging` → ['systematic','debugging']）。 */
function nameSegments(text) {
  return String(text)
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter((part) => part !== '')
}
/**
 * 匹配形态判定。调用方保证 `nameText` 已小写、且已知它包含 token。
 *
 * `token` 自身可能带连字符（`next-dev-loop`），所以比较用**扁平化**判定完全相等，
 * 用词段判定边界 —— 两条路都不依赖 token 的写法。
 */
function nameMatchForm(nameText, token) {
  if (nameText.includes(token) === false) return -1
  if (flattenName(nameText) === flattenName(token)) return NAME_EXACT
  const segments = nameSegments(nameText)
  if (segments.includes(token)) return NAME_SEGMENT
  // token 含分隔符时（用户直接打了 `next-dev-loop`），词段相等判定够不着；
  // 这时"名字以它开头"就该按词段算，而不是按裸前缀算。
  if (nameText.startsWith(token)) {
    const rest = nameText.slice(token.length)
    if (rest === '' || /^[-_.\s]/.test(rest)) return NAME_SEGMENT
    return NAME_PREFIX
  }
  return NAME_CONTAINS
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
 * Independent tokens required for the top tier — counted over the **effective** tokens only, i.e.
 * after the corpus-frequency filter below. One lucky word matching one `whenToUse` line is a
 * coincidence; two different discriminating words landing is a signal.
 */
const DISCOVERY_STRONG_MATCHES = 2
/**
 * A token carried by more than this share of the corpus cannot discriminate inside it.
 *
 * Measured on a 1,028-row library: `skill` and `skills` appear in **1,028 of 1,028 rows (100%)**,
 * and `task` in 10%. A static `STOP_WORDS` list cannot name these — they are not language noise,
 * they are zero signal *for this corpus*, and which words those are changes when the library does.
 * So the list is computed from the index instead.
 *
 * Measured consequence of not having this: discovery produced `implement-task ×3` for one task, and
 * injected `azure-identity-py / entra-agent-id / gke-workload-identity` for "I am about to update
 * DSH" — a candidate set that scored HIGH while carrying no information.
 */
const DISCOVERY_COMMON_TOKEN_RATIO = 0.8

/**
 * Document frequency for the tokens of one task: how many rows carry each token, and the ratio.
 *
 * The counter of last resort for a candidate generator: a token that every row contains contributes
 * a high score to every row, which is the same as contributing nothing — except that it also wins
 * the ranking. Kept as a returned map (not just a filter) so telemetry and `doctor` can say *which*
 * words were ignored and how common they were, rather than silently dropping them.
 *
 * @param rows - parsed index rows.
 * @param tokens - the task's tokens, already through `tokenize`.
 * @returns `Map<token, { rows, ratio }>`.
 */
export function corpusFrequency(rows, tokens) {
  const list = Array.isArray(rows) ? rows : []
  const stats = new Map()
  for (const token of Array.isArray(tokens) ? tokens : []) {
    let count = 0
    for (const row of list) {
      const haystack = String(row.name ?? '') + ' ' + String(row.description ?? '') + ' ' + String(row.whenToUse ?? '') + ' ' + String(row.repo ?? '') + '/' + String(row.relpath ?? '')
      if (haystack.toLowerCase().includes(token)) count += 1
    }
    stats.set(token, { rows: count, ratio: list.length === 0 ? 0 : count / list.length })
  }
  return stats
}

/**
 * Rank index rows for a task sentence. Pure — no I/O, no clock, no telemetry.
 *
 * The pipeline, in order, because the order is the fix:
 *
 *   task → tokenize → STOP_WORDS → **corpus-frequency filter** → scoreRow → **dedupe by name**
 *        → sort → top 5 → tier over the effective tokens
 *
 * The last two stages were missing and each produced a measured defect: scoring on tokens that every
 * row carries (so the ranking was noise wearing a score), and letting one skill's several copies
 * occupy several of the five slots (`implement-task ×3` in one real hint).
 *
 * @param rows - parsed index rows.
 * @param taskText - the raw user task; may be any language.
 * @param limit - maximum candidates.
 * @returns `{ candidates, tokens, effectiveTokens, ignoredTokens, tier, reason }` — all names and
 *   codes, never user text beyond the tokens the task itself yielded.
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
  if (tokens.length === 0) return { candidates: [], tokens: [], effectiveTokens: [], ignoredTokens: [], tier: 'NONE', reason: 'no-searchable-token' }

  // Stage: corpus-frequency filter. Discovery only — `skill_search` keeps its own tokens untouched,
  // because filtering there would silently change the behaviour of an explicit tool call.
  const frequency = corpusFrequency(list, tokens)
  const effectiveTokens = tokens.filter((token) => (frequency.get(token)?.ratio ?? 0) <= DISCOVERY_COMMON_TOKEN_RATIO)
  const ignoredTokens = tokens
    .filter((token) => effectiveTokens.includes(token) === false)
    .map((token) => ({ token, ratio: Number((frequency.get(token)?.ratio ?? 0).toFixed(3)) }))
  // Every keyword was too common to discriminate. Saying "no candidate" is the honest answer;
  // scoring on them anyway is what produced the noise this filter exists to remove.
  if (effectiveTokens.length === 0) return { candidates: [], tokens, effectiveTokens, ignoredTokens, tier: 'NONE', reason: 'no-discriminating-token' }

  const hits = []
  for (const row of list) {
    const scored = scoreRow(row, { tokens: effectiveTokens, requireAll: false, explaining: false, exactText: taskText })
    if (scored === undefined || scored.score < DISCOVERY_MIN_SCORE) continue
    hits.push(scored)
  }
  if (hits.length === 0) return { candidates: [], tokens, effectiveTokens, ignoredTokens, tier: 'NONE', reason: 'no-candidate' }

  // Deterministic: score, then how many tokens landed, then how many hit the name, then the
  // name — so the same task always yields the same list, which the experiment depends on.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
    return String(a.row.name).localeCompare(String(b.row.name))
  })

  // Stage: dedupe by skill name, keeping each name's best-scoring copy. A library assembled from
  // several upstreams carries the same skill more than once, and `skill_load` already has a
  // documented way to disambiguate copies — discovery offering the same name three times is not
  // three candidates, it is one candidate and two wasted slots.
  const byName = new Map()
  for (const hit of hits) {
    const key = String(hit.row.name).toLowerCase()
    const seen = byName.get(key)
    if (seen === undefined || hit.score > seen.score) byName.set(key, hit)
  }
  const ranked = [...byName.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
    return String(a.row.name).localeCompare(String(b.row.name))
  })

  const candidates = ranked.slice(0, capped).map((hit) => ({
    name: String(hit.row.name),
    repo: String(hit.row.repo),
    relpath: String(hit.row.relpath),
    score: hit.score,
    matched: hit.matchCount,
    nameHits: hit.nameHits,
    // WHICH fields matched — telemetry only, and never rendered. Its one attempt at display
    // produced `name (name, description, path)` on 304 of 467 measured candidates: the field
    // NAMES where the hint meant to show what those fields SAY. See `discoveryHint`.
    fields: matchedFields(hit.row, effectiveTokens),
    // What the hint actually shows. `description` is the only field in the index that states a
    // skill's PURPOSE, so it is the only thing that can answer the model's question — "is this
    // worth opening?" — and the previous field-name rendering answered it with nothing. The
    // display cap lives in `discoveryHint`, so no per-candidate budget is decided here.
    description: String(hit.row.description ?? ''),
  }))

  // Tier is computed over the DEDUPED ranking, and over effective tokens only.
  //
  // Both halves matter. Over the raw hits, three copies of one skill could vouch for each other as
  // best-and-runner-up; over raw tokens, `skill` (present in 100% of rows) counted as one of the two
  // independent matches — which is how a noise set reached HIGH.
  const best = ranked[0]
  const runnerUp = ranked[1]
  let tier = 'MEDIUM'
  if (best.nameHits > 0 && best.matchCount >= DISCOVERY_STRONG_MATCHES) tier = 'HIGH'
  // A single candidate that just clears the floor is not a strong suggestion, and two candidates
  // that score about the same mean the ranking itself is unsure. Both are the same fact to the
  // experiment: this task's outcome should be read with care.
  else if (runnerUp === undefined || best.score < runnerUp.score * 1.25) tier = 'NONE'
  return { candidates, tokens, effectiveTokens, ignoredTokens, tier, reason: 'ok' }
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
 * 从 `ctx.fs` 的不透明 version 串里取出**可比的时间戳**（纳秒），取不到返回 `undefined`。
 *
 * 真实格式（`dsh-fs-local/lib/index.js:146` 逐字）：
 *     FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
 * ⇒ 第 4 段是 `mtimeNs`，纳秒级、单调 —— 正是"哪个文件更新"的答案。
 *
 * 为什么要一个专门的函数而不是 `Number()`：整串 `Number()` 得 `NaN`，
 * 而 `NaN` 的比较恒假会把判据**静默**变成"永不报警"。这个坑 v1.16.0 真机复验时踩过。
 *
 * 兜底：段数不符、或该段不是数字串 ⇒ `undefined`（调用方据此放弃该判据，并如实报告）。
 * 也接受**纯数字**串，因为 mock/测试与旧实现会给这种形态。
 */
function versionTimestampNs(version) {
  const text = String(version ?? '')
  if (text === '') return undefined
  const parts = text.split(':')
  const candidate = parts.length >= 4 ? parts[3] : parts.length === 1 ? parts[0] : undefined
  if (candidate === undefined || /^\d+$/.test(candidate) === false) return undefined
  const value = Number(candidate)
  return Number.isFinite(value) ? value : undefined
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
  // name (lowercased) -> copies in this session's catalog. Filled by skill_search when it
  // merges the catalog into the search domain; stays empty when no catalog is reachable.
  let catalogNameCounts = new Map()

  /** How many library rows share this skill name; >1 means skill_load needs a repo hint. */
  function copiesOf(name) {
    return nameCounts.get(String(name).toLowerCase()) ?? 1
  }

  /**
   * 一份技能的副本构成，按来源分开报。
   *
   * 为什么不是一个数字：`copies` 在库内的语义是"同一技能出现在多个上游仓库里"，
   * 而在搜索域合并之后它多了第二种成因——**同一个名字同时存在于库和本会话目录**
   * （实测 `next-dev-loop` 就是这样：库一份、`project-dsh` 一份）。这两件事对模型的动作
   * 含义完全不同：
   *
   *   库内 2 份   → `skill_load` 要带 `repo` 才能选对那一份
   *   跨域 1+1 份 → 带 `repo` 选不了目录那一份（catalog 技能根本不属于任何 repo），
   *                 报 `copies: 2` 会让模型去找一个不存在的 repo 参数
   *
   * ⇒ 分开报，模型才可能做对动作。
   *
   * 形状是对象（`{ total, library, catalog }`）。工具返回值走 JSON，嵌套没有问题；
   * 用户提出过退化形式 `copies: 2, copySources: [...]`，在有 JSON 可用时不必退化。
   * `total` 放在第一位，是为了让"只想判断是否重名"的读法（含插件自己的 note 逻辑）
   * 仍然只看一个数就够。
   */
  function copiesFor(name) {
    const library = copiesOf(name)
    // catalog 侧的数量：本会话目录里同名了几次。正常是 0 或 1；注册表允许同名多层，
    // 所以不假设它一定是 1。
    const catalog = catalogNameCounts.get(String(name).toLowerCase()) ?? 0
    return { total: library + catalog, library, catalog }
  }

  /**
   * 本会话的技能目录（registry union），作为**搜索域的第二个来源**。
   *
   * 为什么需要它：`SEARCH_DESCRIPTION` 一直写着 "Search every skill available to this agent:
   * the session skill catalog plus the staged library"，而实现只读了库索引 —— 声明与实现不一致。
   * 后果是实测过的：同一个会话里"搜 hindsight 得到 0 条"，而 `hindsight-coding-agent`
   * 当时就在这个会话的目录里（它由用户级 `user-agents` 根提供，不在 `.skill-src` 索引里）。
   *
   * 走 `skills.list()` 而不是自己扫磁盘，是因为目录是**三层合并**的结果（`dsh-skill` 的
   * 收集语义）：运行时注册的 skill（由别的插件在 apply 时注册，例如 `dsh-univer-office`
   * 提供的 `univer*`）、各 provider 的 `list()`（project-dsh / project-agents / user-dsh /
   * user-agents / custom / bundled）、以及随 DSH 发布的 bundled。扫磁盘只能拿到中间那一层。
   *
   * 注意本插件**只读不写**目录：这里没有任何注册、安装或写入调用，`test/starter-library.mjs`
   * 把这一点断言成不变量（入门技能绝不进常驻目录）。
   *
   * 与 `loadSkill` 的回退路径共用同一个服务、同一套容错：`ctx.get` 可能不存在（minimal host），
   * `list` 可能不是函数，收集可能失败。**任何一种情况都退化为今天的"只有库"，绝不让搜索失败**
   * —— 目录是增益，不是依赖。
   *
   * ── `scope` 跟着 harness 自己的调用形状走（一次撤回记录）
   *
   * 本函数一度去掉了 `scope`，依据是第三方 GUI 的技能看板调 `registry.snapshot({ cwd })`
   * 不带 scope。**那个依据不成立**，已撤回：
   *   - `@linxin666/dsh-client-ui-skill-explorer/lib/index.js:529-534` 显示，它那三组技能
   *     **主要来自 `scanSkillRoot()`（直接扫磁盘）**；`:539` 的 `registry.snapshot({cwd})`
   *     只是**叠加补充**。拿一个补充调用当"正确形状"是本末倒置。
   *   - harness 自己有两个独立调用点，**都传 scope**：
   *       `dsh-tool-skill/lib/index.js:140-144`（skill 工具 execute）→ `scope: exec.agent`
   *       `dsh-tool-skill/lib/index.js:207-210`（目录块 pre-step）  → `scope: agent`
   *
   * ⇒ 与 harness 保持一致：`scope: exec.agent`。
   *
   * 这次撤回**无损失**，因为「registry 里缺 project-dsh / user-agents」并不是 scope 造成的 ——
   * 原生 `skill` 工具同样传 scope、同样看不到那两个根（实测 `skill hindsight-coding-agent`
   * 与 `skill keep-the-why` 都报 "unknown or no longer available"），**两者行为一致**。
   * 那是 provider 配置问题（`include:skill-filesystem` 出厂行是 `inactive`，
   * 而活动的 `include:dsh-agent-preset-skills` 带 `includeDefaultRoots: false`），见 POLICY §31。
   *
   * @returns summary 数组，或空数组。永不抛出。
   */
  async function loadCatalog(cwd, scope, signal) {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (skills === undefined || skills === null || typeof skills.list !== 'function') return []
    try {
      const summaries = await skills.list({ cwd, signal, scope })
      return Array.isArray(summaries) ? summaries : []
    } catch {
      /* 目录拿不到不是错误：搜索继续，只是域里没有它们 */
      return []
    }
  }

  /**
   * 把一条 catalog summary 变成与库行**同构**的搜索行。
   *
   * `toSummary()` 给的是 `{ name, path?, description, whenToUse?, invocation, source, provider,
   * resourceBase? }` —— **没有 `repo`，没有 `relpath`**。这两个字段在搜索里各有用途
   * （`scoreRow` 用它们做 path 打分、返回里要报 `libraryRelative`、`resolveRow` 用它们拼路径），
   * 所以缺了它们必须靠 `origin` 分辨，而不是留空让下游误判。
   *
   * 留空的后果是具体的：`resolveRow` 会拼出 `rootDir//SKILL.md` 去 stat，失败后
   * `catch { missing = true }` 会把**每一条** catalog 行渲染成 `STALE: SKILL.md is missing`
   * —— 对一条完全健康的技能报"索引过期"。
   */
  function catalogRow(summary) {
    if (summary === null || typeof summary !== 'object') return null
    const name = String(summary.name ?? '').trim()
    if (name === '') return null
    return {
      name,
      // 空 repo / relpath 是**如实**表达"这两个概念对 catalog 技能不存在"，
      // 而不是"它们的值是空字符串"。下游一律先看 `origin`。
      repo: '',
      relpath: '',
      description: String(summary.description ?? ''),
      files: '',
      whenToUse: summary.whenToUse === undefined || summary.whenToUse === null ? '' : String(summary.whenToUse),
      origin: 'catalog',
      // 目录内部定位用，不显示给模型（绝对路径与库里的相对路径不是一回事）。
      catalogPath: summary.path === undefined ? '' : String(summary.path),
      catalogSource: String(summary.source ?? ''),
    }
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
    // catalog 行（本会话目录里的技能）**没有** repo/relpath —— 拼 `rootDir/repo/relpath`
    // 会得到 `rootDir//SKILL.md`，stat 失败，然后 catch 把一条完全健康的技能标成 STALE。
    // 目录 summary 自带绝对路径（`path`），有就直接用它。
    if (row.origin === 'catalog') {
      const catalogPath = String(row.catalogPath ?? '')
      if (catalogPath === '') {
        // summary 的 `path` 是可选字段（`toSummary` 用条件展开，只有提供方给了才有）。
        // 缺它就是"不知道路径"，**不是**"文件不见了"：报 stale 是撒谎，报 missing 也一样。
        // 返回 missing: false，让下游把 path 留空而不是说它坏了。
        return { directory: '', path: '', missing: false }
      }
      // ── ★ catalog 行不靠 `ctx.fs` 判定 stale（v1.16.0 真实环境验证时发现）
      //
      // 曾经的写法是 `ctx.fs.resolve(catalogPath)` + `ctx.fs.stat()`，失败就报 STALE。
      // 真实环境里这**把三条完全健康的 bundled 技能全标成了 "STALE: SKILL.md is missing"**
      // （`editing-cordis-compositions` / `cordis-composition-reference` / `cordis-plugin-development`）。
      //
      // 根因：bundled 的 `bundledSkillDir` 指向 **`app.asar` 内部**，而 `app.asar` 是一个**文件**
      // （121 MB），不是目录。宿主进程自己的文件读取能穿透它（实测 `skill_load
      // cordis-plugin-development` 成功，`source: resident`），但 `ctx.fs` 这门面打不开。
      //
      // ⇒ 教训不是"要换个 API 探测"，而是**"读不到"不等于"不存在"**：
      //    - catalog 是 registry 交来的条目，provider 在**收集阶段**已经解析过它；
      //    - `path` 打不开只说明"我这门面读不到"，不说明它不在。
      //    把前者渲染成后者，是**对一条健康的技能撒谎** —— 比不报更糟。
      //
      // 所以这里只做**尽力而为**的目录解析（为了把 `path` 给全），**从不据此报 stale**。
      // 真正的"能不能加载"由 `skill_load` 回答：它走 `skills.get()` 让 provider 自己读，
      // 成功与否是权威结论，而那条路径压根不碰 `ctx.fs`（见 `loadSkill` 的 resident 回退）。
      let display = catalogPath
      try {
        const target = await ctx.fs.resolve(catalogPath)
        display = String(target.displayPath ?? catalogPath)
      } catch {
        /* 读不到就原样用 catalog 给的路径 —— 它是 provider 报的，比我们猜的可信 */
      }
      return {
        directory: stripTrailingSlashes(display.slice(0, Math.max(0, display.length - 'SKILL.md'.length))),
        path: display,
        missing: false,
      }
    }
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

  /**
   * 从会话 cwd 向上找到含 `.skill-src/skill-index.tsv` 的目录；找不到才回退到入门库。
   *
   * **这条"向上最多 8 层"的规则被 `tools/doctor.mjs` 的 `findLibraryRoot` 镜像着。** 改这里就要
   * 同步改那里：两者一旦不一致，就会出现"运行时找到了库并正常工作、doctor 说找不到"的分叉，而
   * **一个诊断工具报出与运行时相反的结论，比没有诊断更糟**——用户会去查一个不存在的问题。
   * `test/library-root-contract.mjs` 同时驱动两个实现来钉住这条契约。
   */
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
          // rawRoot lets the integrity self-check locate the sibling identity files
          // (.sha256 / meta.json) without re-walking the workspace.
          return { root: stripTrailingSlashes(parent), rawRoot: dir, indexTarget: target, version: String(info.version), bundled: false }
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

  /**
   * Index integrity self-check (2026-10-05). Two independent alarms, warn-only — a problem
   * here must never make a working search fail. Criteria live in
   * `.dsh/SKILLS-POLICY.md` §十七·附 (the "routine re-run exception" clause).
   *
   *  - (1) version skew: the index's fs version differs from the sidecar's ⇒ the index was
   *        written after its identity files, i.e. an out-of-band edit or an interrupted scan.
   *  - (1b) identity disagreement: `.sha256` and `meta.json` record different sha256 values.
   *  - (2) row drift: current row count differs from `meta.json.rowCount` by more than 10%
   *        ⇒ the size change has to be explained, not absorbed silently.
   *
   * This function only reads text through `ctx.fs`; the exact byte-level hash check lives in
   * `.skill-src/index-integrity.mjs`. Every failure inside here is swallowed: an absent or
   * unreadable identity file degrades to "no check", never to an error.
   */
  async function checkIndexIntegrity(located, rows, signal) {
    const problems = []
    if (located.rawRoot === undefined) return { status: 'ok', problems, checked: 'bundled starter library' }
    const lib = joinPath(located.rawRoot, '.skill-src')
    const readSibling = async (name) => {
      const target = await ctx.fs.resolve(joinPath(lib, name), { signal })
      if (target === undefined) return undefined
      const info = await ctx.fs.stat(target)
      if (info === undefined || info.type !== 'file') return undefined
      return { target, info, text: await ctx.fs.readText(target, signal) }
    }
    try {
      const side = await readSibling('skill-index.tsv.sha256')
      if (side !== undefined) {
        // 版本戳只做**顺序**比较，不做相等比较：scan-skills.ps1 本来就先写索引、后写 sidecar，
        // 两者的 mtime 相差几百毫秒是正常形态——按相等比会每次合法重跑都误报（已实测）。
        //
        // ── ★ `ctx.fs` 的 version 是**不透明复合串**，不能 `Number()`（v1.16.0 复验时发现）
        //
        // 初版写的是 `Number(located.version) > Number(side.info.version)`，结果**真实环境里
        // 报警永不出现**（mock 里我给的是纯毫秒数字串，所以 mock 通过、真机静默全瞎）。
        // 真实格式出自 `dsh-fs-local/lib/index.js:146` 逐字：
        //
        //     FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
        //
        // 即 `"0:12345:3910032:1791297073405000000:1791139170108000000"` —— `Number()` 得 `NaN`，
        // `Number.isFinite()` 恒假，**整条判据被静默跳过**（连"放弃这条判据"的注释都掩盖了它）。
        // 类型注释也写着它是 "Opaque version token" —— 对一个自称不透明的串做算术，是根上的错。
        //
        // 修法：只取**可比的那一段** —— 第 4 个字段 `mtimeNs`（纳秒，单调递增，正是"谁更新"的答案）。
        // 段数不符（未来格式变了）就放弃这条判据，**且不再静默**：记进 problems 的体检项。
        const idxVersion = located.version
        const sideVersion = side.info.version
        const idxNs = versionTimestampNs(idxVersion)
        const sideNs = versionTimestampNs(sideVersion)
        if (idxNs !== undefined && sideNs !== undefined) {
          if (idxNs > sideNs) {
            problems.push(
              'the index was written after its identity file (index mtime ' + String(idxNs) +
              ' > sidecar ' + String(sideNs) + ') — an out-of-band edit, or the last scan was interrupted'
            )
          }
        } else if (String(idxVersion).includes(':') || String(sideVersion).includes(':')) {
          // 有冒号说明它是复合串但段数不符 ⇒ 格式变了，判据失效。如实报出来，
          // 而不是像初版那样"不满足 isFinite 就安静跳过"。
          problems.push(
            'could not compare index and sidecar versions (unrecognized version token format: "' +
            String(idxVersion).slice(0, 60) + '" vs "' + String(sideVersion).slice(0, 60) + '") — the ordering check is inactive'
          )
        }
        const sideHash = String(side.text ?? '').trim().split(/\s+/)[0]
        if (sideHash !== '') {
          try {
            const meta = await readSibling('skill-index.meta.json')
            const parsed = meta === undefined ? undefined : JSON.parse(meta.text)
            if (parsed !== undefined && String(parsed?.sha256 ?? '') !== '' && String(parsed.sha256) !== sideHash) {
              problems.push(
                'identity files disagree: skill-index.tsv.sha256 says ' + sideHash.slice(0, 12) +
                '… but skill-index.meta.json says ' + String(parsed.sha256).slice(0, 12) + '…'
              )
            }
          } catch { /* meta.json is optional */ }
        }
      }
    } catch { /* sidecar is optional */ }
    try {
      let recorded
      try {
        const meta = await readSibling('skill-index.meta.json')
        if (meta !== undefined) recorded = Number(JSON.parse(meta.text)?.rowCount)
      } catch { recorded = undefined }
      if (Number.isFinite(recorded) && recorded > 0) {
        const drift = Math.abs(rows.length - recorded) / recorded
        if (drift > 0.1) {
          problems.push(
            'row count drifted ' + (drift * 100).toFixed(1) + '% against skill-index.meta.json (' +
            String(rows.length) + ' now vs ' + String(recorded) + ' recorded) — over the 10% threshold'
          )
        }
      }
    } catch { /* meta.json is optional */ }
    return { status: problems.length === 0 ? 'ok' : 'alarm', problems }
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
    // 索引完整性自检：只在缓存未命中（即真的重读了索引）时算一次，报警不阻止。
    const indexIntegrity = await checkIndexIntegrity(located, rows, signal)
    // `bundled` 一路带到工具返回值：用户看到的是入门技能时必须说清楚，否则他会以为
    // 自己的库被读到了（而那时真正的诊断方向完全不同）。
    const value = { rows, root: located.root, error: '', bundled: located.bundled === true, indexIntegrity }
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
        // 名字命中数与总命中数的差，是"只被描述/路径命中"的条数。三档信息一起给，
        // 模型才知道"这一屏为什么只有这些"以及"还有多少在别处"。
        //
        // 只在两者**不相等**时才提：相等说明全部命中都在名字里，报"0 by description"
        // 是纯噪声（而且会让每次搜索都变长，那是这个插件最不该付的成本）。
        const nameMatched = Number(result.nameMatched ?? result.total)
        const descOnly = Number(result.total) - nameMatched
        const split =
          Number.isFinite(descOnly) && descOnly > 0 && nameMatched > 0
            ? ' (' + String(nameMatched) + ' with a keyword in the name; ' + String(descOnly) + ' description/path only)'
            : ''
        const headline = loose
          ? '0 exact match(es); ' + String(result.total) + ' partial match(es) in ' + String(result.library) + split
          : weak
            ? 'no match in ' + String(result.library)
            : String(result.total) + ' match(es) in ' + String(result.library) + split
        const lines = [
          headline +
            '; showing ' +
            String(hits.length) +
            (result.more === true ? ' (more available)' : '') +
            (loose ? ' — no entry contained every keyword, so these match all but one' : ''),
        ]
        for (const hit of hits) {
          // catalog 行没有 repo：渲染成 `[]` 会读成一个空的仓库名，而不是"不属于任何仓库"。
          const where = String(hit.repo) !== '' ? '  [' + String(hit.repo) + ']' : hit.origin === 'catalog' ? '  [catalog' + (String(hit.source ?? '') === '' ? '' : ':' + String(hit.source)) + ']' : ''
          lines.push('- ' + String(hit.name) + where + (String(hit.description) === '' ? '' : '\n    ' + String(hit.description)))
          // Surface the trigger phrasing only when it says something the description does
          // not, so a library that fills both does not pay for the duplication twice.
          //
          // `?? ''` 不是多余的：真实 hit 一定会带 `whenToUse`（execute 里统一赋值），
          // 但 `String(undefined)` 是 `'undefined'`，而它 `!== ''` 恒真 ⇒
          // 一旦某个调用方漏设该字段，渲染就会输出字面的 `when: undefined`。
          // 渲染层的职责是"输出的每个字都是给模型看的"，所以这里按缺失处理。
          const whenText = String(hit.whenToUse ?? '')
          if (whenText !== '' && whenText !== String(hit.description)) {
            lines.push('    when: ' + whenText)
          }
          if (Array.isArray(hit.why)) {
            lines.push('    why: ' + hit.why.join('; '))
          }
          // A stale row is the one case where the skill cannot be loaded at all, so say it
          // where the model is choosing, not only when the load fails later.
          if (hit.stale === true) lines.push('    STALE: SKILL.md is missing — regenerate the index')
        }
        if (String(result.error) !== '') lines.push('error: ' + String(result.error))
        // ★ 索引完整性报警必须出现在**渲染文本**里，不能只放在 `note`。
        //
        // 这是一个真实被漏掉的缺陷（v1.16.0 发布后重启验证时发现）：报警文字全部写进了
        // `result.note`，而 `render()` **从来不输出 note** —— 它只渲染 `hits` / `error` /
        // `stale` / 重名提示。模型读的是这段渲染文本，不是工具返回的 JSON，
        // 所以报警等于**永远不可见**：功能存在、字段存在、mock 测试全绿，真实环境全瞎。
        //
        // 漏掉的原因值得记：mock 测试断言的是 `result.indexAlarm` 与 `result.note`（JSON 层），
        // **没有一条断言渲染文本**。判据选在了错误的层面 —— 见 POLICY §28.1。
        // 修法不只是把它加进来，还要在 `test/verify.mjs` 里补一条渲染层断言，
        // 否则下次改 render 还会静默丢掉它。
        if (Array.isArray(result.indexAlarm) && result.indexAlarm.length > 0) {
          lines.push('')
          lines.push('⚠ INDEX INTEGRITY ALARM — the index does not match its identity files:')
          for (const problem of result.indexAlarm) lines.push('  · ' + String(problem))
          lines.push('  The index was probably edited by hand or by another tool without running scan-skills.ps1,')
          lines.push('  or the last scan was interrupted. Rerun scan-skills.ps1 to realign; the details are in')
          lines.push('  skill-index.meta.json and skill-index.dropped.tsv next to the index. Search results below')
          lines.push('  are still shown, but treat them as unverified.')
        }
        // The note tells the model to pass `repo` when copies > 1, so the count has to be
        // visible: the JSON carries it, but the model reads this text, not the JSON.
        //
        // `copies` 现在是对象（`{ total, library, catalog }`），所以这里必须读 `.total`。
        // 旧写法 `Number(hit.copies) > 1` 对对象得 `NaN`，比较恒假 —— 提示会**静默消失**，
        // 不抛错、不报错，只是那句"pass repo to choose"再也不出现。
        const copiesTotal = (hit) => (isRecord(hit.copies) ? Number(hit.copies.total) : Number(hit.copies))
        const duplicated = hits.filter((hit) => copiesTotal(hit) > 1)
        const duplicatedRepos = new Set(duplicated.map((hit) => String(hit.repo)).filter((repo) => repo !== ''))
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
      // ③ 搜索域 = 库索引 + 本会话目录。
      //
      // 声明（SEARCH_DESCRIPTION）一直说含 catalog，实现一直只有库 —— 这是声明与实现不一致，
      // 不是"扩展功能"。最干净的证据是 t108：同一会话搜 "hindsight" 得 0 条，而正确目标
      // `hindsight-coding-agent` 当时就在目录里。
      //
      // 合并规则只有一条：**库行优先**。同名时库行已经在 `loaded.rows` 里，catalog 的同名项
      // 不再追加（否则一次搜索会因为同一个名字出现两遍而浪费名额）。它们不是重复，是同一名字的
      // 两个来源 —— `copies` 会如实报出总数（见下方 `copiesFor`）。
      //
      // `scope: exec.agent` 与 `skill_load` 的回退路径一致：目录是**会话级**的，
      // 同一个 cwd 在不同 scope 下可以不同。这让搜索结果随会话变化，而这是正确的 ——
      // 声明说的是 "every skill available to this agent"。
      const catalogSummaries = await loadCatalog(cwd, exec.agent, exec.signal)
      const catalogRows = []
      const catalogCounts = new Map()
      if (catalogSummaries.length > 0) {
        for (const summary of catalogSummaries) {
          const row = catalogRow(summary)
          if (row === null) continue
          const key = row.name.toLowerCase()
          // 计数要在去重**之前**做：同名出现两次是真实的两份，不是一条。
          catalogCounts.set(key, (catalogCounts.get(key) ?? 0) + 1)
          if (catalogRows.some((seen) => seen.name.toLowerCase() === key)) continue
          catalogRows.push(row)
        }
      }
      // 库行优先：同名时库行已经在 `loaded.rows` 里，catalog 的同名项不再追加为**搜索行**
      // （否则一次搜索会因为同一个名字出现两遍而浪费名额）。但它仍然算一份副本——
      // 计数在 `catalogCounts` 里，`copiesFor` 用它报出跨域构成。
      const libraryNames = new Set(loaded.rows.map((row) => row.name.toLowerCase()))
      const extraRows = catalogRows.filter((row) => libraryNames.has(row.name.toLowerCase()) === false)
      catalogNameCounts = catalogCounts
      const searchRows = extraRows.length === 0 ? loaded.rows : [...loaded.rows, ...extraRows]
      if (searchRows.length === 0) {
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
        for (const row of searchRows) {
          // repo 过滤只对库行有意义：catalog 技能不属于任何上游仓库，拿它去比 repo
          // 只会把目录整个滤掉。带 repo 过滤的查询按定义是在找库里的东西。
          if (repoFilter !== '') {
            if (row.origin === 'catalog') continue
            if (!row.repo.toLowerCase().includes(repoFilter)) continue
          }
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

      // ④（名字命中优先 + 形态排序）的适用范围：**单词查询**。
      // 多词查询里 `matchCount` 是相关度的正确信号，插入形态键会破坏它（实测三处回归）。
      // 单词查询里 `matchCount` 恒为 1、不带信息，形态才是唯一有区分力的维度。
      const singleToken = tokens.length === 1
      scored.sort((a, b) => {
        if (b.listed !== a.listed) return b.listed - a.listed
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
        // 名字命中的**形态**先于分数，但**只对单词查询**。理由见下方分档处的长注释：
        // 多词查询靠 `matchCount` 区分相关度，插入形态键会把"命中两个词但都不在名字里"的行
        // 挤到"命中一个词但在名字里"的行后面 —— 实测把 `debug failing test` 的
        // `api-analyzer` 和 `kubernetes helm` 的两条挤掉了。
        if (singleToken && b.nameForm !== a.nameForm) return b.nameForm - a.nameForm
        if (b.score !== a.score) return b.score - a.score
        if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
        if (a.row.name.length !== b.row.name.length) return a.row.name.length - b.row.name.length
        return a.row.name < b.row.name ? -1 : 1
      })
      // ── ④ 分档：名字命中的排在前面，描述命中的退到第二档 ──────────────────────────
      //
      // 为什么需要它：`includes` 是子串匹配，一个**单词**查询会拖回大量"只有描述里出现过这个词"
      // 的行。实测 `univer` 命中 44 条，其中 name 含它的只有 3 条 —— 而那 3 条里还有 3 个
      // `universal-*`（拼写巧合）。模型拿到 12 个名字，前几个全是无关的，它无从判断。
      //
      // ── 为什么只对单词查询（`tokens.length === 1`）生效 ─────────────────────────
      //
      // 这是实测定的边界，不是保守。第一版对**所有**查询都分档，回归判据 J 立刻抓到三处破坏：
      //
      //     "debug failing test"    丢失 api-analyzer（它命中 2/3 词，但都不在名字里）
      //     "kubernetes helm"       丢失 mirrord-kafka / mirrord-temporal（同上）
      //     "semgrep security scan" 顺序被打乱
      //
      // 多词查询里 `matchCount`（命中几个词）才是相关度的正确信号：命中 2 个词但都不在名字里，
      // 比命中 1 个词但在名字里更相关。而单词查询里 `matchCount` **恒等于 1**（所有命中都命中了
      // 那唯一的词），它不携带任何信息 —— 所以那里才需要形态来区分。
      //
      // 分档**不是过滤**：`total` 仍报全量，`nameMatched` 报第一档的条数，模型据此知道
      // "还有 N 条是描述命中的"，可以自己决定要不要换更具体的词。
      // 这样既不丢信息（今天的 44 条仍然可达），又让第一屏有意义。
      //
      // 第二档只在第一档**为空**时放开。用户提出的例外（"第一档有噪音时也放开第二档"）
      // 经实测**在本语料里不需要**：24 个真实查询 + 6 个补充查询里，凡第二档有名字相关的行，
      // 第一档也有（风险场景 0 个）。但那条例外并非无用 —— 它防的是未预料到的语料，
      // 所以这里退化成一条更保守的规则：**第一档非空且第二档也有内容时，仍然如实报出
      // 第二档的条数**（`nameMatched` / `total` 的差），由模型决定。
      const nameMatched = scored.filter((entry) => entry.nameHits > 0).length
      const nameTier = singleToken ? scored.filter((entry) => entry.nameHits > 0) : scored
      const restTier = singleToken ? scored.filter((entry) => entry.nameHits === 0) : []
      // ── 例外条款（用户提出，实测确认需要）──────────────────────────────────────────
      //
      // 条件：第一档**全部**是"裸片段"命中（形态 ≤ NAME_PREFIX）而第二档非空。
      // 含义：名字里根本没这个词，命中全是拼写巧合 —— 此时"名字命中优先"这个前提本身失效，
      // 正确的东西可能整批在第二档，被一个不可信的第一档挡住。
      //
      // 实测（55 个查询的扫描，`verify-tier1-all-noise.mjs`）：**恰好一条命中这个条件**，
      // 而且是退化路径 —— 当 catalog 不可达时（minimal host / 目录收集失败）搜 `univer`：
      //    第一档 3 条全是 prefix：universal-exam-cram-coach-full / -coach / universal-checkout
      //    第二档 41 条
      // 第一档里一条真 `univer*` 都没有（那些由 `dsh-univer-office` 注册，目录拿不到时不在域里）。
      //
      // 有 catalog 时这条不会触发：那时第一档含 exact 的 `univer` 与 segment 的 `univer-*`，
      // 最高形态 3 > PREFIX，名字信号是可信的。
      //
      // 放开的方式是**追加**而不是替换：第一档仍在前面（它们至少名字里含这个词），
      // 第二档接在后面。信息顺序仍然表达"先看这些"，只是不再把它们藏起来。
      const maxForm = nameTier.length === 0 ? -1 : Math.max(...nameTier.map((entry) => entry.nameForm))
      const weakNameTier = maxForm <= NAME_PREFIX && restTier.length > 0
      const shownPool = nameTier.length === 0 ? restTier : weakNameTier ? [...nameTier, ...restTier] : nameTier
      // 重名提示必须按 `copies.total` 判断，且要区分两种成因——旧代码只看 `copies > 1`，
      // 那在 `copies` 变成对象之后会把对象和数字比较（永远 false），提示会静默失效。
      // 这不是假设：`TypeError` 不会发生，比较只是恒假，所以它属于"改了不报错但功能没了"那一类。
      const duplicated = scored.filter((entry) => copiesFor(entry.row.name).total > 1)
      const duplicatedRepos = new Set(
        duplicated.map((entry) => String(entry.row.repo)).filter((repo) => repo !== ''),
      )
      const hasCrossDomain = duplicated.some((entry) => {
        const c = copiesFor(entry.row.name)
        return c.library > 0 && c.catalog > 0
      })
      const hits = []
      for (const entry of shownPool.slice(0, limit)) {
        const located = await resolveRow(entry.row)
        const isCatalog = entry.row.origin === 'catalog'
        hits.push({
          name: entry.row.name,
          // catalog 技能不属于任何上游仓库：空字符串是如实的（它确实没有 repo），
          // 而来源另给一个字段，模型才分得清"没有 repo"和"我们没查"。
          repo: entry.row.repo,
          ...(isCatalog ? { origin: 'catalog', source: entry.row.catalogSource } : {}),
          description: descLength === 0 ? '' : truncate(entry.row.description, descLength),
          // Empty for every skill whose frontmatter has no whenToUse, which is all of them
          // in most libraries; the field exists so a writer that fills it is rewarded.
          whenToUse: descLength === 0 ? '' : truncate(String(entry.row.whenToUse ?? ''), descLength),
          files: entry.row.files,
          // 副本构成按来源分开报（见 `copiesFor`）：库内多份要靠 `repo` 选，
          // 跨域同名**不能**靠 `repo` 选（catalog 技能不属于任何 repo）。
          // 合成一个数字会让模型去找一个不存在的 repo 参数。
          copies: copiesFor(entry.row.name),
          matchCount: entry.matchCount,
          // A row whose SKILL.md is gone means the index is out of date — the normal
          // result of deleting a skill directory without regenerating it. Reporting it
          // here lets the model say so instead of offering a skill that cannot load.
          stale: located.missing,
          // Only present when the caller asked to explain, so the normal path pays nothing
          // for it. This is the answer to "why did this query match / not match".
          ...(entry.why === undefined ? {} : { score: entry.score, why: entry.why }),
          path: located.path,
          // `libraryRelative` 只对库行有意义：catalog 行的 repo/relpath 是空的，
          // 拼出来是 "/"，那不是路径而是噪声。
          ...(isCatalog ? {} : { libraryRelative: entry.row.repo + '/' + entry.row.relpath }),
        })
      }
      // 索引完整性报警：只在真报警时出现（正常路径零成本、零噪音）。
      const indexAlarm = loaded.indexIntegrity?.status === 'alarm' ? loaded.indexIntegrity : undefined
      const alarmNote = indexAlarm === undefined
        ? ''
        : 'INDEX INTEGRITY ALARM — ' + indexAlarm.problems.join(' | ') +
          '. Likely cause: the index was edited by hand or by another tool without running scan-skills.ps1, ' +
          'or the last scan was interrupted. See skill-index.meta.json and skill-index.dropped.tsv next to the ' +
          'index; rerun scan-skills.ps1 to realign. '
      return jsonSafe({
        library: loaded.root,
        // 只有当这次真的读的是随插件发布的入门库时才出现。用户必须能分辨"我的库被读到了"和
        // "这是入门示例"——那两种情况下的诊断方向完全不同。第一版这个标记加在了上面那条
        // "没有可搜索关键词"的分支上，于是有结果时它反而不出现：分支选错，功能就等于没有。
        starterLibrary: loaded.bundled === true ? true : undefined,
        query,
        // `total` 仍是命中全量（含只被描述命中的），一个字都不少。
        total: scored.length,
        strict,
        // 名字里含关键词的命中数。多词查询下它仍如实统计，但**分档不生效**，
        // 所以此时 `total` 与它相等或不等都不代表"有第二档被挡住"——见 note 的条件。
        nameMatched,
        shown: hits.length,
        names_only: namesOnly,
        // `more` 按**已展示的那一档**算：第一档还有没显示完的，才算 more。
        // 若第一档已全部显示而第二档被挡在后面，那不是"more of the same"，
        // 而 note 已经说清了第二档的存在与条数。
        more: shownPool.length > hits.length,
        fallback,
        hits,
        // 只在真报警时出现：详情见 .dsh/SKILLS-POLICY.md §十七·附。
        indexAlarm: indexAlarm === undefined ? undefined : indexAlarm.problems,
        error: '',
        explain: explaining,
        note:
          alarmNote +
          (hits.length === 0
            ? fallback === 'weak'
              ? 'Nothing contained every keyword, and the closest partial matches each shared only one of ' +
                String(tokens.length) +
                ' — too weak to offer. Search again with fewer or different keywords.'
              : 'No library match. Try broader or different keywords, or drop the repo filter; rerun with explain: true to see how each keyword scored against each field.'
            : fallback === 'or'
              ? 'No skill matched every keyword, so these match all but one (matchCount of ' + String(tokens.length) + '). Search again with fewer words to get an exact match.'
              : 'Call skill_load with one exact name to read its full instructions.' +
                // 分档说明：只在**第二档真的被挡在后面**时才提。
                // 条件是 `restTier.length > 0` —— 少了它，一句 note 会在"全部命中都在
                // 名字里"（restTier 为空）时声称"the other 0 match only on description"，
                // 那是把不存在的东西说成存在。实测这条被 K2 判据抓到过。
                (singleToken && nameTier.length > 0 && restTier.length > 0
                  ? weakNameTier
                    ? ' Warning: no skill NAME contains this word — the matches above are spelling coincidences, ' +
                      'so the ' + String(restTier.length) + ' description/path matches are shown too.'
                    : ' These are the ' + String(nameMatched) + ' whose NAME contains a keyword; the other ' +
                      String(restTier.length) +
                      ' match only on description or path — search a more specific word to see those.'
                  : '') +
                (duplicated.length === 0
                  ? ''
                  : hasCrossDomain
                    ? ' Some names here exist in both the library and this session\'s catalog (copies.library / copies.catalog): pass repo to choose a library copy, and note that a catalog copy has no repo.'
                    : ' Pass repo too when copies.total > 1.')),
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
    const missing = { name: raw, source: '', repo: '', copies: { total: 0, library: 0, catalog: 0 }, path: '', resourceDir: '', content: '', referenceFiles: [], stale: false, error: '' }
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
            // 常驻加载走的是 registry 直查，与库/catalog 的副本计数无关：这里是"按名命中了一份"。
            copies: { total: 1, library: 0, catalog: 1 },
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
      copies: chosen === null ? { total: 0, library: 0, catalog: 0 } : copiesFor(chosen.name),
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
import { createHash, randomUUID } from 'node:crypto'
import { dirname as dirnamePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDiscoveryLogPath, discoveryRecord, makeDiscoveryRecorder, turnCallsRecord } from './discovery.js'

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

/** Share of eligible HIGH opportunities assigned to the control arm (no hint). */
const CONTROL_SHARE = 0.5

/**
 * Which arm of the experiment a **session** falls into: `'treatment'` or `'control'`.
 *
 * Exported because it is the single most important thing to be able to test about this experiment:
 * if the split were biased, or not deterministic, every number the readout produces would be
 * meaningless while still looking plausible.
 *
 * ── why the unit is the session, not the turn ────────────────────────────────────────────
 *
 * An earlier version randomised per turn. That is wrong here, and not for a statistical taste
 * reason: **the intervention is durable.** Verified in the harness rather than assumed —
 * `dsh-agent-loop` appends the step's messages with
 *
 *     this.session.append('user/message', message, { surfaceOp: 'append' })
 *
 * so the hint lands on the session surface and is part of the history every later step derives from.
 * (Observed directly: an injected hint appears in a session projection as a `skill-router` surface
 * node carrying ~90 tokens.)
 *
 * With per-turn arms that makes the "control" group a lie in one direction only:
 *
 *     turn 10  treatment  ->  hint enters the session surface
 *     turn 11  control    ->  no NEW hint, but the turn-10 hint is still in context
 *
 * so treatment contaminates every later control opportunity, while control never contaminates
 * treatment. Pooling those turns would bias the comparison in a known direction and the resulting
 * number would look perfectly reasonable.
 *
 * Randomising per session removes that path entirely: a control session never receives a hint, so
 * nothing of the intervention can leak into any of its opportunities.
 *
 * The cost is that the two arms are now different conversations rather than the same one, so they may
 * differ in capability or context. That is the trade that has to be made once the intervention
 * persists — matching within a conversation is only worth having if the arms are still independent,
 * and per-turn arms are not.
 *
 * ── and the unit of MEASUREMENT is the session's first eligible opportunity ──────────────
 *
 * Even with a per-session arm, later opportunities inside one session are not independent samples:
 * the agent searched once, learned a skill, and its later turns are shaped by that. The first
 * eligible opportunity of a session is the one observation guaranteed to precede any hint ever
 * being shown, so it is the clean unit. The plugin records `firstEligible` per record; the readout
 * reports the primary metric over first opportunities and treats all-opportunity numbers as
 * exploratory.
 *
 * `sha256(sessionKey)` rather than a random number, so that:
 *   * one conversation cannot flip arms on a retry or a replayed step;
 *   * there is no RNG state to persist;
 *   * nothing about the user or the task enters the choice — only an identifier already hashed
 *     beyond recovery;
 *   * the split is reproducible from the log alone.
 *
 * ── the cost, stated plainly ────────────────────────────────────────────────────────────
 *
 * Half of all sessions get **no hint at all**, for their entire length. If the hint is effective,
 * this experiment withholds a working aid from those sessions while it runs, and that is a heavier
 * cost than withholding it from half the turns. It is the price of a causal answer instead of a
 * correlated one, and it is the owner's decision, not a silent default.
 */
export function experimentArmOf(sessionKey) {
  const digest = createHash('sha256').update(String(sessionKey)).digest('hex')
  // First 8 hex digits -> [0,1); 16^8 is far above the precision a coin flip needs.
  return parseInt(digest.slice(0, 8), 16) / 0x100000000 < CONTROL_SHARE ? 'control' : 'treatment'
}

/**
 * Characters of a candidate's description the hint may show.
 *
 * ── why a description is shown at all ───────────────────────────────────────────────────
 *
 * The hint used to render the matched field NAMES: `semgrep (name, description, path)`. On 304 of
 * 467 measured candidates every field matched, so the parenthetical was identical for nearly every
 * line — a literal, not a description. With five unfamiliar names and no statement of what any of
 * them does, the model had nothing to judge relevance by, and the observed outcome was the one that
 * costs nothing: continue with `read`/`edit`/`pwsh`. The telemetry agrees — 14 injections, zero
 * library loads that followed.
 *
 * A name alone cannot be judged; a purpose can. 60 characters is enough for the first clause of a
 * real description ("Static analysis security review for source code"), and it is the byte budget
 * that decides the number, not the other way round.
 */
const HINT_DESCRIPTION_CHARS = 60

/**
 * The one-line hint. Names and a capped description each — the byte budget is still the design.
 *
 * Measured on the real library: 532–549 bytes across three tasks, against 327–344 for the
 * field-name version — ~57 more bytes per injected turn. That is deliberate: the cheap version was
 * cheap because it said nothing. (Not the ~700–900 first estimated before rendering it: `truncate`
 * cuts at a character count, and most real descriptions hit that cap.)
 * `cleanDescription` (index parse) and whitespace collapsing are already applied upstream, so a
 * description cannot smuggle newlines or a YAML block marker into a one-line message.
 */
function discoveryHint(result) {
  const parts = result.candidates.map((c) => {
    const why = cleanDescription(c.description)
    return why === '' ? String(c.name) : String(c.name) + ' — ' + truncate(why, HINT_DESCRIPTION_CHARS)
  })
  return (
    'Maybe relevant skills for this task: ' + parts.join('; ') + '. ' +
    'Load any that fit with skill_load, or ignore this and continue without one.'
  )
}

/**
 * Wrap the hint as a user-role message for `decision.messages`.
 *
 * The shape is copied from what the framework's own `createUserMessage` produces rather than
 * guessed: `{ role, content, source, id }`, where `content` is an array of `{ type, text }` blocks,
 * `source` is an open `{ kind }` tag (the official hooks plugin uses its own name there; kinds are
 * not an enum) and `id` is a fresh UUID. `createUserMessage` additionally deep-freezes the message;
 * this one is not frozen, and nothing downstream requires that — an immutable clone would cost a
 * `structuredClone` per turn for no behavioural difference.
 *
 * **The id is not decoration.** Framework messages always carry one, and two injected messages
 * sharing an id would be indistinguishable to anything that keys on it — so it is random per call
 * and there is an assertion for it in the tests.
 */
/**
 * The session's creation time as an ISO string, or `null` when it cannot be established.
 *
 * ── why this is recorded at all ─────────────────────────────────────────────────────────
 *
 * `firstEligibleSeen` is process memory and is empty after a restart, while a session is durable
 * and resumable. So a session that already received hints before the restart can later present its
 * next HIGH opportunity as "this session's first" — the contamination did not disappear, it moved
 * from across turns to across processes. The experiment protocol therefore admits only sessions
 * **created after T0**, and that needs a creation time on every record.
 *
 * ── why it is normalised here rather than compared as-is ────────────────────────────────
 *
 * `session.header.createdAt` is an epoch-millisecond **number** in every session on this machine
 * (measured), but the field is not declared as a number, and a log that mixes numbers with ISO
 * strings cannot be compared with `--since` at all — `1789…` and `"2026-09-27T…"` do not order
 * against each other. Normalising once, at the source, keeps the later comparison honest.
 *
 * An unparseable value is `null` (loudly visible in the log) rather than a fallback timestamp:
 * a fabricated creation time would silently admit exactly the sessions this gate exists to exclude,
 * so the failure direction has to be "visible", never "plausible".
 */
function sessionCreatedAtOf(session) {
  if (session === undefined || session === null) return null
  const header = session.header
  if (header === undefined || header === null || header.createdAt === undefined || header.createdAt === null) return null
  const raw = header.createdAt
  // Numeric epoch: seconds or milliseconds. Anything below ~1e11 is seconds (1e11 ms is 1973).
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e11 ? raw * 1000 : raw
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof raw === 'string') {
    const date = new Date(raw)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

function contextMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-router' },
  }
}

export function apply(ctx, config) {
  const router = buildSkillRouterTools(ctx, (toolName, tool) => {
    ctx.effect(() => ctx.tools.register(tool), 'skill-router: ' + toolName)
  })

  // ── discovery: measure, and inject only what has earned it ──────────────────────────────
  //
  // At the first step of a turn the library is ranked for the incoming task, and HIGH-tier
  // candidates are put in front of the model. `agent/pre-step` is the right seam because it runs
  // before the request is built and its `enter.messages` is the authoritative batch for the step.
  //
  // Two facts about the seam, both verified in the harness rather than assumed:
  //   * `step` must be 1. The waterfall runs per step, and the messages it replaces are that
  //     step's claimed batch, so hinting on every step would repeat the hint for one task.
  //   * `agent.inject()` is NOT the way to make the hint visible to the current step:
  //     `preStep` calls `inbox.claim()` before dispatching the waterfall, so an injected message
  //     lands in `next-step` and is only claimed at the NEXT step. The current step sees exactly
  //     `decision.messages` — so the hint belongs in that array, which is also what becomes the
  //     session's `user/message` for the first attempt.
  //
  // ── why HIGH only, and why this is an experiment rather than the design ──────────────────
  //
  // Measured before this shipped: across 273 turns the library was searched essentially never and
  // every record said `injected: false`. The hypothesis under test is narrow and causal — **the
  // agent does not fail to use skills, it is never told which ones are worth considering** — and
  // testing it needs one changed variable. So HIGH only (`nameHits > 0`, at least two tokens
  // landed), and nothing about retrieval changed in this version: the strict-AND policy, the
  // tokenizer and the tier thresholds are all exactly as they were, so a change in behaviour can
  // be attributed to the hint rather than to a second edit.
  //
  // The cost is why it is worth trying at all: the resident catalog costs ~3,238 tokens per turn
  // and the three tool schemas ~1,001, while a five-name hint measures 329–341 bytes (~91–95 tokens)
  // on the real library. An earlier note said ~57; that came from short sample names and was wrong.
  const INJECT_TIERS = new Set(['HIGH'])

  /**
   * Whether this session has already had its first eligible opportunity.
   *
   * The experimental unit is **one session, one opportunity** — see `experimentArmOf`. Tracking the
   * first is what makes the primary measurement interpretable, and it is recorded rather than derived
   * because "first" is a property of the session's history, not of any single record.
   */
  const firstEligibleSeen = new Set()

  // Writing the task's own keywords to disk off by default: a keyword can carry a project, a
  // customer or a vulnerability name. `ctx.config` first (so a patch row can set it) with an env
  // var as the fallback, because whether cordis hands a mounted row its config is not something
  // this repo has verified.
  const debugTokens = config !== null && typeof config === 'object' && config.discovery !== null && typeof config.discovery === 'object' && config.discovery.debugTokens === true
    ? true
    : process.env.DSH_SKILL_ROUTER_DEBUG_TOKENS === '1'
  const discoveryLog = process.env.DSH_SKILL_ROUTER_DISCOVERY_LOG
  const recorder = makeDiscoveryRecorder(discoveryLog === undefined ? defaultDiscoveryLogPath() : discoveryLog, undefined)
  if (recorder.path !== undefined) {
    /**
     * Per-turn tool-call counters.
     *
     * The question this answers cannot be asked at `step === 1`: at that moment nobody knows
     * whether the turn will end up calling `skill_search`. So calls are accumulated from the
     * session event stream and flushed when the turn is over.
     *
     * "Over" is observed from that same stream: the harness appends `turn/end` at the end of every
     * turn — in a `finally`, so a canceled or failed turn is closed too — and `session/disposed`
     * covers a session torn down between turns. Both are events this plugin can already see:
     * `turn/end` rides the very `session/event` channel whose `tool/call` events are counted below,
     * and the format decoder requires a turn's call set to be closed before `turn/end` is appended,
     * so the counts are complete at that instant.
     *
     * The previous version of this comment reached the opposite conclusion from a true premise: it
     * looked for a turn-stopping *waterfall* (`agent/turn-stopping`), found none in 0.1.7-rc.2, and
     * treated turn end as unobservable — although `dsh-agent-loop` appends
     * `this.session.append('turn/end', { turn, reason })` and `dsh-session-projection-cache`
     * consumes it as `ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') … })`.
     * The plugin was listening on that channel the whole time for `tool/call`.
     *
     * Settling at `turn/end` rather than at the **next** turn's first step is what makes a session's
     * LAST turn countable — and a session's first eligible opportunity is usually its last turn,
     * which is the single observation the experiment's primary metric is built from. Only the moment
     * of writing changes: the same counters, for the same (sessionKey, turn), are written, which an
     * offline recount from the session logs confirmed (55 of 55 overlapping (session, turn) units,
     * all five counters equal). The next-turn flush is kept as a backstop; because `turn/end` clears
     * the state it settles, the backstop can only fire for a turn whose `turn/end` never arrived.
     */
    const countedTools = new Set(['skill_search', 'skill_load', 'skill_ref', 'skill'])

    /**
     * A stable, non-reversible label for one session.
     *
     * **Why this is not optional.** The turn counter used to be module-level, and telemetry carried
     * no session identity — so two conversations interleaved their counts, and two sessions that
     * both reached turn 12 were indistinguishable in the log. Measured on the live log: `turn` 1
     * appeared 3 times, and 14 turn numbers were duplicated. Analysis that pairs records by `turn`
     * alone therefore merges different conversations, which is enough to invert a conclusion.
     *
     * The label is a hash prefix because the session id is an opaque identifier the log has no use
     * for: pairing needs equality, not identity. 8 hex characters are enough to separate the handful
     * of concurrent sessions while keeping the log free of host identifiers.
     */
    const sessionKeyOf = (session) => {
      const id = session === undefined || session === null || session.id === undefined ? '' : String(session.id)
      return id === '' ? 'unknown' : createHash('sha256').update(id).digest('hex').slice(0, 8)
    }
    // sessionKey -> the turn currently being counted for it.
    const perSession = new Map()

    /** Settle one session's turn. Keyed by sessionKey so concurrent sessions cannot mix counts. */
    const flush = (sessionKey) => {
      const done = perSession.get(sessionKey)
      if (done === undefined) return
      perSession.delete(sessionKey)
      try {
        recorder.write(turnCallsRecord({ turn: done.turn, sessionKey, tier: done.tier, injected: done.injected, arm: done.arm, calls: done.calls, otherToolCalls: done.other }))
      } catch {
        /* telemetry is never worth a failed turn */
      }
    }

    ctx.on('session/event', (session, event) => {
      if (event === null || typeof event !== 'object') return
      if (event.type === 'turn/end') {
        // The turn is over, and its call set is closed: settle it here instead of waiting for a next
        // turn that may never come. Without this, every session's last turn is never written — and
        // that is the turn the first-eligible observation usually falls in.
        flush(sessionKeyOf(session))
        return
      }
      if (event.type !== 'tool/call') return
      const state = perSession.get(sessionKeyOf(session))
      if (state === undefined) return
      const name = event.data === null || typeof event.data !== 'object' ? '' : String(event.data.name ?? '')
      if (name === '') return
      if (countedTools.has(name)) state.calls[name] = (state.calls[name] ?? 0) + 1
      else state.other += 1
    })

    ctx.on('session/disposed', (session) => {
      // A session torn down between turns (closed window, crash) has no next step to settle it;
      // whatever was counted for its open turn is written rather than dropped.
      flush(sessionKeyOf(session))
    })

    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next()
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      if (step !== 1) return decision
      // Backstop only: `turn/end` already settled the previous turn and cleared its state, so in a
      // healthy session this finds nothing. It exists for a turn whose `turn/end` never arrived.
      const session = agent === undefined || agent === null ? undefined : agent.session
      const sessionKey = sessionKeyOf(session)
      const sessionCreatedAt = sessionCreatedAtOf(session)
      flush(sessionKey)
      const taskText = taskTextOf(messages).trim()
      if (taskText === '') return decision
      try {
        const started = Date.now()
        const cwd = agent === undefined || agent === null ? '' : String(agent.session.header.cwd ?? '')
        const result = await router.discover(taskText, cwd, signal)
        // Eligible means "the system considers this high quality". The arm belongs to the SESSION (see
        // `experimentArmOf` for why per-turn arms were wrong), and only the arm decides whether the
        // hint goes out — so both arms are the same kind of task by construction, which is what the
        // earlier HIGH-vs-everything-else comparison lacked.
        const eligible = INJECT_TIERS.has(String(result.tier)) && result.candidates.length > 0
        const arm = eligible ? experimentArmOf(sessionKey) : 'not-eligible'
        // The session's FIRST eligible opportunity is the primary experimental unit: it is the only
        // observation that provably precedes any hint this experiment could have shown, so nothing
        // durable can have leaked into it. Later ones are recorded (and reported separately) but they
        // are not independent samples once the agent has searched and learned something.
        const firstEligible = eligible && firstEligibleSeen.has(sessionKey) === false
        if (eligible) firstEligibleSeen.add(sessionKey)
        const inject = eligible && arm === 'treatment'
        const hint = inject ? discoveryHint(result) : ''
        perSession.set(sessionKey, { turn: typeof turn === 'number' ? turn : null, tier: String(result.tier), injected: inject, arm, calls: {}, other: 0 })
        recorder.write(
          discoveryRecord({
            turn,
            step,
            result,
            elapsedMs: Date.now() - started,
            indexRows: result.indexRows,
            injected: inject,
            firstEligible,
            // `arm` is the assignment, `injected` is what actually happened. Kept as two fields so a
            // control turn that somehow carried a hint would be visible rather than invisible.
            arm,
            // Measured, not estimated: the case for injecting rests on this number being small.
            hintBytes: Buffer.byteLength(hint, 'utf8'),
            tokensUsed: debugTokens ? result.effectiveTokens : undefined,
            debugTokens,
            sessionKey,
            sessionCreatedAt,
          }),
        )
        // Appended to this step's claimed batch — not injected into the inbox.
        return inject ? { ...decision, messages: [...decision.messages, contextMessage(hint)] } : decision
      } catch (error) {
        // Telemetry is never worth a failed turn — but a silent catch is how a run produces
        // "three days, no data" and nothing to look at. Keep the failure observable in-process
        // (tests read this) without writing anything to the user's session.
        const sink = globalThis.__dshSkillRouterDiscoveryErrors
        if (Array.isArray(sink)) sink.push(String(error && error.message ? error.message : error))
        return decision
      }
    })
  }
}
