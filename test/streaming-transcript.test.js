const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIRealtimeSTT, DeepgramStreamingSTT } = require('../src/stt-streaming');

test('OpenAI deltas accumulate per utterance and final replay is appended exactly once', () => {
  const interim = [], final = [];
  const stt = new OpenAIRealtimeSTT('fake', { onInterim: (text, meta) => interim.push({ text, ...meta }), onTranscript: text => final.push(text) });
  ['A', ' discounted', ' cash', ' flow', ' model'].forEach((delta, i) => stt._handleEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', event_id: String(i), delta }));
  assert.equal(interim.at(-1).text, 'A discounted cash flow model');
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', event_id: '4', delta: ' model' });
  const event = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'A discounted cash flow model' };
  stt._handleEvent(event); stt._handleEvent(event);
  assert.deepEqual(final, ['A discounted cash flow model']);
  assert.equal(interim.at(-1).text, '');
  assert.equal(stt.hasPending(), false);
});

test('interleaved utterances do not overwrite each other and finals stay separate', () => {
  const finals = [], interim = new Map();
  const stt = new OpenAIRealtimeSTT('fake', { onInterim: (text, meta) => interim.set(meta.itemId, text), onTranscript: text => finals.push(text) });
  for (const [item_id, delta] of [['a', 'What is'], ['b', 'How is'], ['a', ' DCF?'], ['b', ' WACC calculated?']]) stt._handleEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta });
  assert.equal(interim.get('a'), 'What is DCF?');
  assert.equal(interim.get('b'), 'How is WACC calculated?');
  for (const item_id of ['a', 'b']) stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: interim.get(item_id) });
  assert.deepEqual(finals, ['What is DCF?', 'How is WACC calculated?']);
});

test('manual OpenAI finalization commits live speech only once and tracks the acknowledgement', () => {
  const events = [], errors = [];
  const stt = new OpenAIRealtimeSTT('fake', { onError: error => errors.push(error) });
  stt.connected = stt._sessionReady = true;
  stt.ws = { readyState: 1, send: text => events.push(JSON.parse(text)) };
  stt.requestFinalize();
  assert.equal(events.length, 0);
  const speech = Buffer.alloc(6400);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(2000, i);
  stt.sendAudio(speech);
  stt.requestFinalize(); stt.requestFinalize();
  assert.equal(events.filter(event => event.type === 'input_audio_buffer.commit').length, 1);
  assert.equal(stt.hasPending(), true);
  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'a' });
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'hello' });
  assert.equal(stt.hasPending(), false);
  assert.equal(errors.length, 0);
});

test('OpenAI waits for configuration acknowledgement, not session.created', () => {
  const stt = new OpenAIRealtimeSTT('fake');
  const events = [];
  stt.connected = true;
  stt.ws = { readyState: 1, send: text => events.push(JSON.parse(text)) };
  const speech = Buffer.alloc(960, 8);
  stt.sendAudio(speech);
  stt._handleEvent({ type: 'session.created' });
  assert.equal(events.length, 0);
  stt._handleEvent({ type: 'session.updated' });
  assert.equal(events[0].type, 'input_audio_buffer.append');
});

test('OpenAI session disables unsupported server VAD and cancelled sockets cannot resurrect', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const { EventEmitter } = require('node:events');
  const localRequire = require('node:module').createRequire(require.resolve('../src/stt-streaming'));
  const sockets = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.events = []; sockets.push(this); }
    send(text) { this.events.push(JSON.parse(text)); }
    close() { this.emit('close', 1000); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/stt-streaming'), 'utf8'), {
    module, Buffer, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'ws' ? Socket : localRequire(name)
  });
  const stt = new module.exports.OpenAIRealtimeSTT('fake');
  await stt.connect(); sockets[0].emit('open');
  assert.equal(sockets[0].events[0].session.audio.input.turn_detection, null);
  stt.disconnect(); sockets[0].emit('message', Buffer.from('{"type":"session.updated"}'));
  assert.equal(stt._sessionReady, false);
  stt._attemptReconnect();
  assert.equal(stt._reconnectTimer, null);
});

test('Deepgram cumulative partials are replaced rather than concatenated', () => {
  const finals = [];
  const stt = new DeepgramStreamingSTT('fake', { onTranscript: text => finals.push(text) });
  for (const text of ['discounted', 'discounted cash', 'discounted cash flow']) stt._handleMessage({ type: 'Results', channel: { alternatives: [{ transcript: text }] } });
  stt._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'discounted cash flow model' }] } });
  assert.deepEqual(finals, ['discounted cash flow model']);
  assert.equal(stt.hasPending(), false);
});
