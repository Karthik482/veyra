const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchTranscriber } = require('../src/batch-transcriber');
const { settleTranscription } = require('../src/assist-session');
function frame(value) { const pcm = Buffer.alloc(960); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i); return pcm; }

test('continuous speech longer than 900ms is one final utterance after silence', async () => {
  const requests = [], finals = [];
  const batch = new BatchTranscriber({ transcribe: async pcm => { requests.push(pcm.length); return 'complete sentence'; }, onTranscript: (channel, text) => finals.push({ channel, text }) });
  for (let i = 0; i < 90; i++) batch.push('them', frame(1500));
  assert.equal(requests.length, 0);
  for (let i = 0; i < 22; i++) batch.push('them', frame(0));
  await settleTranscription([batch]);
  assert.equal(requests.length, 1);
  assert.deepEqual(finals, [{ channel: 'them', text: 'complete sentence' }]);
  batch.stop();
});

test('Assist flush preserves both speaker channels and capture can continue', async () => {
  const finals = [];
  const batch = new BatchTranscriber({ transcribe: async () => 'speech', onTranscript: channel => finals.push(channel) });
  for (let i = 0; i < 10; i++) { batch.push('you', frame(1400)); batch.push('them', frame(1800)); }
  await settleTranscription([batch]);
  assert.deepEqual(finals.sort(), ['them', 'you']);
  for (let i = 0; i < 10; i++) batch.push('them', frame(1500));
  await settleTranscription([batch]);
  assert.equal(finals.length, 3);
  batch.stop();
});

test('interviewer-only finalization leaves microphone speech out of the wait', async () => {
  let finish;
  const batch = new BatchTranscriber({ transcribe: () => new Promise(resolve => { finish = resolve; }), onTranscript() {} });
  for (let i = 0; i < 10; i++) batch.push('you', frame(1400));
  assert.equal(batch.hasPending('you'), true);
  assert.equal(batch.hasPending('them'), false);
  batch.requestFinalize('them');
  assert.equal(batch.pending, 0, 'candidate speech was not flushed');
  batch.requestFinalize('you');
  assert.equal(batch.pendingByChannel.you, 1);
  assert.equal(batch.hasPending('them'), false);
  await new Promise(resolve => setImmediate(resolve));
  finish('candidate answer');
  await batch.tails.you;
  assert.equal(batch.pendingByChannel.you, 0);
  batch.stop();
});
