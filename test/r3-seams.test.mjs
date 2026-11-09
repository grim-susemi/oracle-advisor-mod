import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../scripts/build.mjs';
import {
  familyOf,
  readDriver,
  validateRouting,
  classifyNature,
  resolveAdvisor,
  loadTaskNature,
  loadDefaultRouting,
} from '../src/seams.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_DIR = join(ROOT, 'test/fixtures/r3-seams');

function readJsonFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

test('fixture routing.default.json is byte-equal to config/routing.default.json', () => {
  const configBytes = readFileSync(join(ROOT, 'config/routing.default.json'));
  const fixtureBytes = readFileSync(join(FIXTURES_DIR, 'routing.default.json'));
  assert.ok(configBytes.equals(fixtureBytes));
});

test('runtimeFiles correctly detects config files via new URL literals in src/seams.mjs', () => {
  const files = runtimeFiles(ROOT, 'src/seams.mjs');
  assert.ok(files.includes('config/routing.default.json'), 'must include routing.default.json');
  assert.ok(files.includes('config/task-nature.json'), 'must include task-nature.json');
});

test('loaders read configuration fresh from new URL literals without cross-test caching', () => {
  const nature = loadTaskNature();
  assert.equal(nature.v, 1);
  assert.deepEqual(nature.design.categories, ['visual-engineering']);
  assert.deepEqual(nature.design.skills, ['visual-qa']);
  assert.deepEqual(nature.lowlevel.categories, []);
  assert.deepEqual(nature.lowlevel.skills, ['debugging']);

  const routing = loadDefaultRouting();
  assert.equal(routing.v, 1);
  assert.ok(routing.profiles.claude);
  assert.ok(routing.profiles.gpt);
});

for (const [nature, expectedFamily] of [['design', 'claude'], ['lowlevel', 'gpt']]) {
  test(`shipped ${nature} route keeps ${expectedFamily} when oracle role becomes GPT`, () => {
    const table = loadDefaultRouting();
    const advisor = resolveAdvisor({ kind: 'work', mainFamily: 'gpt', driver: null, nature, table });
    const effectiveModel = advisor.model ?? 'chatgpt-subscription/gpt-6-astra:xhigh';
    assert.equal(familyOf(effectiveModel.split('/')[1].split(':')[0]), expectedFamily);
    assert.equal(advisor.source, 'by_nature');
    assert.equal(advisor.reason, nature);
  });
}

test('familyOf classifies model IDs correctly into claude, gpt, other, and unknown', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'claude');
  assert.equal(familyOf('anthropic/claude-3-5-sonnet'), 'claude');
  assert.equal(familyOf('CLAUDE-sonnet'), 'claude');
  assert.equal(familyOf('gpt-6-astra'), 'gpt');
  assert.equal(familyOf('gpt-4o'), 'gpt');
  assert.equal(familyOf('openai/gpt-5'), 'other'); // starts with openai, not gpt-
  assert.equal(familyOf('deepseek-r1'), 'other');
  assert.equal(familyOf('llama-3'), 'other');
  assert.equal(familyOf(''), 'unknown');
  assert.equal(familyOf(null), 'unknown');
  assert.equal(familyOf(undefined), 'unknown');
});

test('readDriver extracts newest valid primary-agent entry and ignores malformed ones', () => {
  const noneBranch = readJsonFixture('driver-branch-none.json');
  assert.equal(readDriver(noneBranch), null);

  const atlasBranch = readJsonFixture('driver-branch-atlas.json');
  assert.deepEqual(readDriver(atlasBranch), { schemaVersion: 1, agentId: 'atlas' });

  const malformedBranch = readJsonFixture('driver-branch-malformed.json');
  assert.equal(readDriver(malformedBranch), null);

  const twoBranch = readJsonFixture('driver-branch-two-entries.json');
  assert.deepEqual(readDriver(twoBranch), { schemaVersion: 1, agentId: 'atlas' });

  // Sisyphus first then malformed -> sisyphus wins
  const fallbackBranch = [
    { type: 'custom', customType: 'primary-agent/v1', data: { schemaVersion: 1, agentId: 'sisyphus' } },
    { type: 'custom', customType: 'primary-agent/v1', data: { schemaVersion: 99, agentId: 'atlas' } },
  ];
  assert.deepEqual(readDriver(fallbackBranch), { schemaVersion: 1, agentId: 'sisyphus' });
});

