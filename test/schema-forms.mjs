// Which output-schema form does the real registry accept? Reproduces the exact
// JsonSchemaError that failed the host boot, and proves the DSL form is the fix.
const real = await import('file:///D:/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
const base = { name: 'probe', description: 'x', parameters: { q: { type: 'string', required: true } }, execute: async () => ({}) }

function attempt(label, schema) {
  try {
    const tool = real.defineTool({ ...base, output: { schema, render: () => [] } })
    let verdict = 'assertSupportedJsonSchema: OK'
    try {
      real.assertSupportedJsonSchema(tool.output.schema)
    } catch (error) {
      verdict = 'assertSupportedJsonSchema 失败: ' + error.message
    }
    console.log('  ' + label + ' -> compiled=' + JSON.stringify(tool.output.schema) + ' | ' + verdict)
  } catch (error) {
    console.log('  ' + label + ' -> defineTool 抛出: ' + error.message)
  }
}

console.log('=== 真实 dsh-tools 下，output.schema 的三种写法 ===')
attempt('DSL  { type: "json" }                            ', { type: 'json' })
attempt('生 JSON Schema { type: "object", additionalProperties: true }', { type: 'object', additionalProperties: true })
attempt('生 JSON Schema { type: "object" } (缺 additionalProperties)', { type: 'object' })

console.log('')
console.log('=== 复现事故：把作者 DSL 原样交给注册表（shim 的行为）===')
for (const [label, schema] of [['type: "json"', { type: 'json' }], ['type: "object", additionalProperties: true', { type: 'object', additionalProperties: true }]]) {
  try {
    real.assertSupportedJsonSchema(schema)
    console.log('  ' + label + ' -> 注册表接受')
  } catch (error) {
    console.log('  ' + label + ' -> 注册表拒绝: ' + error.message)
  }
}
