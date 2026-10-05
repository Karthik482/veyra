const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamingTurnDetector } = require('../src/streaming-turn-detector');
function pcm(ms, value = 0) {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
}
test('live speech is forwarded before silence; a turn commits once after 450 ms silence', () => {
  const audio = [], commits = [];
  const detector = new StreamingTurnDetector({ onAudio: b => audio.push(b), onEnd: () => commits.push(audio.length) });
  detector.push(pcm(1000));
  assert.equal(audio.length, 0);
  detector.push(pcm(600, 2000));
  assert.ok(audio.length > 0);
  assert.equal(commits.length, 0);
  detector.push(pcm(480));
  assert.equal(commits.length, 1);
  detector.push(pcm(1000)); detector.flush();
  assert.equal(commits.length, 1);
});
test('arbitrary PCM boundaries preserve all samples and explicit flush pads short turns', () => {
  const audio = [], commits = [];
  const detector = new StreamingTurnDetector({ onAudio: b => audio.push(Buffer.from(b)), onEnd: () => commits.push(1) });
  const speech = pcm(47, 2500);
  for (let i = 0; i < speech.length; i += 256) detector.push(speech.subarray(i, i + 256));
  detector.flush();
  assert.equal(commits.length, 1);
  const sent = Buffer.concat(audio);
  assert.ok(sent.subarray(0, speech.length).equals(speech));
  assert.equal(sent.length, 3200);
});
test('continuous speech has bounded turns without waiting to stream audio', () => {
  let bytes = 0, commits = 0;
  const detector = new StreamingTurnDetector({ maxTurnMs: 300, onAudio: b => { bytes += b.length; }, onEnd: () => { commits++; } });
  detector.push(pcm(900, 2000));
  assert.equal(commits, 3);
  assert.equal(bytes, 900 * 32);
});
test('an Assist flush followed by silence does not create a second empty utterance', () => {
  let commits = 0;
  const detector = new StreamingTurnDetector({ onAudio() {}, onEnd: () => { commits++; } });
  detector.push(pcm(600, 2000));
  detector.flush();
  detector.push(pcm(1000));
  assert.equal(commits, 1);
  assert.equal(detector.active, false);
});