test('validateRouting validates default table and catches invalid fixture samples', () => {
  const defaultRouting = readJsonFixture('routing.default.json');
  const validResult = validateRouting(defaultRouting);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.error, null);

  const unknownKey = readJsonFixture('invalid-unknown-key.json');
  const unknownKeyResult = validateRouting(unknownKey);
  assert.equal(unknownKeyResult.valid, false);
  assert.ok(unknownKeyResult.error.includes('unknown_extra_key'));

  const badPin = readJsonFixture('invalid-bad-pin.json');
  const badPinResult = validateRouting(badPin);
  assert.equal(badPinResult.valid, false);
  // Specifically discriminate pin-grammar error
  assert.ok(badPinResult.error.includes('does not match pin grammar provider/model[:level]'));

  const familyMismatch = readJsonFixture('invalid-family-mismatch.json');
  const mismatchResult = validateRouting(familyMismatch);
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.error.includes('does not match detected family'));

  const missingCompletion = readJsonFixture('invalid-missing-completion.json');
  const missingResult = validateRouting(missingCompletion);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.error.includes('must contain exactly work and completion'));

  // Non-object input
  assert.equal(validateRouting(null).valid, false);
  assert.equal(validateRouting('not an object').valid, false);
});

test('validateRouting strictly catches profile names, declared other mismatch, and extra/unknown keys', () => {
  const base = readJsonFixture('routing.default.json');

  // Bad profile name (invalid characters or uppercase)
  const badProf = structuredClone(base);
  badProf.profiles['Invalid_Name!'] = {};
  const badProfRes = validateRouting(badProf);
  assert.equal(badProfRes.valid, false);
  assert.ok(badProfRes.error.includes('invalid profile name: Invalid_Name!'));

  // Declared family 'other' for a gpt model must be invalid
  const gptDeclaredOther = structuredClone(base);
  gptDeclaredOther.profiles.gpt.family = 'other';
  const gptOtherRes = validateRouting(gptDeclaredOther);
  assert.equal(gptOtherRes.valid, false);
  assert.ok(gptOtherRes.error.includes('does not match detected family "gpt"'));

  // Unknown by_agent key (agent id not in valid agent set)
  const unknownAgent = structuredClone(base);
  unknownAgent.by_agent['unknown-agent'] = { work: 'claude', completion: 'claude' };
  const unknownAgentRes = validateRouting(unknownAgent);
  assert.equal(unknownAgentRes.valid, false);
  assert.ok(unknownAgentRes.error.includes('invalid agent id in by_agent: unknown-agent'));

  // Extra by_nature key
  const extraNature = structuredClone(base);
  extraNature.by_nature.extra = 'claude';
  const extraNatureRes = validateRouting(extraNature);
  assert.equal(extraNatureRes.valid, false);
  assert.ok(extraNatureRes.error.includes('by_nature must contain exactly design and lowlevel'));

  // Extra by_family key
  const extraFamily = structuredClone(base);
  extraFamily.by_family.extra = { work: 'claude', completion: 'gpt' };
  const extraFamilyRes = validateRouting(extraFamily);
  assert.equal(extraFamilyRes.valid, false);
  assert.ok(extraFamilyRes.error.includes('by_family must contain exactly claude, gpt, other'));
});

test('classifyNature classifies task args using category and Loadout lines, ignoring armed load_skills', () => {
  const natureTable = loadTaskNature();

  const singleDesign = readJsonFixture('task-single-design.json');
  assert.equal(classifyNature(singleDesign, natureTable), 'design');

  const batchMixed = readJsonFixture('task-batch-mixed.json');
  assert.equal(classifyNature(batchMixed, natureTable), 'mixed');

  const loadoutNone = readJsonFixture('task-loadout-none.json');
  assert.equal(classifyNature(loadoutNone, natureTable), 'neutral');

  const loadoutBackticks = readJsonFixture('task-loadout-backticks.json');
  assert.equal(classifyNature(loadoutBackticks, natureTable), 'design');

  const armedIgnored = readJsonFixture('task-armed-skills-ignored.json');
  // load_skills has ["debugging"] (lowlevel), but prompt has no Loadout and category is "quick" (neutral)
  assert.equal(classifyNature(armedIgnored, natureTable), 'neutral');

  const subagentOnly = readJsonFixture('task-subagent-only.json');
  assert.equal(classifyNature(subagentOnly, natureTable), 'neutral');

  // Items without a string category are ignored -> neutral
  const noCategoryItem = { prompt: 'Debug crash\nLoadout: debugging' };
  assert.equal(classifyNature(noCategoryItem, natureTable), 'neutral');

  // Single lowlevel item via category and prompt Loadout
  const lowlevelPrompt = { category: 'quick', prompt: 'Debug crash\nLoadout: debugging' };
  assert.equal(classifyNature(lowlevelPrompt, natureTable), 'lowlevel');

  // Both design and lowlevel on single item -> mixed
  const singleMixed = {
    category: 'visual-engineering',
    prompt: 'Fix CSS issue\nLoadout: debugging',
  };
  assert.equal(classifyNature(singleMixed, natureTable), 'mixed');

  // Non-object taskArgs
  assert.equal(classifyNature(null, natureTable), 'neutral');
  assert.equal(classifyNature(123, natureTable), 'neutral');
});

