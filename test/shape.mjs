// Shape check for the multi-name skill_load and the autonomous-selection wording.
import { buildSkillRouterTools, LOAD_DESCRIPTION, SEARCH_DESCRIPTION } from '../host.js'

const tools = new Map()
buildSkillRouterTools({ fs: {}, get: () => undefined, effect: () => () => {} }, (toolName, tool) => tools.set(toolName, tool))

const load = tools.get('skill_load')
const search = tools.get('skill_search')

const problems = []
const loadParams = load.parameters
const nameSpec = loadParams?.properties?.name
if (loadParams?.type !== 'object') problems.push('skill_load.parameters must be object-rooted (type: "object")')
if (nameSpec?.type !== 'string') problems.push('skill_load.name must be a plain string (a oneOf array branch does not survive the transport)')
if (nameSpec?.oneOf !== undefined) problems.push('skill_load.name must not use oneOf — array arguments arrive stringified')
if (loadParams?.properties?.names?.type !== 'string') problems.push('skill_load.names must be a plain string for multi-skill calls')
if (search.parameters?.type !== 'object' || !search.parameters?.required?.includes('query')) problems.push('skill_search.query must be required via the root required array')

// The two descriptions are what make the agent select skills without asking the user.
for (const phrase of ['do not ask the user', 'before any non-trivial task', 'capability is missing']) {
  if (!SEARCH_DESCRIPTION.includes(phrase)) problems.push(`SEARCH_DESCRIPTION is missing "${phrase}"`)
}
for (const phrase of ['one or more skills', 'in one call', 'IS the task instructions', 'not in the catalog']) {
  if (!LOAD_DESCRIPTION.includes(phrase)) problems.push(`LOAD_DESCRIPTION is missing "${phrase}"`)
}

// Descriptions address a general install, so they may not carry the author's setup as a
// fact. "the ~1000-skill staged library" told every reader with a 40-skill library
// something untrue about their own machine, and a description is read by the model on
// every turn — it is the last place a local detail belongs.
for (const phrase of ['~1000', '1000-skill', '1025', '.dsh/skills']) {
  if (SEARCH_DESCRIPTION.includes(phrase)) problems.push(`SEARCH_DESCRIPTION must not hard-code "${phrase}" — it is a fact about one machine, not the plugin`)
  if (LOAD_DESCRIPTION.includes(phrase)) problems.push(`LOAD_DESCRIPTION must not hard-code "${phrase}" — it is a fact about one machine, not the plugin`)
}

console.log('tool params:')
for (const [toolName, tool] of tools) {
  console.log(' ', toolName, '->', Object.keys(tool.parameters).join(', '))
}
console.log('skill_load.name schema:', JSON.stringify(nameSpec))
console.log('render on empty result:', JSON.stringify(load.output.render({}, { loaded: '', skills: [], failed: '', note: '' })))
console.log(problems.length === 0 ? 'shape check: OK' : 'shape check FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
