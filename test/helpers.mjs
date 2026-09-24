// Locate the things the tests need, without hard-coding a machine layout.
//
// Two shapes are supported:
//   1. a developer machine — a real staged skill library (…/.skill-src/skill-index.tsv)
//      and the real @deepseek-ai/dsh-tools inside a DSH installation;
//   2. a fresh clone — no library and no DSH install, in which case `makeFixture()`
//      builds a tiny library in a temp directory so every test still runs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Walk up from `start` looking for a directory that contains `marker`. */
export function findUp(start, marker) {
  let dir = resolve(start)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, marker)
    if (existsSync(candidate)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * The staged skill library to test against, or undefined when this machine has none.
 * Checked in order: an explicit SKILL_LIBRARY_ROOT, the current working directory, then
 * any ancestor of this file.
 */
export function findLibrary() {
  const explicit = process.env.SKILL_LIBRARY_ROOT
  if (explicit !== undefined && existsSync(join(explicit, '.skill-src', 'skill-index.tsv'))) return resolve(explicit)
  if (existsSync(join(process.cwd(), '.skill-src', 'skill-index.tsv'))) return resolve(process.cwd())
  return findUp(here, join('.skill-src', 'skill-index.tsv'))
}

/**
 * The real @deepseek-ai/dsh-tools from a DSH installation, as an importable entry file,
 * or undefined when this machine has none. The dev stand-in under test/node_modules is a
 * bare specifier away, so this deliberately resolves the *installation* path instead of
 * searching node_modules by name.
 */
export function findRealDshTools() {
  const relative = '@deepseek-ai/dsh-tools'
  const roots = []
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (process.env.DSH_HOME !== undefined) roots.push(process.env.DSH_HOME)
  if (home !== undefined) {
    // The DSH home itself, plus the shared profiles tree it keeps its packages in, plus a
    // packaged Desktop install. The install location is per-platform: an earlier version
    // listed only the Windows one, so on Linux and macOS this jumped straight to the local
    // assertions and quietly validated less than it could have.
    roots.push(join(home, '.dsh'))
    roots.push(join(home, '.dsh', 'profiles'))
    roots.push(join(home, 'AppData', 'Roaming', 'DSH Desktop', 'resources', 'app')) // Windows
    roots.push(join(home, 'Library', 'Application Support', 'DSH Desktop', 'resources', 'app')) // macOS
    roots.push(join(home, '.local', 'share', 'DSH Desktop', 'resources', 'app')) // Linux
    roots.push(join(home, 'Applications', 'DSH Desktop.app', 'Contents', 'Resources', 'app')) // macOS .app
  }
  roots.push(findUp(here, 'resources'))
  const candidates = []
  for (const root of roots.filter(Boolean)) {
    // The root may itself be a package folder (…/profiles) or an install folder
    // (…/resources/app); cover both readings.
    candidates.push(join(root, 'node_modules', relative))
    candidates.push(join(root, 'resources', 'app', 'node_modules', relative))
  }
  for (const dir of candidates) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const entry = typeof manifest.main === 'string' ? manifest.main : 'index.js'
      const resolved = join(dir, entry)
      if (existsSync(resolved)) return resolved
    } catch {
      /* unreadable manifest: try the next candidate */
    }
  }
  return undefined
}

/**
 * Build a throwaway skill library so the suite is runnable from a bare clone.
 * Layout mirrors the real one: <root>/.skill-src/<repo>/<relpath>/SKILL.md.
 * @returns a workspace root to hand to the tools as `cwd`.
 */