test('classifyNature obeys Arsenal line break rules and Loadout line positioning', () => {
  const natureTable = loadTaskNature();

  // Lone \r line separator
  const loneR = { category: 'quick', prompt: 'First line\rLoadout: debugging' };
  assert.equal(classifyNature(loneR, natureTable), 'lowlevel');

  // Unicode \u2028 line separator
  const unicodeSep = { category: 'quick', prompt: 'First line\u2028Loadout: debugging' };
  assert.equal(classifyNature(unicodeSep, natureTable), 'lowlevel');

  // Unicode \u2029 line separator (kills M23)
  const unicodeSep2029 = { category: 'quick', prompt: 'First line\u2029Loadout: debugging' };
  assert.equal(classifyNature(unicodeSep2029, natureTable), 'lowlevel');

  // Value-end cases: value must stop at separator and not swallow text on next line (kills M24)
  // If \u2029 is not a line end, value becomes 'visual-qa\u2029debugging' -> neutral
  const valueEnd2029 = { category: 'quick', prompt: 'Loadout: visual-qa\u2029debugging' };
  assert.equal(classifyNature(valueEnd2029, natureTable), 'design');

  const valueEndR = { category: 'quick', prompt: 'Loadout: visual-qa\rdebugging' };
  assert.equal(classifyNature(valueEndR, natureTable), 'design');

  const valueEnd2028 = { category: 'quick', prompt: 'Loadout: visual-qa\u2028debugging' };
  assert.equal(classifyNature(valueEnd2028, natureTable), 'design');

  // Loadout not as first non-whitespace token -> ignored
  const notFirstToken = { category: 'quick', prompt: 'x Loadout: debugging' };
  assert.equal(classifyNature(notFirstToken, natureTable), 'neutral');

  // Loadout mid-line after a newline where first token on second line is not Loadout -> ignored
  // And prompt where first line has non-first token Loadout -> ignored, subsequent Loadout line wins
  const midLineFirstIgnored = {
    category: 'quick',
    prompt: 'x Loadout: visual-qa\nLoadout: debugging',
  };
  assert.equal(classifyNature(midLineFirstIgnored, natureTable), 'lowlevel');

  // Loadout none handling: when prompt has Loadout: none, skills list is empty -> neutral
  const loadoutNoneExact = { category: 'quick', prompt: 'Loadout: none' };
  assert.equal(classifyNature(loadoutNoneExact, natureTable), 'neutral');
  const loadoutNoneWithReason = { category: 'quick', prompt: 'Loadout: none - pure code edit' };
  assert.equal(classifyNature(loadoutNoneWithReason, natureTable), 'neutral');

  // Loadout: none with custom table containing 'none' as a lowlevel skill:
  // parseLoadoutSkills('none') MUST return [] (none handled), NOT ['none']
  const tableWithNoneSkill = {
    v: 1,
    design: { categories: [], skills: [] },
    lowlevel: { categories: [], skills: ['none'] },
  };
  assert.equal(classifyNature(loadoutNoneExact, tableWithNoneSkill), 'neutral');

  // Two Loadout lines: first wins
  const twoLoadoutLines = {
    category: 'quick',
    prompt: 'Loadout: debugging\nLoadout: visual-qa',
  };
  assert.equal(classifyNature(twoLoadoutLines, natureTable), 'lowlevel');

  // First Loadout is none, second has skill: first wins -> neutral
  const firstNoneSecondSkill = {
    category: 'quick',
    prompt: 'Loadout: none\nLoadout: debugging',
  };
  assert.equal(classifyNature(firstNoneSecondSkill, natureTable), 'neutral');
});

