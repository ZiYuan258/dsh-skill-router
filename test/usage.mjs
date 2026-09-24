// collectSkillUsage 的单测。
//
// 这个函数是技能看板的唯一数据来源，而它的字段路径来自一次真实会话的探针（183 个节点），
// 不是推断——之前的三个猜测（kind:'tool-call' 节点、node.block.call、conv.blocks）全错，
// 所以夹具刻意照抄探针打印出的真实形状：
//
//   assistant 节点: { kind: 'assistant', blocks: [ { kind: 'tool-call', name, arguments } ] }
//   tool-result 节点: { kind: 'tool-result', call: { name, argsRaw: '<json string>' } }
//
// tool-result 节点必须被忽略（否则每次调用会被记两次）。
import { collectSkillUsage } from '../host.js'

const problems = []
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

/** One assistant node carrying tool-call blocks, in the shape the probe reported. */
const assistant = (blocks) => ({ kind: 'assistant', seq: 1, messageId: 'm1', turn: 1, step: 1, blocks })
const call = (name, args) => ({ kind: 'tool-call', name, arguments: args })

console.log('collectSkillUsage:')

// --- the three tools that mean "a skill was loaded" --------------------------
const one = collectSkillUsage([assistant([call('skill_load', { name: 'gh-cli' })])])
check('skill_load by name is collected', one.length === 1 && one[0].name === 'gh-cli', JSON.stringify(one))

const resident = collectSkillUsage([assistant([call('skill', { name: 'verification-before-completion' })])])
check('the resident `skill` tool is collected', resident.length === 1 && resident[0].name === 'verification-before-completion', JSON.stringify(resident))

const ref = collectSkillUsage([assistant([call('skill_ref', { name: 'semgrep', path: 'references/x.md' })])])
check('skill_ref counts as loading its skill', ref.length === 1 && ref[0].name === 'semgrep', JSON.stringify(ref))

// --- arguments that arrive as a JSON string (tool-result.call.argsRaw shape) ---
const asText = collectSkillUsage([assistant([call('skill_load', { names: '["a-b","c-d"]' })])])
check('a JSON-string argument is parsed for names', asText.length === 2, JSON.stringify(asText))

const multi = collectSkillUsage([assistant([call('skill_load', { names: 'gh-cli, pytest-skill' })])])
check('a comma-separated names list is split', multi.length === 2 && multi[1].name === 'pytest-skill', JSON.stringify(multi))

// --- things that must NOT be collected ---------------------------------------
const searched = collectSkillUsage([assistant([call('skill_search', { query: 'gh-cli' })])])
check('skill_search is not a load', searched.length === 0, JSON.stringify(searched))

const other = collectSkillUsage([assistant([call('pwsh', { command: 'ls' }), call('read', { file_path: 'a.md' })])])
check('unrelated tools are ignored', other.length === 0, JSON.stringify(other))

// A tool-result node repeats the same call; counting it would double every load.
const resultNode = { kind: 'tool-result', seq: 2, callId: 'c1', call: { name: 'skill_load', argsRaw: '{"name":"gh-cli"}' }, content: [] }
check('tool-result nodes are not counted (no double count)', collectSkillUsage([resultNode]).length === 0, JSON.stringify(collectSkillUsage([resultNode])))

// --- dedupe and normalisation ------------------------------------------------
const dupes = collectSkillUsage([assistant([call('skill_load', { names: 'gh-cli, gh-cli' })])])
check('a repeated name in one call counts once', dupes.length === 1, JSON.stringify(dupes))

// `Q:` on purpose: the same fictional drive the resolvePath fixtures use, so a normalising
// test never reads as a real machine path to this repository's own scanner.
const pathish = collectSkillUsage([assistant([call('skill_load', { name: 'Q:/lib/skills/gh-cli/SKILL.md' })])])
check('a full SKILL.md path normalises to the skill name', pathish.length === 1 && pathish[0].name === 'gh-cli', JSON.stringify(pathish))

const blank = collectSkillUsage([assistant([call('skill_load', {}), call('skill_load', { name: '   ' })])])
check('a call with no usable name contributes nothing', blank.length === 0, JSON.stringify(blank))

// --- order, and the shapes that must not throw --------------------------------
const ordered = collectSkillUsage([
  assistant([call('skill_load', { name: 'first-one' })]),
  { kind: 'user', seq: 2 },
  assistant([call('skill_load', { name: 'second-one' })]),
])
check('skills come back in conversation order', ordered.map((x) => x.name).join(',') === 'first-one,second-one', JSON.stringify(ordered.map((x) => x.name)))

for (const weird of [undefined, null, 'nodes', 42, {}, [null, 7, 'x', {}], { kind: 'assistant' }, assistant([null, 'x', {}, { kind: 'tool-call' }])]) {
  let threw
  let value
  try {
    value = collectSkillUsage(weird)
  } catch (error) {
    threw = error
  }
  check('malformed input yields [] without throwing: ' + JSON.stringify(weird), threw === undefined && Array.isArray(value) && value.length === 0, threw === undefined ? JSON.stringify(value) : String(threw))
}

// --- the batch cap ------------------------------------------------------------
const many = collectSkillUsage([assistant([call('skill_load', { names: Array.from({ length: 20 }, (_, i) => 'skill-' + i).join(',') })])])
check('one call cannot exceed the batch cap', many.length === 8, 'got ' + many.length)

console.log(problems.length === 0 ? 'usage collection: OK' : 'usage collection FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
