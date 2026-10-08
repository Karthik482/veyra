const test = require('node:test');
const assert = require('node:assert/strict');
const { useSpokenModel, interviewerSources, questionReadiness, questionKey } = require('../src/latency-policy');
const { settleTranscription } = require('../src/assist-session');
const { selectResumeContext } = require('../src/interview-context');

test('spoken routing keeps coding and system design on the stronger model', () => {
  assert.equal(useSpokenModel('say', 'behavioral'), true);
  assert.equal(useSpokenModel('assist', 'experience'), true);
  assert.equal(useSpokenModel('say', 'technical'), false);
  assert.equal(useSpokenModel('leetcode', 'experience'), false);
  assert.equal(useSpokenModel('say', 'general'), true);
  for (const question of ['Write a SQL query.', 'Explain algorithm complexity.', 'Explain distributed architecture.', 'How would you design a system to scale?', 'Design a rate limiter.']) {
    assert.equal(useSpokenModel('say', 'general', question), false, question);
  }
  assert.equal(useSpokenModel('say', 'technical', 'What is dependency injection?'), true);
  assert.equal(useSpokenModel('say', 'technical', 'How would you migrate the backend?'), false);
  assert.equal(useSpokenModel('assist', 'general', 'What is dependency injection?'), false);
});

test('Say uses stability before the hotkey without skipping a changing or previously answered question', () => {
  let now = 1000;
  let turn = { channel: 'them', text: 'Tell me about your background.', startedAt: 100, updatedAt: 800 };
  const ready = questionReadiness(() => [turn], '', 180, () => now, true);
  assert.equal(ready(), true, 'already stable text should not add another 180 ms');
  turn = { ...turn, text: 'Tell me about your background and previous employers.', updatedAt: 1000 };
  assert.equal(ready(), false);
  now = 1180; assert.equal(ready(), true);
  assert.equal(questionReadiness(() => [turn], questionKey(turn), 180, () => now, true)(), false);
});

test('microphone-only pending work cannot delay answering an interviewer question', async () => {
  const flushed = [];
  const local = { hasPending: channel => channel === 'you', requestFinalize: channel => flushed.push(channel) };
  const sources = interviewerSources({ local, streaming: { you: { hasPending: () => true } } });
  const result = await settleTranscription(sources, { timeoutMs: 3000 });
  assert.equal(result.waitedMs, 0);
  assert.deepEqual(flushed, ['them']);
});

test('new final ends settlement without waiting for unrelated pending work', async () => {
  const result = await settleTranscription([{ hasPending: () => true }], {
    timeoutMs: 3000,
    ready: questionReadiness(() => [{ channel: 'them', seq: 2, text: 'Why this company?' }], 'previous'),
  });
  assert.equal(result.usable, true);
  assert.ok(result.waitedMs < 100);
});

test('interim must be new, long enough and stable before skipping finalization', () => {
  let now = 0;
  let turn = { channel: 'them', text: 'Tell me about yourself.', startedAt: 10 };
  const ready = questionReadiness(() => [turn], '', 180, () => now);
  assert.equal(ready(), false);
  now = 179; assert.equal(ready(), false);
  now = 181; assert.equal(ready(), true);
  turn = { ...turn, text: 'Tell me about yourself and your previous role.' };
  assert.equal(ready(), false);
  const previous = questionReadiness(() => [{ ...turn, seq: 3 }], questionKey(turn));
  assert.equal(previous(), false, 'already answered question cannot end waiting');
});

test('generic technical answers omit resume while personal technical questions retain it', () => {
  const resume = 'CurrentCo: Engineer, 2024-present. PreviousCo: Engineer, 2020-2024.';
  assert.equal(selectResumeContext(resume, 'technical', 'Explain SQL vs NoSQL.'), '');
  assert.equal(selectResumeContext(resume, 'technical', 'How did you design your pipeline?'), resume);
});

test('compaction retains employer headers across a long resume and introductions retain all text', () => {
  const resume = 'Jane Doe\nSummary\nExperienced engineer\n\nExperience\nCurrentCo\nEngineer 2023-present\n' +
    Array.from({length: 70}, (_, i) => `Worked on unrelated task ${i} with a standard process.`).join('\n') +
    '\nPreviousCo\nDeveloper 2020-2023\nReduced pipeline latency by 70 percent.\nEducation\nUniversity 2019';
  const compact = selectResumeContext(resume, 'behavioral', 'Tell me about a time you reduced latency.');
  assert.ok(compact.length <= 3500);
  assert.match(compact, /CurrentCo/); assert.match(compact, /PreviousCo/);
  assert.match(compact, /Reduced pipeline latency by 70 percent/);
  assert.equal(selectResumeContext(resume, 'experience', 'Tell me about yourself.'), resume);
});
