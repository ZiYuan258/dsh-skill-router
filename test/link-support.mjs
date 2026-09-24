// "The library can live elsewhere" is a documented claim, so it gets a test rather than a
// paragraph. The README's recipe is a directory link: a Windows junction (no elevated
// rights needed) or a POSIX symlink. If a runner refuses to create one, that is a fact
// about the runner and is reported as skipped, not as a pass.
//
// This exists as a test because tools/check-link-support.mjs is a manual tool: it was not
// in `npm test`, so the junction path — the one the docs lead with — had no coverage at
// all, on the platform whose behaviour it documents.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSkillRouterTools } from '../host.js'
import { makeExec, makeFsContext } from './helpers.mjs'

const problems = []
const root = mkdtempSync(join(tmpdir(), 'skill-router-link-'))
const realLibrary = join(root, 'real-library')
const skillDir = join(realLibrary, 'demo-repo', 'skills', 'demo-skill')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: A skill behind a link.\n---\n\nBody.\n', 'utf8')
writeFileSync(
  join(realLibrary, 'skill-index.tsv'),
  [
    '"repo"\t"relpath"\t"name"\t"description"\t"files"\t"KB"',
    '"demo-repo"\t"skills/demo-skill"\t"demo-skill"\t"A skill behind a link."\t"1"\t"1"',
  ].join('\r\n'),
  'utf8',
)

const linkPath = join(root, '.skill-src')
const linkKind = process.platform === 'win32' ? 'junction' : 'dir'
let created = false
try {
  // 'junction' on Windows needs no elevated rights; 'dir' is the POSIX equivalent.
  symlinkSync(realLibrary, linkPath, linkKind)
  created = true
} catch (error) {
  // Not a verdict either way: sandboxed or unprivileged runners can refuse links.
  console.log('  skip  could not create a ' + linkKind + ' here: ' + error.message)
}

if (created) {
  const check = (label, ok, detail) => {
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : ' — ' + detail))
    if (!ok) problems.push(label)
  }
  check('a link named .skill-src appears as a directory', existsSync(linkPath))

  const tools = new Map()
  buildSkillRouterTools(makeFsContext(root), (toolName, tool) => tools.set(toolName, tool))
  const exec = makeExec(root)

  const found = await tools.get('skill_search').execute({ query: 'demo skill' }, exec)
  check('skill_search resolves the index through the link', found.hits.length > 0, 'no hits; error = ' + String(found.error))
  check('a hit carries the path under the link', String(found.hits[0]?.path ?? '').includes('.skill-src'), String(found.hits[0]?.path))

  const loaded = await tools.get('skill_load').execute({ name: 'demo-skill' }, exec)
  const body = String(loaded.skills?.[0]?.content ?? '')
  check('skill_load reads the body through the link', body.includes('Body.'), 'content = ' + JSON.stringify(body.slice(0, 60)))
  check('the loaded skill reports source=library', loaded.skills?.[0]?.source === 'library', String(loaded.skills?.[0]?.source))
}

rmSync(root, { recursive: true, force: true })

console.log(problems.length === 0 ? 'link support: OK' : 'link support FAILED:\n  ' + problems.join('\n  '))
if (problems.length > 0) process.exitCode = 1
