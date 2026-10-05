// Opt-in live integration check. Only uploads the supplied synthetic WAV;
// never opens microphone/loopback capture. Uses the existing Veyra OpenAI key.
const fs = require('node:fs'), path = require('node:path');
const { OpenAIRealtimeSTT } = require('../src/stt-streaming');
const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'veyra', 'veyra-data.json'), 'utf8'));
const wav = fs.readFileSync(process.argv[2]);
if (wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Expected a mono 16 kHz PCM WAV');
let pcm, format;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4), type = wav.toString('ascii', offset, offset + 4);
  if (type === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + size);
  if (type === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + size % 2;
}
if (!pcm || format?.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16) throw new Error('Expected mono 16 kHz PCM16');
let began, firstDelta, lastFinal, ready = false, sent = false;
const finals = [];
const timeout = setTimeout(() => finish(new Error('Timed out')), 30000);
const stt = new OpenAIRealtimeSTT(settings.apiKeys.openai, {
  onStatusChange: async status => {
    if (status !== 'connected' || ready) return;
    ready = true; began = Date.now();
    console.log('Session configured; streaming synthetic speech for', Math.round(pcm.length / 32), 'ms');
    const input = Buffer.concat([pcm, Buffer.alloc(32000)]);
    for (let offset = 0; offset < input.length && !sent; offset += 960) {
      stt.sendAudio(input.subarray(offset, offset + 960));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    sent = true;
    stt.requestFinalize();
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (finals.length && !stt.hasPending()) finish();
  },
  onInterim: text => { if (text && firstDelta == null) { firstDelta = Date.now() - began; console.log('First interim after', firstDelta, 'ms'); } },
  onTranscript: text => { finals.push(text); lastFinal = Date.now() - began; console.log('Synthetic final:', text); },
  onError: error => finish(new Error(error.message))
});
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true; sent = true; clearTimeout(timeout); stt.disconnect();
  if (error) { console.error(error.message); process.exitCode = 1; }
  else console.log(JSON.stringify({ model: stt.model, firstDeltaMs: firstDelta, lastFinalMs: lastFinal, finalTurns: finals.length, pending: stt.hasPending() }));
}
stt.connect();
