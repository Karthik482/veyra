const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const localRequire = Module.createRequire(path.join(root, 'main.js'));
const image = text => 'data:image/png;base64,' + Buffer.from(text).toString('base64');

function harness() {
  const handlers = new Map(), requests = [];
  const settings = { provider: 'openai', sttProvider: 'auto', apiKeys: { openai: 'fake' }, models: { openai: { fast: 'fake-model' } } };
  let nextImage = image('code');
  const module = { exports: {} };
  const sandbox = {
    require(request) {
      if (request === 'electron') return { app: { isPackaged: true, whenReady: () => ({ then() {} }), on() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) } };
      if (request === './src/store') return { getSettings: () => settings };
      if (request === './src/screen') return { captureScreenshot: async () => { if (nextImage instanceof Error) throw nextImage; return nextImage; } };
      if (request === './src/applink') return { recordEvent() {} };
      if (request === './src/llm') return { createLLM: () => ({ ready: true, provider: 'openai', model: 'fake-model', stream: async args => { requests.push(args); args.onToken('Use a hash set.'); return 'Use a hash set.'; } }) };
      if (request === './src/stt-streaming') return { createStreamingSTT: (...args) => {
        const result = localRequire(request).createStreamingSTT(...args);
        if (result.instance) result.instance.connect = async () => {};
        return result;
      } };
      return localRequire(request);
    },
    module, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: root
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8') + '\nmodule.exports = { initStreamingSTT, streamingSTT, transcript, state, runFeature, publishTranscript, assistSession, transcriptionState: () => ({ streamingMode, sttDisabled, batch: !!batchTranscriber }) };', sandbox);
  const main = module.exports;
  main.initStreamingSTT();
  return { ...main, handlers, requests, settings, setImage: value => { nextImage = value; } };
}
function event(stt, type, item_id, text) { stt._handleEvent({ type: 'conversation.item.input_audio_transcription.' + type, item_id, [type === 'delta' ? 'delta' : 'transcript']: text }); }

test('microphone PCM routes only to You and Windows playback PCM only to Them', () => {
  const app = harness(), routed = [];
  app.state.capturing = true;
  app.streamingSTT.you.sendAudio = pcm => routed.push(['you', Buffer.from(pcm)[0]]);
  app.streamingSTT.them.sendAudio = pcm => routed.push(['them', Buffer.from(pcm)[0]]);
  app.handlers.get('mic:pcm')(null, Buffer.alloc(960, 1));
  app.handlers.get('system:pcm')(null, Buffer.alloc(960, 2));
  assert.deepEqual(routed, [['you', 1], ['them', 2]]);
});

test('an OpenAI realtime error never silently enables batch transcription', () => {
  const app = harness();
  app.streamingSTT.you.onError({ provider: 'openai-realtime', message: 'synthetic configuration rejection' });
  const state = app.transcriptionState();
  assert.equal(state.streamingMode, false);
  assert.equal(state.sttDisabled, true);
  assert.equal(state.batch, false);
  assert.equal(app.streamingSTT.you, null);
  assert.equal(app.streamingSTT.them, null);
});

test('immediate Assist waits for latest final and includes both finalized statements', async () => {
  const app = harness(), stt = app.streamingSTT.them;
  event(stt, 'completed', 'first', 'What is a discounted cash flow model?');
  event(stt, 'delta', 'second', 'How is WACC calculated?');
  setTimeout(() => event(stt, 'completed', 'second', 'How is WACC calculated?'), 20);
  await app.runFeature('assist');
  const prompt = app.requests[0].turns.at(-1).text;
  assert.match(prompt, /discounted cash flow model/);
  assert.match(prompt, /WACC calculated/);
  assert.doesNotMatch(prompt, /not yet final/);
  assert.equal(app.transcript.length, 2);
});

