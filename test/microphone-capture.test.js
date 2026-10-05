const test = require('node:test');
const assert = require('node:assert/strict');
const { openMicrophone, echoMode } = require('../renderer/microphone-capture');

test('Windows requests cancellation of external system playback and preserves the chosen microphone', async () => {
  const stream = {};
  const calls = [];
  const result = await openMicrophone({ getUserMedia: async constraints => { calls.push(constraints); return stream; } },
    { platform: 'win32', deviceId: 'headset' });
  assert.equal(result.stream, stream);
  assert.equal(result.fallback, false);
  assert.deepEqual(calls[0].audio.echoCancellation, { exact: 'all' });
  assert.deepEqual(calls[0].audio.deviceId, { exact: 'headset' });
  assert.equal(calls[0].audio.autoGainControl, false);
  assert.equal('echoCancellationType' in calls[0].audio, false);
});

test('unsupported all-system cancellation retries the same device and reports the fallback', async () => {
  const calls = [];
  const result = await openMicrophone({ getUserMedia: async constraints => {
    calls.push(constraints);
    if (calls.length === 1) throw Object.assign(new Error('Unsupported'), { name: 'OverconstrainedError', constraint: 'echoCancellation' });
    return {};
  } }, { platform: 'win32', deviceId: 'headset' });
  assert.equal(result.fallback, true);
  assert.equal(calls.length, 2);
  assert.equal(result.requested.echoCancellation, true);
  assert.deepEqual(result.requested.deviceId, { exact: 'headset' });
});

for (const [name, constraint] of [['NotAllowedError'], ['NotReadableError'], ['OverconstrainedError', 'deviceId']]) {
  test(`${name}/${constraint || ''} does not retry or change microphones`, async () => {
    const error = Object.assign(new Error('capture failed'), { name, constraint });
    let calls = 0;
    await assert.rejects(openMicrophone({ getUserMedia: async () => { calls++; throw error; } }, { platform: 'win32' }), value => value === error);
    assert.equal(calls, 1);
  });
}

test('other platforms retain their existing default echo cancellation', async () => {
  const result = await openMicrophone({ getUserMedia: async () => ({}) }, { platform: 'darwin' });
  assert.equal(result.requested.echoCancellation, true);
  assert.equal('deviceId' in result.requested, false);
});

test('processing indicators distinguish all-system cancellation from default, remote-only and off', () => {
  assert.equal(echoMode('all'), 'all');
  assert.equal(echoMode('remote-only'), 'remote-only');
  assert.equal(echoMode(true), 'default');
  assert.equal(echoMode(false), 'off');
  assert.equal(echoMode(undefined), 'off');
});
