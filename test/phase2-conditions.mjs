import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSkillContentText, parseManualSkillNames, parsePhase2Arm } from '../phase2-control.js';

const problems = [];
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (error) { problems.push(label); console.error('  FAIL ' + label + ' — ' + error.message); }
}
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); }

console.log('Phase-2 pure control helpers:');
check('missing arm preserves legacy mode', () => equal(parsePhase2Arm(undefined), { mode: 'legacy', valid: true }));
check('all four arms are explicit and case-insensitive', () => {
  for (const arm of ['A', 'B', 'C', 'D']) equal(parsePhase2Arm(arm.toLowerCase()), { mode: arm, valid: true });
});
check('invalid arm never falls back to randomized legacy mode', () => equal(parsePhase2Arm('phase2-C'), { mode: 'invalid', valid: false }));
check('manual list parses runner JSON format', () => equal(parseManualSkillNames('["semgrep","pytest-skill"]'), { valid: true, names: ['semgrep', 'pytest-skill'], skills: [{ name: 'semgrep', repo: '' }, { name: 'pytest-skill', repo: '' }], reason: '' }));
check('manual list permits the negative-control empty array', () => equal(parseManualSkillNames('[]'), { valid: true, names: [], skills: [], reason: '' }));
check('manual list deduplicates without reordering', () => equal(parseManualSkillNames('["semgrep","semgrep"]'), { valid: true, names: ['semgrep'], skills: [{ name: 'semgrep', repo: '' }], reason: '' }));
check('malformed manual JSON fails closed', () => equal(parseManualSkillNames('semgrep'), { valid: false, names: [], skills: [], reason: 'invalid-manual-list' }));
check('non-string manual entries fail closed', () => equal(parseManualSkillNames('["semgrep",4]'), { valid: false, names: [], skills: [], reason: 'invalid-manual-list' }));
check('unsafe skill names fail closed', () => equal(parseManualSkillNames('["../semgrep"]'), { valid: false, names: [], skills: [], reason: 'unsafe-name' }));
check('over-limit manual list fails instead of silently truncating', () => equal(parseManualSkillNames('["a","b","c","d"]'), { valid: false, names: [], skills: [], reason: 'too-many-manual-skills' }));
// A repo is a PRECISE identity constraint for the oracle arm, so it gets its own validation: a
// repo value must never be able to smuggle a path separator or a traversal into resolution.
check('manual list accepts {name, repo} object entries', () => equal(parseManualSkillNames('[{"name":"systematic-debugging","repo":"GanyuanRan-Aegis"}]'), { valid: true, names: ['systematic-debugging'], skills: [{ name: 'systematic-debugging', repo: 'GanyuanRan-Aegis' }], reason: '' }));
check('manual list accepts a mix of bare names and {name, repo} entries', () => equal(parseManualSkillNames('["semgrep",{"name":"writing-plans","repo":"superpowers"}]'), { valid: true, names: ['semgrep', 'writing-plans'], skills: [{ name: 'semgrep', repo: '' }, { name: 'writing-plans', repo: 'superpowers' }], reason: '' }));
check('a repo value that could escape the library fails closed', () => {
  for (const repo of ['../etc', 'a\\b', 'C:\\x', 'a/b', '.', '..']) {
    equal(parseManualSkillNames(JSON.stringify([{ name: 'semgrep', repo }])), { valid: false, names: [], skills: [], reason: 'unsafe-repo' }, 'repo=' + repo);
  }
});
check('an empty repo on an object entry means "no constraint", not an error', () => equal(parseManualSkillNames('[{"name":"semgrep","repo":""}]'), { valid: true, names: ['semgrep'], skills: [{ name: 'semgrep', repo: '' }], reason: '' }));
check('the same name under two different repos is preserved, not deduplicated away', () => {
  const parsed = parseManualSkillNames('[{"name":"x","repo":"repoA"},{"name":"x","repo":"repoB"}]');
  equal(parsed.valid, true);
  equal(parsed.skills, [{ name: 'x', repo: 'repoA' }, { name: 'x', repo: 'repoB' }]);
});
check('content formatter preserves body in library-only envelope', () => {
  const value = formatSkillContentText({ name: 'semgrep', source: 'library', resourceDir: 'X:/skills/semgrep', content: 'BODY_SENTINEL', referenceFiles: ['scripts/'] });
  assert.match(value, /<skill_content name="semgrep" source="library">/);
  assert.match(value, /BODY_SENTINEL/);
  assert.match(value, /Base directory for this skill: X:\/skills\/semgrep/);
});
check('content formatter refuses non-library, unsafe, empty and truncated bodies', () => {
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'resident', content: 'x' }));
  assert.throws(() => formatSkillContentText({ name: '../x', source: 'library', content: 'x' }));
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'library', content: '' }));
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'library', content: 'x', truncated: true }));
});