test('slow finalization uses accumulated interim after a bounded wait without adding false finals', async () => {
  const app = harness();
  for (const text of ['What is a', ' discounted cash flow model?']) event(app.streamingSTT.them, 'delta', 'a', text);
  const began = Date.now();
  await app.runFeature('assist');
  assert.ok(Date.now() - began < 1500);
  assert.match(app.requests[0].turns.at(-1).text, /Them \(not yet final\): What is a discounted cash flow model\?/);
  assert.equal(app.transcript.length, 0);
});

test('manual captures, fresh screen and follow-up answer survive multiple real Assist handler calls', async () => {
  const app = harness();
  await app.handlers.get('assist:screenshot')();
  app.setImage(image('scrolled code'));
  await app.handlers.get('assist:screenshot')();
  app.publishTranscript('them', 'How would you optimize this code?');
  app.setImage(image('caller'));
  await app.runFeature('assist');
  assert.deepEqual(Array.from(app.requests[0].imageDataUrls), [image('code'), image('scrolled code'), image('caller')]);
  app.publishTranscript('you', 'I would first measure performance.');
  app.publishTranscript('them', "What if the input doesn't fit in memory?");
  app.setImage(new Error('synthetic capture failure'));
  await app.runFeature('assist');
  const followup = app.requests[1];
  assert.equal(followup.imageDataUrls.length, 3);
  assert.match(followup.turns[0].text, /optimize this code/);
  assert.equal(followup.turns[1].text, 'Use a hash set.');
  assert.match(followup.turns.at(-1).text, /doesn't fit in memory/);
  assert.match(followup.turns.at(-1).text, /You: I would first/);
});

test('Clear Context excludes the old problem and late interim finals without stopping either channel', async () => {
  const app = harness();
  app.state.capturing = true;
  app.publishTranscript('them', 'old finalized question');
  event(app.streamingSTT.them, 'delta', 'old', 'old unfinished question');
  const you = app.streamingSTT.you, them = app.streamingSTT.them;
  await app.handlers.get('assist:screenshot')();
  app.handlers.get('assist:clear-context')();
  event(them, 'completed', 'old', 'old unfinished question');
  event(you, 'completed', 'new-you', 'new answer from mic');
  event(them, 'completed', 'new-them', 'new question from system');
  app.setImage(null);
  await app.runFeature('assist');
  const prompt = app.requests[0].turns.at(-1).text;
  assert.doesNotMatch(prompt, /old finalized|old unfinished/);
  assert.match(prompt, /You: new answer from mic/);
  assert.match(prompt, /Them: new question from system/);
  assert.equal(app.requests[0].imageDataUrls.length, 0);
  assert.equal(app.state.capturing, true);
  assert.equal(app.streamingSTT.you, you);
  assert.equal(app.streamingSTT.them, them);
});

test('out-of-order OpenAI completions retain spoken question order in Assist', async () => {
  const app = harness(), stt = app.streamingSTT.them;
  stt._handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'first' });
  stt._handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'second' });
  event(stt, 'completed', 'second', 'Second question');
  event(stt, 'completed', 'first', 'First question');
  await app.runFeature('assist');
  const text = app.requests[0].turns.at(-1).text;
  assert.ok(text.indexOf('Them: First question') < text.indexOf('Them: Second question'));
  assert.match(text, /Latest spoken question:\nSecond question/);
});
test('an Assist click the instant the interviewer stops waits for the pending final instead of aborting', async () => {
  const app = harness(), stt = app.streamingSTT.them;
  // The 450 ms local silence detector has committed the turn, but the provider has not
  // answered yet: the buffer is committed and there is no transcript and no interim.
  // This is exactly the state that used to produce "still being transcribed" and abort.
  stt._handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'q1' });
  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'q1' });
  const question = 'How would you optimize this query if the table contained one billion rows?';

  const assist = app.runFeature('assist');
  setTimeout(() => event(stt, 'completed', 'q1', question), 40);
  await assist;

  assert.equal(app.requests.length, 1, 'exactly one LLM request must be sent — the click must not be discarded');
  const prompt = app.requests[0].turns.at(-1).text;
  assert.match(prompt, /one billion rows/, 'the answer must be asked with the finished question');
  assert.match(prompt, new RegExp('Latest spoken question:\\n' + question.replace(/\?/g, '\\?')));
  assert.doesNotMatch(prompt, /not yet final/);
  assert.equal(app.transcript.length, 1);
  assert.equal(app.transcript[0].text, question);
});

