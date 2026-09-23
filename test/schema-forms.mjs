// Which output-schema form survives registration? Reproduces the JsonSchemaError that
// failed the host boot and shows why the shipped definitions use the literal form.
//
// Uses the real @deepseek-ai/dsh-tools when a DSH install is present, otherwise the dev
// stand-in, so the reasoning stays executable on CI and on a bare clone.
import { pathToFileURL } from 'node:url'
import { findRealDshTools } from './helpers.mjs'

const problems = []
const realPath = findRealDshTools()
const registry = realPath === undefined
  ? await import(new URL('./node_modules/@deepseek-ai/dsh-tools/index.js', import.meta.url).href)
  : await import(pathToFileURL(realPath).href)
console.log('registry under test:', realPath ?? 'dev stand-in')
console.log('  exports defineTool:', typeof registry.defineTool, '| assertSupportedJsonSchema:', typeof registry.assertSupportedJsonSchema)

const base = { name: 'probe', description: 'x', parameters: { q: { type: 'string', required: true } }, execute: async () => ({}) }

function compiled(schema) {
  const tool = registry.defineTool({ ...base, output: { schema, render: () => [] } })
  registry.assertSupportedJsonSchema(tool.output.schema)
  return tool.output.schema
}

function validate(label, schema) {
  try {
    registry.assertSupportedJsonSchema(schema)
    console.log(`  accepted  ${label}`)
    return true
  } catch (error) {
    console.log(`  rejected  ${label}  (${error.message})`)
    return false
  }
}

console.log('\nthrough defineTool (the compiler path):')
for (const [label, schema] of [
  ['{ type: "json" }  — the author DSL', { type: 'json' }],
  ['{ type: "object", additionalProperties: true }', { type: 'object', additionalProperties: true }],
]) {
  try {
    console.log(`  ok  ${label} -> compiled ${JSON.stringify(compiled(schema))}`)
  } catch (error) {
    console.log(`  FAIL ${label} -> ${error.message}`)
    problems.push('compiler rejected ' + label)
  }
}

console.log('\nstraight into the registry (what the shim caused):')
// The author DSL must be rejected here. If this ever passes, the boot-safety fence has
// stopped modelling the real failure and must be revisited.
if (validate('{ type: "json" }  — the author DSL', { type: 'json' })) {
  problems.push('the registry accepted the author DSL, so this fence no longer models the boot failure')
}
if (!validate('{ type: "object", additionalProperties: true }', { type: 'object', additionalProperties: true })) {
  problems.push('the registry rejected the literal form the plugin ships')
}
// The registry's assertion is laxer than its compiler: this one passes here but is still
// refused by defineTool above, which is why the plugin always states additionalProperties.
validate('{ type: "object" }  — allowed here, refused by defineTool', { type: 'object' })

console.log(problems.length === 0 ? '\nschema forms: OK' : '\nschema forms FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
