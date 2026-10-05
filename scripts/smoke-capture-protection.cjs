// Windows desktop-capture exclusion test. Only numeric results are retained;
// a solid-color backdrop covers the sampled region. No audio or cloud calls.
const { app, BrowserWindow, desktopCapturer, screen, globalShortcut } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-protection-smoke-'));
app.setPath('userData', profile);
process.env.LOCALAPPDATA = profile;
delete process.env.VEYRA_NO_PROTECT;
const appLink = require('../vendor/app-link');
const OriginalServer = appLink.AppLinkServer;
appLink.AppLinkServer = class extends OriginalServer {
  constructor(options) { super({ ...options, appId: `${options.appId}.protection-smoke-${process.pid}` }); }
};
let started = false;
const callbacks = new Map();
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (key, callback) => { callbacks.set(key, callback); return register(key, callback); };
const timeout = setTimeout(() => { console.error('FAIL: capture protection test timed out'); app.exit(1); }, 60000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.on('browser-window-created', (_event, win) => {
  if (started) return;
  started = true;
  const contents = win.webContents;
  contents.setBackgroundThrottling(false);
  const evaluate = code => contents.executeJavaScript(code, true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  contents.once('did-finish-load', async () => {
    let backdrop;
    try {
      assert.equal(process.platform, 'win32', 'This test requires Windows');
      assert.equal(win.isContentProtected(), true, 'Veyra did not enable content protection on launch');
      const display = screen.getPrimaryDisplay();
      backdrop = new BrowserWindow({ ...display.workArea, frame: false, backgroundColor: '#00ff00', skipTaskbar: true,
        webPreferences: { backgroundThrottling: false } });
      backdrop.setAlwaysOnTop(true, 'floating');
      await backdrop.loadURL('data:text/html,<body style="margin:0;background:%2300ff00"></body>');
      const base = { x: display.workArea.x + 80, y: display.workArea.y + 80, width: 700, height: 600 };
      win.setBounds(base); win.show(); win.focus();
      await evaluate(`(() => {
        const marker = document.createElement('div');
        marker.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#ff00ff;pointer-events:none';
        document.body.append(marker);
      })()`);
      contents.invalidate();
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await evaluate(`(async () => {
        window.protectionTestStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        window.protectionTestVideo = document.createElement('video');
        window.protectionTestVideo.muted = true;
        window.protectionTestVideo.srcObject = window.protectionTestStream;
        await window.protectionTestVideo.play();
      })()`);
      const reports = [];
      async function sample(label, expected) {
        await pause(250);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)
        } });
        const source = sources.find(item => item.display_id === String(display.id));
        assert.ok(source && !source.thumbnail.isEmpty(), 'Desktop capture unavailable');
        const img = source.thumbnail;
        const size = img.getSize(), pixels = img.toBitmap(), bounds = win.getBounds();
        const sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
        const x0 = Math.round((bounds.x - display.bounds.x + 30) * sx);
        const y0 = Math.round((bounds.y - display.bounds.y + 30) * sy);
        const x1 = Math.round((bounds.x - display.bounds.x + bounds.width - 30) * sx);
        const y1 = Math.round((bounds.y - display.bounds.y + bounds.height - 30) * sy);
        let green = 0, magenta = 0, total = 0;
        for (let y = y0; y < y1; y += 8) for (let x = x0; x < x1; x += 8) {
          const i = (y * size.width + x) * 4;
          const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2];
          if (g > 220 && r < 35 && b < 35) green++;
          if (r > 220 && b > 220 && g < 35) magenta++;
          total++;
        }
        const report = { label, protected: win.isContentProtected(), bounds, green: green / total, magenta: magenta / total };
        if (report[expected] <= 0.98) console.log('Capture dimensions:', JSON.stringify({ size, bytes: pixels.length, bounds, display: display.bounds, sample: [...pixels.subarray((y0 * size.width + x0) * 4, (y0 * size.width + x0) * 4 + 4)] }));
        reports.push(report);
        assert.ok(report[expected] > 0.98, `${label}: ${JSON.stringify(report)}`);
        if (expected === 'green') { assert.equal(report.protected, true); assert.equal(magenta, 0); }
        console.log('PASS:', label, JSON.stringify(report));
        const videoReport = await evaluate(`(() => {
          const video = window.protectionTestVideo;
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(video, 0, 0);
          const bounds = ${JSON.stringify(bounds)}, display = ${JSON.stringify(display.bounds)};
          const sx = canvas.width / display.width, sy = canvas.height / display.height;
          const x = Math.round((bounds.x - display.x + 30) * sx), y = Math.round((bounds.y - display.y + 30) * sy);
          const width = Math.round((bounds.width - 60) * sx), height = Math.round((bounds.height - 60) * sy);
          const pixels = context.getImageData(x, y, width, height).data;
          let green = 0, magenta = 0, total = 0;
          for (let i = 0; i < pixels.length; i += 32) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            if (g > 220 && r < 35 && b < 35) green++;
            if (r > 220 && b > 220 && g < 35) magenta++;
            total++;
          }
          return { green: green / total, magenta: magenta / total };
        })()`);
        assert.ok(videoReport[expected] > 0.98, `${label} live video: ${JSON.stringify(videoReport)}`);
        if (expected === 'green') assert.equal(videoReport.magenta, 0);
        reports.push({ label: label + ' live video', ...videoReport });
        console.log('PASS:', label, 'live screen-sharing stream', JSON.stringify(videoReport));
      }
      // Positive control: prove the test can see Veyra when protection is off.
      win.setContentProtection(false);
      await sample('unprotected positive control', 'magenta');
      win.setContentProtection(true);
      await sample('protected before resize', 'green');
      for (const [dx, dy] of [[-30, -20], [-90, -60], [40, 30]]) {
        win.focus();
        win.setBounds(base);
        await evaluate(`window.veyra.resizeWindow({ phase: 'start', edge: 'se', screenX: ${base.x + 700}, screenY: ${base.y + 600} })`);
        await evaluate(`window.veyra.resizeWindow({ phase: 'move', screenX: ${base.x + 700} + ${dx}, screenY: ${base.y + 600} + ${dy} })`);
        await pause(100);
        assert.ok(Math.abs(win.getBounds().width - base.width - dx) <= 2, 'Resize width did not change as requested');
        assert.ok(Math.abs(win.getBounds().height - base.height - dy) <= 2, 'Resize height did not change as requested');
        await sample(`protected during resize ${dx},${dy}`, 'green');
        await evaluate("window.veyra.resizeWindow({ phase: 'end' })");
      }
      await evaluate("window.veyra.resizeWindow({ phase: 'end' })");
      await sample('protected after resize', 'green');
      const beforeMove = win.getSize();
      await callbacks.get('Control+Right')();
      await callbacks.get('Control+Down')();
      assert.deepEqual(win.getSize(), beforeMove, 'Protected movement changed window size');
      await sample('protected after movement', 'green');
      await evaluate('window.protectionTestStream.getTracks().forEach(track => track.stop())');
      fs.writeFileSync(path.join(__dirname, '..', '.cache', 'capture-protection-results.json'), JSON.stringify(reports, null, 2));
      clearTimeout(timeout);
      backdrop.destroy(); app.quit();
    } catch (error) {
      console.error(error);
      if (backdrop && !backdrop.isDestroyed()) backdrop.destroy();
      app.exit(1);
    }
  });
});
require('../main');
