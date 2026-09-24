// skill_ref reads one bundled file instead of a whole directory, which is where the token
// saving lives — so its containment rule is security-relevant and gets tested directly.
import { buildSkillRouterTools, resolvePath } from '../host.js'
import { dropFixture, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

// --- resolvePath: the containment primitive ----------------------------------
console.log('resolvePath (no I/O, must reject ../ before any read):')
// resolvePath normalizes without relativizing: the root is preserved, `.`/`..` collapse.
//
// `Q:` on purpose: a drive letter that cannot exist as a real path here, so these stay
// unmistakably test inputs. `C:` would read as a machine path — including to this repo's
// own no-local-paths scanner.
const cases = [
  ['Q:/lib/skills/foo/references/a.md', 'Q:/lib/skills/foo/references/a.md'],
  ['Q:\\lib\\skills\\foo\\references\\a.md', 'Q:/lib/skills/foo/references/a.md'],
  ['Q:/lib/skills/foo/./a.md', 'Q:/lib/skills/foo/a.md'],
  ['Q:/lib/skills/foo/x/../a.md', 'Q:/lib/skills/foo/a.md'],
  ['Q:/lib/skills/foo/../../../etc/passwd', 'Q:/etc/passwd'],
  ['/abs/lib/foo/a.md', '/abs/lib/foo/a.md'],
  ['/abs/lib/foo/../bar', '/abs/lib/bar'],
]
for (const [input, expected] of cases) {
  const got = resolvePath(input)
  check(`${input}  ->  ${expected}`, got === expected, 'got ' + got)
}
const root = resolvePath('Q:/lib/skills/foo')
const contained = (p) => {
  const full = resolvePath(root + '/' + p)
  return full === root || full.startsWith(root + '/')
}
check('a nested reference is contained', contained('references/a.md'))
check('../ escapes and is rejected', !contained('../secret'))
check('a/../../b escapes and is rejected', !contained('a/../../b'))
check('a sibling with the same prefix is rejected', !contained('../fooother/x'))

// --- the tool against a real fixture ----------------------------------------
const cwd = makeFixture()
const tools = new Map()
buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
const ref = tools.get('skill_ref')
const exec = makeExec(cwd)
check('skill_ref is registered', ref !== undefined)
check('skill_ref parameters are object-rooted', ref?.parameters?.type === 'object' && ref?.parameters?.additionalProperties === false)

console.log('\nskill_ref behaviour:')
const listed = await ref.execute({ name: 'beta-gadgets', list: true }, exec)
check('list returns bundled files', Array.isArray(listed.files) && listed.files.some((f) => f.includes('playbook.md')), JSON.stringify(listed.files))
check('list marks directories with a trailing slash', listed.files.some((f) => f.endsWith('/')), JSON.stringify(listed.files))

const read = await ref.execute({ name: 'beta-gadgets', path: 'reference/playbook.md' }, exec)
check('reads a nested reference file', String(read.content).includes('Reference detail'), String(read.error))
check('reports the byte count', read.bytes > 0)
check('reports the base directory it resolved against', String(read.baseDir).includes('beta-gadgets'))

const escaped = await ref.execute({ name: 'beta-gadgets', path: '../skill-index.tsv' }, exec)
check('refuses to escape the skill directory', String(escaped.error).includes('escapes'), String(escaped.error))
check('an escape attempt still returns no content', String(escaped.content) === '')

const missingFile = await ref.execute({ name: 'beta-gadgets', path: 'reference/nope.md' }, exec)
check('a missing file explains how to list', String(missingFile.error).includes('list: true'), String(missingFile.error))

const noPath = await ref.execute({ name: 'beta-gadgets' }, exec)
check('no path and no list explains both options', String(noPath.error).includes('list: true'), String(noPath.error))

const unknown = await ref.execute({ name: 'no-such-skill-xyz', path: 'a.md' }, exec)
check('an unknown skill points at skill_search', String(unknown.error).includes('skill_search'), String(unknown.error))

const wrongRepo = await ref.execute({ name: 'alpha-widgets', repo: 'beta-skills', path: 'SKILL.md' }, exec)
check('a wrong repo hint reports where the skill does live', String(wrongRepo.error).includes('exists in'), String(wrongRepo.error))

const official = await ref.execute({ name: 'alpha-widgets', path: 'SKILL.md' }, exec)
check('reads a SKILL.md too', String(official.content).includes('Fixture body'))

dropFixture(cwd)
console.log(problems.length === 0 ? '\nskill_ref: OK' : '\nskill_ref FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