console.log('\nPhase-2 host integration:');
const workspace = mkdtempSync(join(tmpdir(), 'phase2-router-'));
const libraryRoot = join(workspace, '.skill-src');
const skillDir = join(libraryRoot, 'trailofbits', 'skills', 'semgrep');
mkdirSync(skillDir, { recursive: true });
mkdirSync(join(libraryRoot, 'superpowers', 'skills', 'vbc'), { recursive: true });
// A deliberately DUPLICATED skill name across two repos with DIFFERENT bodies. This is not a
// hypothetical: systematic-debugging and writing-plans each have five real copies in .skill-src,
// and loadSkill without a repo filter picks the shallowest relpath - a different body than declared.
// Arm D must be pinned by repo exactly, and must fail closed rather than inject the other copy.
mkdirSync(join(libraryRoot, 'repoA', 'skills', 'dup-skill'), { recursive: true });
mkdirSync(join(libraryRoot, 'repoB', 'deeper', 'skills', 'dup-skill'), { recursive: true });
writeFileSync(join(libraryRoot, 'skill-index.tsv'), [
  'repo\trelpath\tname\tdescription\tfiles\tKB\twhenToUse',
  'trailofbits\tskills/semgrep\tsemgrep\tStatic analysis security audit for source code repo\t1\t2\tsecurity audit, vulnerability scan, SAST',
  'superpowers\tskills/vbc\tverification-before-completion\tEvidence before claims\t1\t2\tbefore claiming work is complete',
  'repoA\tskills/dup-skill\tdup-skill\tDuplicated skill body from repo A\t1\t2\tduplicate helper',
  'repoB\tdeeper/skills/dup-skill\tdup-skill\tDuplicated skill body from repo B\t1\t2\tduplicate helper',
].join('\n') + '\n', 'utf8');
writeFileSync(join(skillDir, 'SKILL.md'), '# Semgrep instructions\nBODY_SENTINEL: run semgrep --config auto and inspect findings.\n', 'utf8');
writeFileSync(join(libraryRoot, 'superpowers', 'skills', 'vbc', 'SKILL.md'), '# Verify\nVerify claims with evidence.\n', 'utf8');
writeFileSync(join(libraryRoot, 'repoA', 'skills', 'dup-skill', 'SKILL.md'), '# Dup\nREPO_A_BODY_SENTINEL\n', 'utf8');
writeFileSync(join(libraryRoot, 'repoB', 'deeper', 'skills', 'dup-skill', 'SKILL.md'), '# Dup\nREPO_B_BODY_SENTINEL\n', 'utf8');
const logPath = join(workspace, 'discovery.jsonl');
process.env.DSH_SKILL_ROUTER_DISCOVERY_LOG = logPath;
// 注入层默认关停（v1.16.2）；这里显式打开，以测 phase2 B/C 臂的注入接线。
process.env.DSH_SKILL_ROUTER_INJECT_TIERS = 'HIGH'
const { apply } = await import('../host.js');
const handlers = new Map();
const registered = [];
const ctx = {
  fs: {
    async resolve(path) { const targetKey = String(path); return { targetKey, displayPath: targetKey }; },
    async stat(target) {
      try { const s = statSync(target.targetKey); return { version: String(s.mtimeMs), type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size }; }
      catch { return undefined; }
    },
    async readText(target) { return readFileSync(target.targetKey, 'utf8'); },
    async listDir(target) { return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })); },
  },
  tools: { register: (tool) => registered.push(tool) },
  get: () => undefined,
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  on(event, handler) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(handler); return () => {}; },
  logger: { warn() {}, info() {} },
  _handlers: handlers,
};
apply(ctx);
async function preStep(agentId, arm, manual, task = 'semgrep security audit') {
  if (arm === undefined) delete process.env.DSH_PHASE2_ARM; else process.env.DSH_PHASE2_ARM = arm;
  if (manual === undefined) delete process.env.DSH_PHASE2_MANUAL_INJECT_SKILLS; else process.env.DSH_PHASE2_MANUAL_INJECT_SKILLS = manual;
  // Deliberately conflicts with the task's relevant skill: C must route from task/index, not this label.
  process.env.DSH_PHASE2_EXPECTED_SKILLS = '["verification-before-completion"]';
  const agent = { session: { id: agentId, header: { cwd: workspace, createdAt: '2026-10-10T00:00:00.000Z' } } };
  const base = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: task }] }] };
  const payload = { agent, messages: base.messages, turn: 1, step: 1, signal: undefined };
  let result = base;
  for (const handler of handlers.get('agent/pre-step') ?? []) result = await handler(payload, async () => base);
  const key = createHash('sha256').update(agentId).digest('hex').slice(0, 8);
  const records = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const record = records.find((row) => row.sessionKey === key && row.kind === undefined);
  assert.ok(record, 'discovery record for ' + agentId);
  return { base, result, record };
}
try {
  const A = await preStep('phase2-A', 'A', '[]');
  check('A is an actual no-injection baseline', () => {
    assert.equal(A.result, A.base);
    assert.equal(A.record.phase2Mode, 'A');
    assert.equal(A.record.injectionStatus, 'baseline-no-injection');
    assert.equal(A.record.messageAppended, false);
  });
  const B = await preStep('phase2-B', 'B', '[]');
  check('B injects candidate hint only, never a body', () => {
    assert.equal(B.result.messages.length, B.base.messages.length + 1);
    const text = B.result.messages.at(-1).content[0].text;
    assert.match(text, /Maybe relevant skills/);
    assert.doesNotMatch(text, /<skill_content\b/);
    assert.equal(B.record.phase2Mode, 'B');
    assert.equal(B.record.payloadType, 'candidate-hint');
    assert.equal(B.record.injectionStatus, 'hint-injected');
  });
  const C = await preStep('phase2-C', 'C', '[]');
  check('C automatically chooses and injects the ranked library body', () => {
    assert.equal(C.result.messages.length, C.base.messages.length + 1);
    const text = C.result.messages.at(-1).content[0].text;
    assert.match(text, /<skill_content name="semgrep" source="library">/);
    assert.match(text, /BODY_SENTINEL/);
    assert.equal(C.record.phase2Mode, 'C');
    assert.equal(C.record.selectedSkills[0].name, 'semgrep');
    assert.equal(C.record.selectedSkills[0].repo, 'trailofbits');
    assert.equal(C.record.injectedSkills[0].source, 'library');
    assert.equal(C.record.injectedSkills[0].repo, 'trailofbits');
    assert.equal(C.record.payloadType, 'skill-body');
  });
  const D = await preStep('phase2-D', 'D', '["semgrep"]');
  check('D injects the manually selected library body irrespective of discovery label', () => {
    assert.equal(D.result.messages.length, D.base.messages.length + 1);
    assert.match(D.result.messages.at(-1).content[0].text, /BODY_SENTINEL/);
    assert.equal(D.record.phase2Mode, 'D');
    assert.equal(D.record.injectedSkills[0].name, 'semgrep');
  });
  const Dnegative = await preStep('phase2-D-negative', 'D', '[]', 'Translate Hello world to Chinese');
  check('D negative control explicitly injects nothing', () => {
    assert.equal(Dnegative.result, Dnegative.base);
    assert.equal(Dnegative.record.injectionStatus, 'manual-empty');
    assert.equal(Dnegative.record.messageAppended, false);
  });
  const invalid = await preStep('phase2-invalid', 'wat', '["semgrep"]');
  check('invalid arm fails closed rather than randomizing', () => {
    assert.equal(invalid.result, invalid.base);
    assert.equal(invalid.record.phase2Mode, 'invalid');
    assert.equal(invalid.record.injectionStatus, 'invalid-arm');
  });
  const invalidD = await preStep('phase2-invalid-D', 'D', 'semgrep');
  check('invalid manual list fails closed', () => {
    assert.equal(invalidD.result, invalidD.base);
    assert.equal(invalidD.record.injectionStatus, 'invalid-manual-list');
  });
  const missingD = await preStep('phase2-missing-D', 'D', undefined);
  check('missing positive D list is distinguishable from explicit negative-control []', () => {
    assert.equal(missingD.result, missingD.base);
    assert.equal(missingD.record.injectionStatus, 'missing-manual-list');
  });
  // ---- arm D repo identity ----------------------------------------------------------------
  // The winner by loadSkill's ordering is repoA (shallower relpath: skills/dup-skill outranks
  // deeper/skills/dup-skill), so an UNPINNED request resolves repoA's body.
  const dupUnpinned = await preStep('phase2-dup-unpinned', 'D', '["dup-skill"]');
  check('an unpinned duplicate name resolves the shallowest copy (the ambiguity under test)', () => {
    const text = dupUnpinned.result.messages.at(-1).content[0].text;
    assert.match(text, /REPO_A_BODY_SENTINEL/, 'winner should be repoA by shallowest relpath');
    assert.equal(dupUnpinned.record.injectedSkills[0].repo, 'repoA');
  });
  const dupPinnedA = await preStep('phase2-dup-pinned-a', 'D', '[{"name":"dup-skill","repo":"repoA"}]');
  check('a repo-pinned duplicate injects the DECLARED copy', () => {
    assert.match(dupPinnedA.result.messages.at(-1).content[0].text, /REPO_A_BODY_SENTINEL/);
    assert.equal(dupPinnedA.record.injectedSkills[0].repo, 'repoA');
    assert.deepEqual(dupPinnedA.record.requestedSkillRepos, [{ name: 'dup-skill', repo: 'repoA' }]);
  });
  const dupPinnedB = await preStep('phase2-dup-pinned-b', 'D', '[{"name":"dup-skill","repo":"repoB"}]');
  check('pinning the DEEPER copy by repo injects that exact body, not the shallow winner', () => {
    assert.match(dupPinnedB.result.messages.at(-1).content[0].text, /REPO_B_BODY_SENTINEL/);
    assert.equal(dupPinnedB.record.injectedSkills[0].repo, 'repoB');
    assert.equal(dupPinnedB.record.injectionStatus, 'body-injected');
  });
  const dupMismatch = await preStep('phase2-dup-mismatch', 'D', '[{"name":"dup-skill","repo":"repoThatDoesNotExist"}]');
  check('an unresolvable declared repo FAILS CLOSED instead of falling back to a same-named copy', () => {
    assert.equal(dupMismatch.result, dupMismatch.base, 'must not inject anything');
    assert.equal(dupMismatch.record.injectionStatus, 'manual-load-failed');
    assert.equal(dupMismatch.record.messageAppended, false);
    assert.equal(dupMismatch.record.payloadType, 'none');
    assert.equal(dupMismatch.record.loadFailure, 'source-not-library', 'loadSkill reports the repo-filter miss by this name');
    assert.equal(dupMismatch.record.repoMismatchDetail.declaredRepo, 'repoThatDoesNotExist');
    assert.equal(dupMismatch.record.repoMismatchDetail.resolvedRepo, '', 'nothing resolved, so nothing is claimed as resolved');
    assert.equal(dupMismatch.record.injectedSkills.length, 0);
  });
  // The repo-mismatch branch guards a REAL fallback hole, not a hypothetical: when the index does
  // not know a name, loadSkill calls scanForSkill (host.js:1548), which walks the directory tree and
  // IGNORES the repo filter. So a file that is present on disk but NOT in the index at the declared
  // repo path can still resolve - to a repo the manifest never declared. Construct exactly that: a
  // skill on disk under repoB with no index row at all.
  mkdirSync(join(libraryRoot, 'repoC', 'skills', 'unindexed-skill'), { recursive: true });
  writeFileSync(join(libraryRoot, 'repoC', 'skills', 'unindexed-skill', 'SKILL.md'), '# Unindexed\nUNINDEXED_BODY_SENTINEL\n', 'utf8');
  const unindexedPinned = await preStep('phase2-unindexed-pinned', 'D', '[{"name":"unindexed-skill","repo":"repoD"}]');
  check('a skill found by directory scan is REJECTED when its repo contradicts the declaration', () => {
    assert.equal(unindexedPinned.result, unindexedPinned.base, 'the scanForSkill fallback must not defeat the declared repo');
    assert.equal(unindexedPinned.record.injectionStatus, 'manual-load-failed');
    assert.equal(unindexedPinned.record.loadFailure, 'repo-mismatch');
    assert.equal(unindexedPinned.record.repoMismatchDetail.declaredRepo, 'repoD');
    // scanForSkill (host.js:1260) answers with `repo: ''` — the directory walk has no repo concept, so
    // an empty resolvedRepo is the honest report and the auditor needs to know which path answered.
    assert.equal(unindexedPinned.record.repoMismatchDetail.resolvedRepo, '');
    assert.match(unindexedPinned.record.repoMismatchDetail.resolvedBy, /directory-scan/);
    assert.equal(unindexedPinned.record.injectedSkills.length, 0);
  });
  check('telemetry records the declared repo alongside the resolved one', () => {
    assert.deepEqual(dupPinnedB.record.requestedSkillRepos, [{ name: 'dup-skill', repo: 'repoB' }]);
    assert.equal(dupPinnedB.record.injectedSkills[0].repo, 'repoB');
    assert.equal(typeof dupPinnedB.record.injectedSkills[0].contentBytes, 'number', 'body size is recorded so C and D can be compared on body identity');
    assert.ok(dupPinnedB.record.injectedSkills[0].contentBytes > 0);
  });
  check('telemetry records mechanics and names but never skill body text', () => {
    const text = readFileSync(logPath, 'utf8');
    assert.match(text, /"phase2Mode":"C"/);
    assert.match(text, /"messageAppended":true/);
    assert.equal(text.includes('BODY_SENTINEL'), false);
  });
} finally {
  for (const key of ['DSH_PHASE2_ARM', 'DSH_PHASE2_MANUAL_INJECT_SKILLS', 'DSH_PHASE2_EXPECTED_SKILLS', 'DSH_SKILL_ROUTER_DISCOVERY_LOG']) delete process.env[key];
  rmSync(workspace, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('\nPhase-2 conditions FAILED:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('\nPhase-2 conditions: OK');
}
