// 使用文档要回答"库不在工作区里怎么办"。最简单可行的答案是"在工作区里放一个链接指过去"，
// 但这依赖 fs 服务是否跟随链接——所以先实测，再写进文档。
//
//   node tools/check-link-support.mjs
//
// 做法：在一个临时工作区里建 real-library/ 与一个指向它的 .skill-src 链接，
// 然后用插件真正走一遍搜索与加载。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSkillRouterTools } from '../host.js'
import { makeExec, makeFsContext } from '../test/helpers.mjs'

const root = mkdtempSync(join(tmpdir(), 'skill-router-link-'))
const realLibrary = join(root, 'real-library')
const skillDir = join(realLibrary, 'demo-repo', 'skills', 'demo-skill')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: A skill behind a link.\n---\n\nBody.\n', 'utf8')
writeFileSync(
  join(realLibrary, 'skill-index.tsv'),
  ['"repo"\t"relpath"\t"name"\t"description"\t"files"\t"KB"', '"demo-repo"\t"skills/demo-skill"\t"demo-skill"\t"A skill behind a link."\t"1"\t"1"'].join('\r\n'),
  'utf8',
)

const linkPath = join(root, '.skill-src')
let linkKind = 'none'
try {
  // 'junction' on Windows needs no elevated rights; 'dir' is the POSIX equivalent.
  symlinkSync(realLibrary, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  linkKind = process.platform === 'win32' ? 'junction' : 'symlink'
} catch (error) {
  console.log('could not create the link: ' + error.message)
}

console.log('workspace:    ' + root)
console.log('real library: ' + realLibrary)
console.log('link:         ' + linkPath + '  (' + linkKind + ')')
console.log('link exists:  ' + existsSync(linkPath))

if (linkKind !== 'none') {
  const tools = new Map()
  buildSkillRouterTools(makeFsContext(root), (name, tool) => tools.set(name, tool))
  const exec = makeExec(root)

  const found = await tools.get('skill_search').execute({ query: 'demo skill' }, exec)
  console.log('\nskill_search through the link: ' + found.hits.length + ' hit(s)')
  if (found.hits[0]) console.log('  ' + found.hits[0].name + '  ' + found.hits[0].path)

  const loaded = await tools.get('skill_load').execute({ name: 'demo-skill' }, exec)
  const body = String(loaded.skills?.[0]?.content ?? '')
  console.log('skill_load through the link: ' + (body.includes('Body.') ? 'OK' : 'FAILED') + '  (' + body.length + ' chars)')

  console.log('\n结论: ' + (found.hits.length > 0 && body.includes('Body.') ? '链接可用——文档可以把它作为“库在别处”的方案' : '链接不可用——文档不能推荐这个方案'))
}

rmSync(root, { recursive: true, force: true })
