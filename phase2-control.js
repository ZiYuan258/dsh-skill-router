const PHASE2_ARMS = new Set(['A', 'B', 'C', 'D']);
const MAX_MANUAL_SKILLS = 3;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
// A library repo directory name. Deliberately stricter than the skill-name rule so a repo value can
// never smuggle a path separator, a drive letter, or `..` into the resolution step.
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse the per-run experiment assignment. Missing/empty means legacy behavior; invalid never falls back. */
export function parsePhase2Arm(value = process.env.DSH_PHASE2_ARM) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { mode: 'legacy', valid: true };
  const mode = raw.toUpperCase();
  if (PHASE2_ARMS.has(mode)) return { mode, valid: true };
  return { mode: 'invalid', valid: false };
}

/**
 * Normalise one manual-injection entry into `{ name, repo }`.
 *
 * Accepts both shapes, because the manifest historically carried bare names and now carries a repo
 * as well:
 *   - "semgrep"                                  -> { name: 'semgrep', repo: '' }
 *   - { name: 'systematic-debugging', repo: 'X' } -> { name: 'systematic-debugging', repo: 'X' }
 *
 * The repo matters for correctness, not bookkeeping: several expected skills exist in FIVE library
 * copies with substantively different bodies (systematic-debugging, writing-plans), and loadSkill
 * without a repo filter picks the shallowest relpath — a DIFFERENT copy than the sample declares.
 * An empty repo means "no constraint", which is what the legacy bare-name form has always meant.
 */
function parseManualEntry(item) {
  if (typeof item === 'string') {
    const name = item.trim();
    if (name === '') return { skip: true };
    return { name, repo: '' };
  }
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const name = String(item.name ?? '').trim();
    if (name === '') return { skip: true };
    return { name, repo: String(item.repo ?? '').trim() };
  }
  return { invalid: true };
}

/**
 * The runner serializes this value as a JSON array. Do not split arbitrary malformed JSON or
 * silently truncate over-limit lists: D is an oracle arm and ambiguous instructions invalidate it.
 *
 * Returns `names` (kept for backward compatibility with existing callers and telemetry) plus
 * `skills`, the same list carrying the optional repo constraint.
 */
export function parseManualSkillNames(value, max = MAX_MANUAL_SKILLS) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { valid: false, names: [], skills: [], reason: 'missing-manual-list' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, names: [], skills: [], reason: 'invalid-manual-list' };
  }
  if (!Array.isArray(parsed)) {
    return { valid: false, names: [], skills: [], reason: 'invalid-manual-list' };
  }
  const names = [];
  const skills = [];
  const seen = new Set();
  for (const item of parsed) {
    const entry = parseManualEntry(item);
    if (entry.invalid) return { valid: false, names: [], skills: [], reason: 'invalid-manual-list' };
    if (entry.skip) continue;
    if (!SAFE_SKILL_NAME.test(entry.name)) return { valid: false, names: [], skills: [], reason: 'unsafe-name' };
    if (entry.repo !== '' && !SAFE_REPO.test(entry.repo)) {
      return { valid: false, names: [], skills: [], reason: 'unsafe-repo' };
    }
    const key = entry.name + '\u0000' + entry.repo;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(entry.name);
    skills.push({ name: entry.name, repo: entry.repo });
  }
  if (names.length > max) return { valid: false, names: [], skills: [], reason: 'too-many-manual-skills' };
  return { valid: true, names, skills, reason: '' };
}

/** Render the same skill_content envelope used by skill_load; never log this value to telemetry. */
export function formatSkillContentText(skill) {
  if (skill === null || typeof skill !== 'object') throw new TypeError('skill must be an object');
  const name = String(skill.name ?? '');
  if (!SAFE_SKILL_NAME.test(name)) throw new TypeError('unsafe skill name');
  if (skill.source !== 'library') throw new TypeError('only library skills may be injected');
  if (typeof skill.content !== 'string' || skill.content.trim() === '') throw new TypeError('skill body is empty');
  if (skill.truncated === true) throw new TypeError('truncated skill bodies are not eligible for this pilot');
  const resourceDir = String(skill.resourceDir ?? '').replace(/[\r\n]+/g, ' ');
  const refs = Array.isArray(skill.referenceFiles) ? skill.referenceFiles.slice(0, 8).map((value) => String(value).replace(/[\r\n]+/g, ' ').slice(0, 128)) : [];
  const bundled = refs.length === 0 ? '' : ' Bundled: ' + refs.join(', ') + '.';
  return [
    '<skill_content name="' + name + '" source="library">',
    'Base directory for this skill: ' + resourceDir + '.' + bundled,
    'Resolve relative paths (scripts/, references/, assets/) against that base directory before using them.',
    '',
    skill.content,
    '</skill_content>',
  ].join('\n');
}
