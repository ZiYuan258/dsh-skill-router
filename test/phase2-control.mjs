import assert from 'node:assert/strict';
import { formatSkillContentText, parseManualSkillNames, parsePhase2Arm } from '../phase2-control.js';
import { discoveryRecord } from '../discovery.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  PASS ' + name);
}

console.log('Phase-2 control helpers:');
check('missing arm preserves legacy mode', () => assert.deepEqual(parsePhase2Arm(undefined), { mode: 'legacy', valid: true }));
check('four arms are explicit and case-insensitive', () => {
  for (const arm of ['A', 'B', 'C', 'D']) assert.deepEqual(parsePhase2Arm(arm.toLowerCase()), { mode: arm, valid: true });
});
check('invalid arm fails closed', () => assert.deepEqual(parsePhase2Arm('phase2-C'), { mode: 'invalid', valid: false }));
check('runner JSON manual list parses', () => assert.deepEqual(parseManualSkillNames('["semgrep","pytest-skill"]'), { valid: true, names: ['semgrep', 'pytest-skill'], skills: [{ name: 'semgrep', repo: '' }, { name: 'pytest-skill', repo: '' }], reason: '' }));
check('explicit empty list is valid for negative-control D', () => assert.deepEqual(parseManualSkillNames('[]'), { valid: true, names: [], skills: [], reason: '' }));
check('missing manual list is distinct from empty list', () => assert.deepEqual(parseManualSkillNames(undefined), { valid: false, names: [], skills: [], reason: 'missing-manual-list' }));
check('manual list deduplicates without reordering', () => assert.deepEqual(parseManualSkillNames('["semgrep","semgrep"]'), { valid: true, names: ['semgrep'], skills: [{ name: 'semgrep', repo: '' }], reason: '' }));
check('malformed JSON fails closed', () => assert.deepEqual(parseManualSkillNames('semgrep'), { valid: false, names: [], skills: [], reason: 'invalid-manual-list' }));
check('non-string entry fails closed', () => assert.deepEqual(parseManualSkillNames('["semgrep",4]'), { valid: false, names: [], skills: [], reason: 'invalid-manual-list' }));
check('unsafe name fails closed', () => assert.deepEqual(parseManualSkillNames('["../semgrep"]'), { valid: false, names: [], skills: [], reason: 'unsafe-name' }));
check('too many oracle skills fail instead of truncating', () => assert.deepEqual(parseManualSkillNames('["a","b","c","d"]'), { valid: false, names: [], skills: [], reason: 'too-many-manual-skills' }));
// The oracle arm must be pin-able to an exact repo: several expected skills exist in five library
// copies with different bodies, and an unpinned name silently resolves whichever relpath is shallowest.
check('a {name, repo} entry carries the repo into skills', () => assert.deepEqual(parseManualSkillNames('[{"name":"systematic-debugging","repo":"GanyuanRan-Aegis"}]'), { valid: true, names: ['systematic-debugging'], skills: [{ name: 'systematic-debugging', repo: 'GanyuanRan-Aegis' }], reason: '' }));
check('unsafe repo values fail closed', () => {
  for (const repo of ['../etc', 'a\\b', 'C:\\x', 'a/b']) {
    assert.deepEqual(parseManualSkillNames(JSON.stringify([{ name: 'semgrep', repo }])), { valid: false, names: [], skills: [], reason: 'unsafe-repo' }, 'repo=' + repo);
  }
});
check('formatter writes the expected library envelope', () => {
  const value = formatSkillContentText({ name: 'semgrep', source: 'library', resourceDir: 'X:/skills/semgrep', content: 'BODY_SENTINEL', referenceFiles: ['scripts/'] });
  assert.match(value, /<skill_content name="semgrep" source="library">/);
  assert.match(value, /BODY_SENTINEL/);
  assert.match(value, /Base directory for this skill: X:\/skills\/semgrep/);
  assert.match(value, /Bundled: scripts\//);
});
check('formatter rejects non-library, unsafe, empty, or truncated body', () => {
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'resident', content: 'x' }));
  assert.throws(() => formatSkillContentText({ name: '../x', source: 'library', content: 'x' }));
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'library', content: '' }));
  assert.throws(() => formatSkillContentText({ name: 'semgrep', source: 'library', content: 'x', truncated: true }));
});
check('ordinary discovery telemetry keeps its pre-phase-2 shape', () => {
  const record = discoveryRecord({ result: { candidates: [] }, turn: 1, step: 1 });
  assert.equal(Object.hasOwn(record, 'phase2Mode'), false);
  assert.equal(Object.hasOwn(record, 'injectedSkills'), false);
});
check('phase-2 discovery telemetry opts into bounded audit fields', () => {
  const record = discoveryRecord({ phase2Mode: 'C', injectionStatus: 'body-injected', injectedSkills: [{ name: 'semgrep', source: 'library', repo: 'trailofbits' }], messageAppended: true, payloadType: 'skill-body', payloadBytes: 123 });
  assert.equal(record.phase2Mode, 'C');
  assert.equal(record.injectionStatus, 'body-injected');
  assert.deepEqual(record.injectedSkills, [{ name: 'semgrep', source: 'library', repo: 'trailofbits' }]);
  assert.equal(record.payloadBytes, 123);
});
console.log(`Phase-2 control helpers: PASS (${passed} checks)`);
