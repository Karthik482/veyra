// Windows integration smoke: npx electron scripts/smoke-audio-assist.cjs
// Uses an empty temporary profile. No cloud calls, recordings, or real API keys.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-audio-smoke-'));
app.setPath('userData', profile);
process.env.LOCALAPPDATA = profile;
const appLink = require('../vendor/app-link');
const { AppLinkServer } = appLink;
appLink.AppLinkServer = class extends AppLinkServer {
  constructor(options) { super({ ...options, appId: `${options.appId}.audio-smoke-${process.pid}` }); }
};
const timeout = setTimeout(() => { console.error('FAIL: smoke timed out'); app.exit(1); }, 30000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.on('browser-window-created', (_event, win) => {
  const contents = win.webContents;
  contents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('Renderer:', message); });
  contents.once('did-finish-load', async () => {
    const evaluate = code => contents.executeJavaScript(code, true);
    try {
      await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (!document.querySelector('#onboard-scrim').classList.contains('hidden')) { clearInterval(timer); resolve(); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Renderer did not boot')); }
        }, 30);
      })`);
      await evaluate("document.querySelector('#ob-skip').click()");
      const tracks = await evaluate(`(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        try {
          stream.getVideoTracks().forEach(track => track.stop());
          await new Promise(resolve => setTimeout(resolve, 500));
          return stream.getAudioTracks().map(track => ({ kind: track.kind, label: track.label, readyState: track.readyState }));
        } finally { stream.getTracks().forEach(track => track.stop()); }
      })()`);
      assert.ok(tracks.some(track => track.kind === 'audio' && track.readyState === 'live'), 'Windows loopback did not return live audio');
      console.log('PASS: Electron', process.versions.electron, 'returns live system audio after stopping the video track:', JSON.stringify(tracks));
      contents.send('stt:interim', { channel: 'them', itemId: 'a', text: 'A discounted cash flow model' });
      contents.send('stt:interim', { channel: 'you', itemId: 'b', text: 'I would calculate' });
      await new Promise(resolve => setTimeout(resolve, 80));
      let interim = await evaluate("document.querySelector('.interim-transcript').textContent");
      assert.match(interim, /Them: A discounted cash flow model/);
      assert.match(interim, /You: I would calculate/);
      contents.send('transcript', { channel: 'them', itemId: 'a', text: 'A discounted cash flow model.' });
      contents.send('stt:final', { channel: 'them', itemId: 'a' });
      await new Promise(resolve => setTimeout(resolve, 80));
      interim = await evaluate("document.querySelector('.interim-transcript').textContent");
      assert.match(interim, /You: I would calculate/);
      assert.doesNotMatch(interim, /Them:/);
      assert.match(await evaluate("document.querySelector('#ts-list').textContent"), /Them.*discounted cash flow model/);
      console.log('PASS: independent You/Them interim rows; finalizing Them preserves the pending You utterance.');
      const result = await evaluate('window.veyra.addScreenshot()');
      assert.equal(result.screenshots, 1);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(await evaluate("document.querySelector('#screenshot-count').textContent"), '1 attached');
      await evaluate("document.querySelector('#clear-context').click()");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await evaluate('window.veyra.assistContext()')).screenshots, 0);
      assert.equal(await evaluate("document.querySelector('#screenshot-count').textContent"), '0 attached');
      const overflow = await evaluate("document.documentElement.scrollWidth > innerWidth");
      assert.equal(overflow, false, 'Overlay controls overflow horizontally');
      const screenshot = await contents.capturePage();
      fs.writeFileSync(path.join(__dirname, '..', '.cache', 'audio-assist-ui.png'), screenshot.toPNG());
      console.log('PASS: screenshot IPC, attachment count, Clear Context, and overlay layout.');
      // Exercise actual capture UI with a synthetic microphone, without opening
      // the user's microphone or sending audio to a cloud provider.
      await evaluate(`(() => {
        window.testMicContext = new AudioContext({ sampleRate: 16000 });
        window.testMicStream = window.testMicContext.createMediaStreamDestination().stream;
        navigator.mediaDevices.getUserMedia = async constraints => {
          window.testMicConstraints = constraints;
          return window.testMicStream;
        };
        document.querySelector('#stop-btn').click();
      })()`);
      await evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (document.querySelector('#mic-source-status').textContent === 'You: mic live') { clearInterval(timer); resolve(); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Mic capture did not start')); }
        }, 30);
      })`);
      await evaluate("document.querySelector('#mute-mic').click()");
      assert.equal(await evaluate('window.testMicStream.getAudioTracks()[0].enabled'), false);
      assert.equal(await evaluate("document.querySelector('#system-source-status').textContent"), 'Them: system audio live');
      await evaluate("document.querySelector('#mute-mic').click()");
      assert.equal(await evaluate('window.testMicStream.getAudioTracks()[0].enabled'), true);
      assert.deepEqual(await evaluate('window.testMicConstraints.audio.echoCancellation'), process.platform === 'win32' ? { exact: 'all' } : true);
      await evaluate("document.querySelector('#stop-btn').click()");
      console.log('PASS: microphone mute/unmute leaves Windows loopback running; echo cancellation enabled.');
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../main.js');
