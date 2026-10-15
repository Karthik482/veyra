const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('followup mode returns a bullet list', () => {
  const system = MODES.followup.buildSystem(null);
  assert.match(system, /bullet list|bullets/i);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every non-leetcode mode injects AI rules into its system prompt', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every non-leetcode mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('leetcode mode never applies AI rules (coding answers stay strict)', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes('USER RULES'), 'leetcode must not include USER RULES');
  assert.ok(!withRules.includes(RULES), 'leetcode must not leak user rules into the prompt');
  assert.match(withRules, /competitive programmer/);
});

test('coding format orders clarification, approach and annotated code after general Style rules', () => {
  for (const mode of ['assist', 'leetcode']) {
    const system = MODES[mode].buildSystem(null, 'Only return one sentence.');
    assert.ok(system.indexOf('**Clarify / assume**') < system.indexOf('**Approach**'));
    assert.ok(system.indexOf('**Approach**') < system.indexOf('**Code**'));
    assert.match(system, /above each CTE declaration/);
    assert.match(system, /above the final query/);
    assert.match(system, /comment directly below every nonblank code line/);
    if (mode === 'assist') assert.ok(system.lastIndexOf('**Clarify / assume**') > system.indexOf('Only return one sentence.'));
  }
});

test('say mode targets the latest interviewer question after a candidate response', () => {
  const transcript = Array.from({ length: 20 }, (_, i) => ({ channel: i % 2 ? 'you' : 'them', text: `turn ${i}` }));
  const prompt = MODES.say.build({ transcript });
  assert.match(prompt, /CURRENT INTERVIEWER QUESTION:\nturn 18/);
  assert.match(prompt, /Do not continue or rewrite the candidate's previous response/);
  assert.ok(!prompt.includes('Them: turn 10\n'));
});

test('say follow-ups retain the outcome at the end of the most recent spoken story', () => {
  const transcript = [
    { channel: 'you', text: 'x'.repeat(1100) + 'OLD_REPLY_TAIL' },
    { channel: 'them', text: 'Tell me about a time you pushed back on a request.' },
    { channel: 'you', text: 'a'.repeat(1400) + ' We agreed a Friday review using comparable populations. LATEST_REPLY_OUTCOME' },
    { channel: 'them', text: 'How did the stakeholder react to that pushback?' },
  ];
  const prompt = MODES.say.build({ transcript });
  assert.ok(prompt.includes('LATEST_REPLY_OUTCOME'));
  assert.ok(!prompt.includes('OLD_REPLY_TAIL'));
  assert.match(prompt, /CURRENT INTERVIEWER QUESTION:\nHow did the stakeholder react/);
});
