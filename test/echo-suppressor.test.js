const test = require('node:test');
const assert = require('node:assert/strict');
const { findResidualEcho, echoConfidence, ECHO_OPTIONS, normalizeTokens, sequenceSimilarity } = require('../src/echo-suppressor');

const BASE = 1_700_000_000_000;
const themTurn = (text, startOffset = 0, durationMs = 2000) =>
  ({ channel: 'them', speaker: 'Them', text, startedAt: BASE + startOffset, endedAt: BASE + startOffset + durationMs, final: true });
const micTurn = (text, startOffset, durationMs = 2000) =>
  ({ channel: 'you', speaker: 'You', text, startedAt: BASE + startOffset, endedAt: BASE + startOffset + durationMs, final: true });

test('suppresses a near-identical microphone echo of the far-end question', () => {
  const them = themTurn('How would you optimize this query?');
  const mic = micTurn('How would you optimise this query?', 250);
  const echo = findResidualEcho(mic, [them]);
  assert.ok(echo, 'expected the near-identical, immediately-following utterance to be classified as echo');
  assert.ok(echo.confidence >= ECHO_OPTIONS.minConfidence);
});

test('suppresses an identical echo of a long far-end sentence', () => {
  const text = 'How would you optimize this query if the table contained one billion rows';
  const echo = findResidualEcho(micTurn(text, 320, 2400), [themTurn(text, 0, 2400)]);
  assert.ok(echo, 'an identical long utterance during the far-end interval is echo');
});

test('tolerates one substituted word in a short echo', () => {
  const echo = findResidualEcho(micTurn('How would you optimize the query?', 250), [themTurn('How would you optimize this query?')]);
  assert.ok(echo, 'STT variance on a repeated question should still read as echo');
});

test('keeps a genuine answer that restates the question', () => {
  const them = themTurn('Would you use a broadcast join?');
  const mic = micTurn('Yes, I would use a broadcast join.', 250);
  assert.equal(findResidualEcho(mic, [them]), null, 'an answer is longer and differently ordered than its question');
});

test('keeps an ambiguous short repeat', () => {
  const them = themTurn('Broadcast join?', 0, 1200);
  const mic = micTurn('Broadcast join.', 250, 1200);
  assert.equal(findResidualEcho(mic, [them]), null, 'too short to distinguish an echo from a genuine repeat');
});

test('keeps the user speaking over far-end audio (double-talk)', () => {
  const them = themTurn('The first thing we should consider is partitioning', 0, 3000);
  const mic = micTurn('I would probably use Spark here.', 600, 1600);
  assert.equal(findResidualEcho(mic, [them]), null, 'different content must never be suppressed just because it overlaps');
});

test('keeps a microphone turn that began before the far-end turn', () => {
  const them = themTurn('How would you optimize this query?');
  const mic = micTurn('How would you optimize this query?', -1000);
  assert.equal(findResidualEcho(mic, [them]), null, 'the user spoke first, so this cannot be its echo');
});

test('keeps an identical utterance that is far outside the far-end interval', () => {
  const them = themTurn('How would you optimize this query?');
  const mic = micTurn('How would you optimize this query?', 8000);
  assert.equal(findResidualEcho(mic, [them]), null, 'eight seconds later is a repeat, not echo');
});

test('keeps a much longer microphone turn that merely contains the far-end words', () => {
  const them = themTurn('Would you use a broadcast join?');
  const mic = micTurn('Yes I would use a broadcast join because the fact table is large', 250, 5000);
  assert.equal(findResidualEcho(mic, [them]), null, 'extended speech is not echo');
});

test('falls back to publish timestamps when start timestamps are absent', () => {
  const them = { channel: 'them', text: 'How would you optimize this query?', ts: BASE };
  const mic = { channel: 'you', text: 'How would you optimise this query?', ts: BASE + 250 };
  assert.ok(findResidualEcho(mic, [them]), 'turns without startedAt must still be comparable');
});

test('never classifies a far-end turn as an echo of itself', () => {
  const them = themTurn('How would you optimize this query?');
  assert.equal(findResidualEcho({ ...them, channel: 'them', speaker: 'Them' }, [them]), null);
});

test('normalization folds british spellings and punctuation', () => {
  assert.deepEqual(normalizeTokens('How would you optimise this query?'), ['how', 'would', 'you', 'optimize', 'this', 'query']);
  assert.equal(sequenceSimilarity(normalizeTokens('How would you optimise this?'), normalizeTokens('how would you optimize this')), 1);
});

test('confidence decays with distance instead of stepping off a cliff', () => {
  const them = themTurn('How would you optimize this query?');
  const close = echoConfidence(micTurn('How would you optimize this query?', 250), them, ECHO_OPTIONS);
  const near = echoConfidence(micTurn('How would you optimize this query?', 3000), them, ECHO_OPTIONS);
  const far = echoConfidence(micTurn('How would you optimize this query?', 3900), them, ECHO_OPTIONS);
  assert.equal(close.confidence, 1);
  assert.ok(near.confidence > 0 && near.confidence < 1, 'inside the trail window the score must be partial, not binary');
  assert.ok(far.confidence < near.confidence);
  assert.equal(far.confidence, 0);
  assert.equal(far.reason, 'no-interval-overlap');
});
