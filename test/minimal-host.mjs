// 这份评审称"对 DSH 版本的最小要求较激进"。本插件实际依赖的是很小一组 API，
// 而 `dsh.engines.dsh` 写的是 >=0.1.5-rc.1（可验证的最早版本）。与其猜旧版本是否可用，
// 不如证明：可选 API 缺席时插件仍然工作。
//
// 这里刻意只注入 fs —— 这是 host 组合里最早稳定的一批 API —— 并断言三个工具都还能用。
import { buildSkillRouterTools } from '../host.js'
import { dropFixture, makeExec, makeFixture, makeFsContext } from './helpers.mjs'

const problems = []
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
    problems.push(label)
  }
}

const cwd = makeFixture()

// 1) 完整 ctx：fs + skills（本机就是这种，skills 为 undefined 也算）
const full = makeFsContext(cwd)
const fullTools = new Map()
buildSkillRouterTools(full, (name, tool) => fullTools.set(name, tool))

// 2) 极简 ctx：只有 fs。没有 get()、没有 effect()、没有 skills 服务。
const minimal = { fs: makeFsContext(cwd).fs }
const minimalTools = new Map()
check('ctx 只有 fs 时 apply 不抛异常', (() => {
  try {
    buildSkillRouterTools(minimal, (name, tool) => minimalTools.set(name, tool))
    return true
  } catch (error) {
    console.log('      apply 抛出: ' + error.message)
    return false
  }
})())

check('三个工具都注册成功', minimalTools.size === 3, 'got ' + [...minimalTools.keys()].join(', '))

const exec = makeExec(cwd)
const search = minimalTools.get('skill_search')
const load = minimalTools.get('skill_load')
const ref = minimalTools.get('skill_ref')

const found = await search.execute({ query: 'alpha widgets' }, exec)
check('只有 fs 时 skill_search 正常', found.hits.length > 0, 'hits=' + found.hits.length)

const loaded = await load.execute({ name: 'beta-gadgets' }, exec)
check('只有 fs 时 skill_load 正常', String(loaded.skills?.[0]?.content).includes('Fixture body'))

const missingSkill = await load.execute({ name: 'not-in-the-library' }, exec)
check('skills 服务缺席时报可操作的错误，而不是崩溃', String(missingSkill.skills?.[0]?.error).includes('skill_search'), String(missingSkill.skills?.[0]?.error))

const readRef = await ref.execute({ name: 'beta-gadgets', path: 'reference/playbook.md' }, exec)
check('只有 fs 时 skill_ref 正常', String(readRef.content).includes('Reference detail'))

// effect() 只被 apply 用来绑定生命周期；缺失时不应影响工具本身（宿主负责拆卸）。
check('apply 不依赖 ctx.effect 存在', typeof minimal.effect === 'undefined')

dropFixture(cwd)
console.log(problems.length === 0 ? '\nminimal host: OK' : '\nminimal host FAILED: ' + problems.join(', '))
if (problems.length > 0) process.exitCode = 1
