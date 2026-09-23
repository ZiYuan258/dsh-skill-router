// Batch loading must work no matter how the transport delivers the names, because an
// array argument that arrives JSON-encoded silently becomes one (nonexistent) skill name.
import { buildSkillRouterTools } from '../host.js'
import { dropFixture, findLibrary, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

const libraryRoot = findLibrary()
const fixture = libraryRoot === undefined ? makeFixture() : undefined
const cwd = libraryRoot ?? fixture

// Names that exist in whichever library we ended up with.
const alpha = libraryRoot === undefined ? 'alpha-widgets' : 'gh-cli'
const beta = libraryRoot === undefined ? 'beta-gadgets' : 'pytest-skill'

const tools = new Map()
buildSkillRouterTools(makeFsContext(cwd), (toolName, tool) => tools.set(toolName, tool))
const load = tools.get('skill_load')
const exec = makeExec(cwd)

async function loads(label, args, expected) {
  const result = await load.execute(args, exec)
  const got = String(result.loaded).split(', ').filter(Boolean).sort().join(',')
  check(label, got === [...expected].sort().join(','), 'got: ' + (got || '(nothing)'))
}

console.log('transport shapes for a multi-skill request:')
await loads('array                ', { name: [alpha, beta] }, [alpha, beta])
await loads('JSON-encoded array   ', { name: JSON.stringify([alpha, beta]) }, [alpha, beta])
await loads('comma-separated      ', { name: alpha + ',' + beta }, [alpha, beta])
await loads('newline-separated    ', { name: alpha + '\n' + beta }, [alpha, beta])
await loads('explicit names param ', { names: alpha + ', ' + beta }, [alpha, beta])
await loads('single string        ', { name: alpha }, [alpha])

console.log('\nedge cases:')
const none = await load.execute({}, exec)
check('empty call explains how to pass a name', String(none.note).includes('Pass name'), String(none.note))

const mixed = await load.execute({ name: alpha + ',no-such-skill-xyz' }, exec)
check('one bad name still loads the good one', String(mixed.loaded).includes(alpha))
check('one bad name lands in failed', String(mixed.failed).includes('no-such-skill-xyz'))

const capped = await load.execute({ names: Array.from({ length: 12 }, (_, i) => alpha + i).join(',') }, exec)
check('the 8-name cap holds', capped.skills.length <= 8, 'processed ' + capped.skills.length)

if (fixture !== undefined) dropFixture(fixture)

console.log(problems.length === 0 ? '\nbatch shapes: OK' : '\nbatch shapes FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