test('resolveAdvisor matrix: nature > agent > family > fallback', () => {
  const table = loadDefaultRouting();

  // 1. Nature precedence (design -> claude, lowlevel -> gpt)
  const natureDesign = resolveAdvisor({
    kind: 'work',
    mainFamily: 'claude',
    driver: 'atlas',
    nature: 'design',
    table,
  });
  assert.deepEqual(natureDesign, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_nature',
    reason: 'design',
  });

  const natureLowlevel = resolveAdvisor({
    kind: 'work',
    mainFamily: 'gpt',
    driver: 'atlas',
    nature: 'lowlevel',
    table,
  });
  assert.deepEqual(natureLowlevel, {
    profile: 'gpt',
    model: 'chatgpt-subscription/gpt-6-astra:high',
    source: 'by_nature',
    reason: 'lowlevel',
  });

  // 1b. Nature must win over by_agent when table has by_agent entry for the driver
  const tableWithAgent = structuredClone(table);
  tableWithAgent.by_agent.atlas = { work: 'gpt', completion: 'gpt' };
  const natureOverAgent = resolveAdvisor({
    kind: 'work',
    mainFamily: 'claude',
    driver: 'atlas',
    nature: 'design',
    table: tableWithAgent,
  });
  assert.deepEqual(natureOverAgent, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_nature',
    reason: 'design',
  });

  // 1c. Unknown family + nature design -> by_nature
  const unknownWithNature = resolveAdvisor({
    kind: 'work',
    mainFamily: 'unknown',
    driver: null,
    nature: 'design',
    table,
  });
  assert.deepEqual(unknownWithNature, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_nature',
    reason: 'design',
  });

  // 2. Per-agent override with differing work and completion profiles
  const customTable = structuredClone(table);
  customTable.by_agent.atlas = { work: 'claude', completion: 'gpt' };

  const agentWork = resolveAdvisor({
    kind: 'work',
    mainFamily: 'claude',
    driver: 'atlas',
    nature: 'neutral',
    table: customTable,
  });
  assert.deepEqual(agentWork, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_agent',
    reason: 'atlas:work',
  });

  const agentCompletion = resolveAdvisor({
    kind: 'completion',
    mainFamily: 'claude',
    driver: 'atlas',
    nature: 'neutral',
    table: customTable,
  });
  assert.deepEqual(agentCompletion, {
    profile: 'gpt',
    model: 'chatgpt-subscription/gpt-6-astra:high',
    source: 'by_agent',
    reason: 'atlas:completion',
  });

  // 3. Main family (when agent has no override and nature is neutral)
  const familyClaudeWork = resolveAdvisor({
    kind: 'work',
    mainFamily: 'claude',
    driver: 'atlas',
    nature: 'neutral',
    table,
  });
  assert.deepEqual(familyClaudeWork, {
    profile: 'gpt',
    model: 'chatgpt-subscription/gpt-6-astra:high',
    source: 'by_family',
    reason: 'claude:work',
  });

  const familyGptWork = resolveAdvisor({
    kind: 'work',
    mainFamily: 'gpt',
    driver: 'atlas',
    nature: 'neutral',
    table,
  });
  assert.deepEqual(familyGptWork, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_family',
    reason: 'gpt:work',
  });

  const familyOtherWork = resolveAdvisor({
    kind: 'work',
    mainFamily: 'other',
    driver: null,
    nature: 'neutral',
    table,
  });
  assert.deepEqual(familyOtherWork, {
    profile: 'claude',
    model: 'anthropic-subscription/claude-opus-5-5:max',
    source: 'by_family',
    reason: 'other:work',
  });

  const familyOtherCompletion = resolveAdvisor({
    kind: 'completion',
    mainFamily: 'other',
    driver: null,
    nature: 'neutral',
    table,
  });
  assert.deepEqual(familyOtherCompletion, {
    profile: 'gpt',
    model: 'chatgpt-subscription/gpt-6-astra:high',
    source: 'by_family',
    reason: 'other:completion',
  });

  // 4. Unknown family -> legacy dispatch
  const unknownFamily = resolveAdvisor({
    kind: 'work',
    mainFamily: 'unknown',
    driver: null,
    nature: 'neutral',
    table,
  });
  assert.deepEqual(unknownFamily, {
    profile: null,
    model: null,
    source: 'legacy',
    reason: 'family_unknown',
  });
});
