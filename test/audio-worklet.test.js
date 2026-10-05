const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
test('worklet sends 30 ms chunks and includes right-only stereo audio', () => {
  const buffers = [];
  let Processor;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/audio-worklet-processor.js'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: b => buffers.push(b) }; } },
    registerProcessor: (_name, constructor) => { Processor = constructor; }
  });
  const processor = new Processor();
  for (let i = 0; i < 4; i++) processor.process([[new Float32Array(128), new Float32Array(128).fill(0.5)]]);
  assert.equal(buffers.length, 1);
  const pcm = new Int16Array(buffers[0]);
  assert.equal(pcm.length, 480);
  assert.ok(pcm.every(value => value > 8000 && value < 8300));
});
