const test = require('node:test');
const assert = require('node:assert/strict');
const { currentInterviewTurns } = require('../src/interview-turns');
const { detectCategory, buildInterviewContext } = require('../src/interview-context');
const { MODES } = require('../src/prompts');

test('new interviewer question wins after the candidate reads and expands an old answer', () => {
  const transcript = [
    { seq: 1, channel: 'them', text: 'Tell me about a time you faced a conflict.', startedAt: 100 },
    { seq: 2, channel: 'you', text: 'I resolved the conflict and also led the migration.', startedAt: 200 },
  ];
  const turns = currentInterviewTurns(transcript, [{ channel: 'them', text: 'Why do you want to work here?', startedAt: 300 }]);
  assert.equal(detectCategory(turns), 'motivation');
  const prompt = MODES.say.build({ transcript: turns });
  assert.match(prompt, /CURRENT INTERVIEWER QUESTION:\nWhy do you want to work here\?/);
});

test('late older pending speech cannot override a newer finalized question', () => {
  const turns = currentInterviewTurns([
    { seq: 1, channel: 'them', text: 'Tell me about yourself.', startedAt: 300 },
  ], [{ channel: 'them', text: 'Tell me about a time you failed.', startedAt: 100 }]);
  assert.equal(detectCategory(turns), 'experience');
  assert.match(MODES.say.build({ transcript: turns }), /CURRENT INTERVIEWER QUESTION:\nTell me about yourself/);
});

test('pending speech is deduplicated against finalized speech and previous contexts are excluded', () => {
  const turns = currentInterviewTurns([
    { seq: 1, channel: 'them', text: 'Old question', contextRevision: 1 },
    { seq: 2, channel: 'them', text: 'Current question', itemId: 'q', contextRevision: 2 },
  ], [
    { channel: 'them', text: 'Current partial', itemId: 'q', revision: 2 },
    { channel: 'them', text: 'Old partial', revision: 1 },
  ], { afterSequence: 1, revision: 2 });
  assert.deepEqual(turns.map(turn => turn.text), ['Current question']);
});

test('resume references retain employers after irregular headings and long summaries, with Style rules', () => {
  const resume = 'SUMMARY\n' + 'I build data pipelines. '.repeat(100) +
    '\nPROFESSIONAL EXPERIENCE\nCurrentCo: Data Engineer, 2023-present\nPreviousCo: Backend Engineer, 2020-2023';
  const rules = 'Use a detailed first-person career narrative.';
  const context = buildInterviewContext({ resumeText: resume }, 'say', [{ channel: 'them', text: 'Tell me about yourself.' }]);
  const system = MODES.say.buildSystem(context, rules);
  assert.ok(system.includes(resume));
  assert.match(system, /CurrentCo/);
  assert.match(system, /PreviousCo/);
  assert.ok(system.endsWith(rules + '\n--- END USER RULES ---'));
  assert.match(system, /previous employers and roles/);
  assert.match(system, /Do not invent employers/);
});
