// Which output-schema form survives registration? This pins the reasoning behind the
// shipped definitions, and the failure mode that took the host down once.
//
// Runs against the real @deepseek-ai/dsh-tools when a DSH install is present, otherwise
// against the dev stand-in, which is deliberately stricter in one place (it rejects the
// author DSL that the real compiler happens to accept). That divergence is asserted, not
// assumed, so this script passes in both environments for the right reason.
import { pathToFileURL } from 'node:url'
import { findRealDshTools } from './helpers.mjs'

const problems = []
const realPath = findRealDshTools()
const usingReal = realPath !== undefined
const registry = usingReal
  ? await import(pathToFileURL(realPath).href)
  : await import(new URL('./node_modules/@deepseek-ai/dsh-tools/index.js', import.meta.url).href)

console.log('registry under test:', realPath ?? 'dev stand-in (no DSH install reachable)')
console.log('  defineTool:', typeof registry.defineTool, '| assertSupportedJsonSchema:', typeof registry.assertSupportedJsonSchema)

// The author DSL, shaped the way the real defineTool contract expects: a property map.
const base = { name: 'probe', description: 'x', parameters: { q: { type: 'string', required: true } }, execute: async () => ({}) }
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}
const define = (schema) => registry.defineTool({ ...base, output: { schema, render: () => [] } })
const SHIPPED = { type: 'object', additionalProperties: true }

// --- what the plugin ships must always be accepted ---------------------------
const shipped = attempt(() => define(SHIPPED))
if (!shipped.ok) problems.push('defineTool rejected the form the plugin ships: ' + shipped.message)
else console.log('\nshipped form accepted; compiled to', JSON.stringify(shipped.value.output.schema))

const assertShipped = attempt(() => registry.assertSupportedJsonSchema(SHIPPED))
if (!assertShipped.ok) problems.push('the registry assertion rejected the form the plugin ships: ' + assertShipped.message)

// A JSON-object schema that omits additionalProperties is an authoring error on the
// compiler path in both environments — that is why the plugin always states it.
const missing = attempt(() => define({ type: 'object' }))
if (missing.ok) problems.push('defineTool accepted an object schema without additionalProperties')

// --- the failure mode: the author DSL reaching the registry uncompiled -------
const dslIntoRegistry = attempt(() => registry.assertSupportedJsonSchema({ type: 'json' }))
if (dslIntoRegistry.ok) {
  problems.push('the registry accepted the author DSL { type: "json" }, so this fence no longer models the boot failure')
} else {
  console.log('author DSL rejected by the registry assertion:', dslIntoRegistry.message)
}

// --- the one deliberate divergence, asserted per environment -----------------
const dslThroughCompiler = attempt(() => define({ type: 'json' }))
if (usingReal) {
  if (!dslThroughCompiler.ok) problems.push('the real compiler rejected the author DSL, which contradicts the observed behaviour')
  else console.log('real compiler accepts the author DSL and compiles it to', JSON.stringify(dslThroughCompiler.value.output.schema))
} else {
  if (dslThroughCompiler.ok) {
    problems.push('the dev stand-in accepted the author DSL — it is meant to be stricter than the real compiler, and that rejection is the fence')
  } else {
    console.log('dev stand-in rejects the author DSL by design:', dslThroughCompiler.message)
  }
}

console.log(problems.length === 0 ? '\nschema forms: OK' : '\nschema forms FAILED: ' + problems.join(' | '))
if (problems.length > 0) process.exitCode = 1