test('a second Assist click while a request is in flight never starts a second LLM request', async () => {
  const app = harness();
  event(app.streamingSTT.them, 'delta', 'q1', 'What is a hash set?');
  const first = app.runFeature('assist');
  const second = app.runFeature('assist'); // the impatient second click
  await Promise.all([first, second]);
  assert.equal(app.requests.length, 1);
});

test('a stalled provider still lets Assist through with the accumulated interim', async () => {
  const app = harness();
  for (const text of ['What is a', ' discounted cash flow model?']) event(app.streamingSTT.them, 'delta', 'stall', text);
  await app.runFeature('assist');
  assert.equal(app.requests.length, 1, 'a provider that never answers must not cancel the request');
  assert.match(app.requests[0].turns.at(-1).text, /discounted cash flow model/);
});

test('every transcript entry carries its origin, speaker and interval', () => {
  const app = harness();
  const began = Date.now() - 5000;
  app.publishTranscript('them', 'How would you optimize this query?', { startedAt: began, itemId: 'them-1' });
  app.publishTranscript('you', 'I would probably use Spark here.', { startedAt: began + 600, itemId: 'you-1' });
  assert.equal(app.transcript.length, 2);
  for (const turn of app.transcript) {
    assert.equal(typeof turn.startedAt, 'number');
    assert.equal(typeof turn.endedAt, 'number');
    assert.equal(turn.final, true);
    assert.ok(turn.endedAt >= turn.startedAt);
  }
  const far = app.transcript.find(turn => turn.channel === 'them');
  const near = app.transcript.find(turn => turn.channel === 'you');
  assert.equal(far.source, 'loopback');
  assert.equal(far.speaker, 'Them');
  assert.equal(near.source, 'microphone');
  assert.equal(near.speaker, 'You');
});

test('a microphone copy of the far-end question is suppressed and never enters the transcript', () => {
  const app = harness();
  const began = Date.now() - 5000;
  app.publishTranscript('them', 'How would you optimize this query?', { startedAt: began, itemId: 'them-1' });
  app.publishTranscript('you', 'How would you optimise this query?', { startedAt: began + 250, itemId: 'you-1' });
  assert.equal(app.transcript.length, 1, 'the acoustic duplicate must not become a second speaker turn');
  assert.equal(app.transcript[0].channel, 'them');
});

test('genuine speech over far-end audio is still transcribed', () => {
  const app = harness();
  const began = Date.now() - 30000;
  app.publishTranscript('them', 'The first thing we should consider is partitioning', { startedAt: began, itemId: 'them-1' });
  app.publishTranscript('you', 'I would probably use Spark here.', { startedAt: began + 600, itemId: 'you-1' });
  app.publishTranscript('them', 'Would you use a broadcast join?', { startedAt: began + 4000, itemId: 'them-2' });
  app.publishTranscript('you', 'Yes, I would use a broadcast join.', { startedAt: began + 4300, itemId: 'you-2' });
  assert.deepEqual(Array.from(app.transcript).map(turn => turn.channel), ['them', 'you', 'them', 'you']);
  const answer = app.transcript.find(turn => turn.text.startsWith('Yes, I would'));
  assert.ok(answer, 'an answer that restates the question must be kept');
  assert.equal(answer.source, 'microphone');
});

test('echo suppression can be switched off without touching the microphone path', () => {
  const app = harness();
  app.settings.echoSuppression = false;
  const began = Date.now() - 5000;
  app.publishTranscript('them', 'How would you optimize this query?', { startedAt: began, itemId: 'them-1' });
  app.publishTranscript('you', 'How would you optimise this query?', { startedAt: began + 250, itemId: 'you-1' });
  assert.equal(app.transcript.length, 2, 'with the filter off the microphone turn is kept as-is');
  assert.equal(app.transcript[1].channel, 'you');
});
