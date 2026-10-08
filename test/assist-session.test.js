const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistSession, settleTranscription } = require('../src/assist-session');
const { createDiagnostics } = require('../src/diagnostics');
const image = text => 'data:image/png;base64,' + Buffer.from(text).toString('base64');
const turn = (seq, text, channel = 'them') => ({ seq, text, channel });

test('ordered manual screenshots and a different current screen accompany the spoken question', () => {
  const session = new AssistSession();
  session.addScreenshot(image('first code'));
  session.addScreenshot(image('second code'));
  const context = session.build({ transcript: [turn(1, 'How would you optimize this code?')], freshDataUrl: image('third code') });
  assert.deepEqual(context.images.map(shot => shot.dataUrl), [image('first code'), image('second code'), image('third code')]);
  assert.match(context.prompt, /How would you optimize this code/);
  assert.equal(session.addScreenshot(image('second code')).duplicate, true);
  const duplicate = session.build({ transcript: [], freshDataUrl: image('second code') });
  assert.equal(duplicate.images.length, 3);
  assert.equal(duplicate.duplicateSkipped, true);
});

test('follow-ups retain original code, original question, previous solution and new question', () => {
  const session = new AssistSession();
  const transcript = [turn(1, 'This implementation is slow. How would you optimize it?')];
  const first = session.build({ transcript, freshDataUrl: image('original code') });
  session.remember(first, 'Use a hash set to track duplicates in linear time.');
  transcript.push(turn(2, "What if the input doesn't fit in memory?"));
  const followup = session.build({ transcript, freshDataUrl: image('other screen') });
  assert.deepEqual(followup.turns.map(turn => turn.role), ['user', 'assistant', 'user']);
  assert.match(followup.turns[0].text, /implementation is slow/);
  assert.match(followup.turns[1].text, /hash set/);
  assert.match(followup.turns[2].text, /doesn't fit in memory/);
  assert.deepEqual(followup.images.map(shot => shot.dataUrl), [image('original code'), image('other screen')]);
  const fallback = session.build({ transcript });
  assert.equal(fallback.freshCaptured, false);
  assert.equal(fallback.images.length, 2);
});

test('spoken requests omit stored screenshots and legends without losing later coding context', () => {
  const session = new AssistSession();
  session.addScreenshot(image('code'));
  const spoken = session.build({ transcript: [turn(1, 'Tell me about yourself.')], includeImages: false });
  assert.equal(spoken.images.length, 0);
  assert.match(spoken.prompt, /Screenshots in attachment order:\n\(none available\)/);
  const coding = session.build({ transcript: [turn(2, 'Explain this code.')] });
  assert.equal(coding.images.length, 1);
});

test('history limits preserve only fourteen recent finalized entries and three Assist exchanges', () => {
  const session = new AssistSession();
  const transcript = Array.from({ length: 40 }, (_, i) => turn(i + 1, `utterance ${i + 1}`));
  for (let i = 0; i < 8; i++) session.remember(session.build({ transcript }), `answer ${i}`);
  const result = session.build({ transcript });
  assert.equal(result.finalized.length, 14);
  assert.equal(result.finalized[0].seq, 27);
  assert.equal(session.history.length, 3);
  assert.equal(result.turns.length, 7);
  for (let i = 0; i < 4; i++) session.addScreenshot(image(String(i)));
  assert.throws(() => session.addScreenshot(image('fifth')), /Up to 4/);
});

test('clear excludes prior problem transcript, images and late Assist results', () => {
  const session = new AssistSession();
  session.addScreenshot(image('code'));
  const first = session.build({ transcript: [turn(1, 'old problem')] });
  session.remember(first, 'old answer');
  session.clear(1);
  session.remember(first, 'late old answer');
  const next = session.build({ transcript: [turn(1, 'old problem'), turn(2, 'new problem')] });
  assert.equal(next.images.length, 0);
  assert.equal(next.turns.length, 1);
  assert.doesNotMatch(next.prompt, /old problem/);
  assert.equal(session.history.length, 0, 'previous answers must be cleared');
  assert.match(next.prompt, /new problem/);
});

test('settles a pending final, and reports a stalled or timing-out provider instead of refusing the request', async () => {
  let pending = true;
  const source = { hasPending: () => pending, requestFinalize() { setTimeout(() => { pending = false; }, 15); } };
  const settled = await settleTranscription([source], 400);
  assert.equal(settled.settled, true);
  assert.equal(settled.pending, false);
  assert.equal(settled.timedOut, false);
  assert.equal(settled.stalled, false);

  assert.equal((await settleTranscription([], 100)).settled, true);

  const stalledBegan = Date.now();
  const stalled = await settleTranscription([{ hasPending: () => true }], { timeoutMs: 5000, stallMs: 60, pollMs: 10 });
  assert.equal(stalled.settled, false);
  assert.equal(stalled.pending, true);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.timedOut, false);
  assert.ok(Date.now() - stalledBegan < 1000, 'a source that stops reporting progress must not consume the whole timeout');

  const timedOut = await settleTranscription([{ hasPending: () => true }], 40);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.stalled, false);

  // A source that keeps reporting new internal state is making progress and is
  // allowed to run to the deadline rather than being cut off by the stall rule.
  let ticks = 0;
  const progressing = { hasPending: () => true, pendingSignature: () => String(ticks++) };
  const progressed = await settleTranscription([progressing], { timeoutMs: 300, stallMs: 200, pollMs: 10 });
  assert.equal(progressed.settled, false);
  assert.equal(progressed.timedOut, true);
  assert.equal(progressed.stalled, false);
});

test('development diagnostics redact configured credentials and image payloads', () => {
  const output = [];
  const logger = createDiagnostics({ enabled: true, secrets: () => ['secret-value'], write: (event, data) => output.push(JSON.stringify({ event, data })) });
  logger.log('CONTEXT', { text: 'secret-value Bearer private-token sk-private', apiKey: 'hidden', picture: image('secret screen') });
  assert.doesNotMatch(output[0], /secret-value|private-token|sk-private|hidden|c2VjcmV0/);
  createDiagnostics({ write: () => assert.fail('disabled diagnostics logged') }).log('TEST', {});
});