export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-router-fixture-'))
  const skills = [
    { repo: 'alpha-skills', relpath: 'skills/alpha-widgets', name: 'alpha-widgets', description: 'Builds alpha widgets. Use when the task mentions alpha widgets.' },
    { repo: 'alpha-skills', relpath: 'plugins/deep/skills/alpha-widgets', name: 'alpha-widgets', description: 'Builds alpha widgets from the plugin layout.' },
    { repo: 'beta-skills', relpath: 'skills/beta-gadgets', name: 'beta-gadgets', description: 'Builds beta gadgets. Use when the task mentions beta gadgets.' },
    // Carries the optional whenToUse frontmatter field and the optional 7th index column,
    // so tests can prove trigger phrasing is parsed, scored and surfaced.
    { repo: 'gamma-skills', relpath: 'skills/gamma-triggers', name: 'gamma-triggers', description: 'Prose that never names the task.', whenToUse: 'ship the frobnicator' },
    // A copy of an existing name that lives in a THIRD repo. Depth 2, so it does not
    // displace the shallowest-copy winner; its purpose is the cross-repo case, where the
    // search note has to list the repos to choose between. Copies within one repo are
    // interchangeable, copies across repos change which skill you get.
    { repo: 'zeta-skills', relpath: 'skills/alpha-widgets', name: 'alpha-widgets', description: 'Builds alpha widgets, from a different upstream entirely.' },
  ]
  const indexDir = join(root, '.skill-src')
  mkdirSync(indexDir, { recursive: true })
  const rows = ['"repo"\t"relpath"\t"name"\t"description"\t"files"\t"KB"\t"whenToUse"']
  for (const skill of skills) {
    const dir = join(indexDir, skill.repo, skill.relpath)
    mkdirSync(dir, { recursive: true })
    const when = skill.whenToUse === undefined ? '' : `whenToUse: ${skill.whenToUse}\n`
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n${when}---\n\n# ${skill.name}\n\nFixture body for ${skill.name}.\n`, 'utf8')
    rows.push([skill.repo, skill.relpath, skill.name, skill.description, '1', '1', skill.whenToUse ?? ''].map((cell) => `"${cell}"`).join('\t'))
  }
  // A bundled reference tree, so skill_ref has something real to read: a nested file, a
  // binary file, and a path that climbs out of the skill directory.
  const referenceDir = join(indexDir, 'beta-skills', 'skills', 'beta-gadgets', 'reference')
  mkdirSync(referenceDir, { recursive: true })
  writeFileSync(join(referenceDir, 'playbook.md'), '# Playbook\n\nReference detail for beta gadgets.\n', 'utf8')
  writeFileSync(join(referenceDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'utf8')
  writeFileSync(join(indexDir, 'outside.txt'), 'not part of any skill\n', 'utf8')
  writeFileSync(join(indexDir, 'skill-index.tsv'), rows.join('\r\n'), 'utf8')
  return root
}

/** Remove a fixture created by makeFixture(). */
export function dropFixture(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * A `ctx` shaped like the DSH fs service, backed by the real Node filesystem.
 * @param cwd - workspace root the tools should treat as the session directory.
 */
export function makeFsContext(cwd) {
  return {
    fs: {
      async resolve(path) {
        const abs = resolve(String(path))
        await import('node:fs/promises').then((fs) => fs.access(abs))
        return { targetKey: abs, displayPath: abs }
      },
      async stat(target) {
        const fs = await import('node:fs/promises')
        const info = await fs.stat(target.targetKey).catch(() => undefined)
        if (info === undefined) return undefined
        return { version: String(info.mtimeMs), type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      },
      async readText(target) {
        const fs = await import('node:fs/promises')
        return await fs.readFile(target.targetKey, 'utf8')
      },
      async listDir(target) {
        const fs = await import('node:fs/promises')
        const entries = await fs.readdir(target.targetKey, { withFileTypes: true })
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          target: { targetKey: join(target.targetKey, entry.name), displayPath: join(target.targetKey, entry.name) },
        }))
      },
    },
    get: () => undefined,
    effect: () => () => {},
  }
}

/** An exec record as the tool runtime supplies it. */
export function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

/** Every SKILL.md under a fixture/library root, for cross-checking the index. */
export function listSkillFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name === 'SKILL.md') out.push(child)
    }
  }
  walk(root)
  return out
}
