// Boot-safety fence for the 2026-09-23 startup failure.
//
// What happened: the plugin package carried a dev-only node_modules shim whose
// defineTool was `(definition) => definition`. Node resolves a bare specifier from
// the importing package first, so the shim won, the author DSL reached the tool
// registry uncompiled, and the whole plugin tree refused to load:
//   unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
//
// Three invariants keep that from coming back, and this file enforces all of them:
//   1. the plugin package must not shadow any real dependency with a local node_modules;
//   2. it must not declare a DSH host package as a dependency at all — resolving those
//      from the DSH install is the point, and a pinned copy is how shadowing starts;
//   3. the definitions must be valid *without* help from defineTool — validated here
//      against the REAL @deepseek-ai/dsh-tools validators.
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildSkillRouterTools } from '../host.js'
import { findRealDshTools } from './helpers.mjs'

const problems = []
const REAL_DSH_TOOLS = findRealDshTools()

// --- invariant 1: no shadowing shim in the shipped package -------------------
const shim = new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url)
if (existsSync(shim)) {
  problems.push(
    'plugin package ships node_modules/@deepseek-ai/dsh-tools — a local shim at that path shadows the real package at runtime (keep dev-only shims under test/)',
  )
}

// --- invariant 2: declare no DSH host package as a dependency ----------------
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
  for (const name of Object.keys(manifest[field] ?? {})) {
    if (field === 'devDependencies') continue // dev-only tooling never reaches the host
    if (name.startsWith('@deepseek-ai/')) {
      problems.push(`package.json declares DSH host package "${name}" under ${field} — resolve it from the DSH install instead of pinning a copy`)
    }
  }
}
if (manifest.main !== './host.js') problems.push('package.json main must point at host.js')
if (manifest.dsh?.bundle?.patch === undefined) problems.push('package.json must declare dsh.bundle.patch — without it the plugin is never composed')
if (manifest.private === true) problems.push('package.json is private:true, so it cannot be published or installed from a registry')

// --- invariant 2: schemas stand on their own ---------------------------------
const tools = new Map()
// No defineTool at all: the harshest case, exactly what the shim used to simulate.
buildSkillRouterTools({ fs: {}, get: () => undefined, effect: () => () => {} }, (toolName, tool) => tools.set(toolName, tool))

const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function scan(node, path, toolName) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((entry, index) => scan(entry, `${path}[${index}]`, toolName))
    return
  }
  if (Object.hasOwn(node, 'type')) {
    const type = node.type
    if (Array.isArray(type)) problems.push(`${toolName}.${path}.type is an array — unsupported by assertSupportedJsonSchema`)
    else if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
      problems.push(`${toolName}.${path}.type = ${JSON.stringify(type)} is not a JSON Schema type`)
    }
  }
  for (const [key, value] of Object.entries(node)) scan(value, `${path}.${key}`, toolName)
}

for (const [toolName, tool] of tools) {
  if (tool.parameters?.type !== 'object') problems.push(`${toolName}.parameters.type must be 'object'`)
  if (tool.parameters?.additionalProperties !== false) problems.push(`${toolName}.parameters.additionalProperties must be explicitly false`)
  if (!Array.isArray(tool.parameters?.required)) problems.push(`${toolName}.parameters.required must be an array (possibly empty when every parameter is optional)`)
  if (tool.output?.schema === undefined) problems.push(`${toolName} declares no output.schema`)
  scan(tool.parameters, 'parameters', toolName)
  scan(tool.output.schema, 'output.schema', toolName)
}

// --- invariant 3b: the registry's own validator agrees -----------------------
// Prefer the real DSH package; fall back to the dev stand-in in test/node_modules. Neither
// is required — on a machine with no DSH install and no checked-out stand-in, the local
// assertions above are the whole fence and this section says so.
const SHIM = new URL('./node_modules/@deepseek-ai/dsh-tools/index.js', import.meta.url)
let validator
let validatorNote
if (REAL_DSH_TOOLS !== undefined) {
  validator = await import(pathToFileURL(REAL_DSH_TOOLS).href)
  validatorNote = 'validated with the real @deepseek-ai/dsh-tools at ' + REAL_DSH_TOOLS
} else {
  try {
    validator = await import(SHIM.href)
    validatorNote = 'validated with the dev stand-in (no DSH install found on this machine)'
  } catch {
    validator = undefined
    validatorNote = 'no validator available on this machine — local assertions only'
  }
}

if (validator !== undefined) {
  if (typeof validator.assertSupportedJsonSchema !== 'function') {
    problems.push('the resolved validator exports no assertSupportedJsonSchema: ' + (REAL_DSH_TOOLS ?? SHIM.href))
  } else {
    for (const [toolName, tool] of tools) {
      for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
        try {
          validator.assertSupportedJsonSchema(schema)
        } catch (error) {
          problems.push(`${toolName}.${label} rejected by the registry validator: ${error.message}`)
        }
      }
    }
    // Prove the fence still models the real failure: the author DSL must be rejected.
    try {
      validator.assertSupportedJsonSchema({ type: 'json' })
      problems.push('the validator accepted the author DSL { type: "json" } — this fence no longer models the boot failure')
    } catch {
      validatorNote += '; it rejects the author DSL { type: "json" }, so the fence models the boot failure'
    }
  }
}

console.log('manifest:', manifest.name, 'dependencies =', JSON.stringify(manifest.dependencies ?? {}))
console.log('registered tools:', [...tools.keys()].join(', '))
for (const [toolName, tool] of tools) {
  console.log(`  ${toolName}.parameters = ${JSON.stringify(tool.parameters)}`)
  console.log(`  ${toolName}.output.schema = ${JSON.stringify(tool.output.schema)}`)
}
console.log('validator check:', validatorNote)
console.log(problems.length === 0 ? 'boot-safety fence: OK' : 'boot-safety fence FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
