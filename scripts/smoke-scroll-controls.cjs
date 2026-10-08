// Real Windows hotkeys against an unfocused Electron window; synthetic content only.
const { app, BrowserWindow, globalShortcut } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process');
const resultFile = path.join(__dirname, '..', '.cache', 'scroll-smoke-result.json');
fs.writeFileSync(resultFile, JSON.stringify({ status: 'running' }));
const report = result => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-scroll-smoke-'));
app.setPath('userData', profile);
process.env.LOCALAPPDATA = profile;
const link = require('../vendor/app-link'), OriginalServer = link.AppLinkServer;
link.AppLinkServer = class extends OriginalServer {
  constructor(options) { super({ ...options, appId: `${options.appId}.scroll-smoke-${process.pid}` }); }
};
const deadline = setTimeout(() => { report({ status: 'failed', error: 'Scroll smoke timed out' }); app.exit(1); }, 60000);
let started = false;
const keySource = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ScrollTestKeys {
 [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[ScrollTestKeys]::keybd_event(18,0,0,[UIntPtr]::Zero)
[ScrollTestKeys]::keybd_event(KEY,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 70
[ScrollTestKeys]::keybd_event(KEY,0,2,[UIntPtr]::Zero)
[ScrollTestKeys]::keybd_event(18,0,2,[UIntPtr]::Zero)`;
const press = key => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', keySource.replaceAll('KEY', String(key))],
  { windowsHide: true }, error => error ? reject(error) : resolve()));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, win) => {
  if (started) return; started = true;
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  win.webContents.once('did-finish-load', async () => {
    let foreground;
    try {
      assert.equal(process.platform, 'win32');
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await evaluate("document.querySelectorAll('[data-shortcut]').length === 17")) break;
        await pause(100);
      }
      await evaluate("document.querySelector('#ob-skip').click()");
      const shortcuts = await evaluate('window.veyra.shortcutsGet()');
      for (const direction of ['Up', 'Down', 'Left', 'Right']) {
        assert.equal(shortcuts.bindings['scroll' + direction], 'Alt+' + direction);
        assert.equal(globalShortcut.isRegistered('Alt+' + direction), true);
      }
      await evaluate(`(() => {
        const m = document.querySelector('#messages'); m.replaceChildren();
        for (let i=0; i<35; i++) { const p = document.createElement('p'); p.textContent = 'Synthetic answer line ' + i; m.append(p); }
        m.scrollTop=0;
      })()`);
      foreground = new BrowserWindow({ width: 280, height: 120, title: 'Veyra scroll test', webPreferences: { nodeIntegration: false } });
      await foreground.loadURL('data:text/html,<body>Testing Veyra scrolling without changing focus.</body>');
      foreground.show(); foreground.focus(); await pause(150);
      const bounds = win.getBounds();
      assert.equal(win.isFocused(), false);
      await press(40); await pause(100);
      const down = await evaluate("document.querySelector('#messages').scrollTop");
      assert.ok(down > 0, 'Alt+Down did not scroll answers');
      await press(38); await pause(100);
      assert.ok(await evaluate("document.querySelector('#messages').scrollTop") < down, 'Alt+Up did not scroll back');
      await evaluate(`(() => {
        const m=document.querySelector('#messages'); m.replaceChildren();
        const div=document.createElement('div'); div.className='ai-text';
        const pre=document.createElement('pre'); pre.id='scroll-test-code'; pre.textContent='long_code_token_'.repeat(150);
        div.append(pre);m.append(div);m.scrollTop=0;
      })()`);
      await press(39); await pause(100);
      const right = await evaluate("document.querySelector('#scroll-test-code').scrollLeft");
      assert.ok(right > 0, 'Alt+Right did not scroll wide code');
      await press(37); await pause(100);
      assert.ok(await evaluate("document.querySelector('#scroll-test-code').scrollLeft") < right, 'Alt+Left did not scroll back');
      assert.deepEqual(win.getBounds(), bounds, 'Scrolling moved/resized Veyra');
      assert.equal(foreground.isFocused(), true, 'Scrolling stole focus');
      await evaluate("document.querySelector('#more-btn').click(); document.querySelector('[data-tab=keys]').click()");
      await pause(100);
      const before = await evaluate("document.querySelector('[data-pane=keys]').scrollTop");
      await press(40); await pause(100);
      assert.ok(await evaluate("document.querySelector('[data-pane=keys]').scrollTop") > before, 'Alt+Down did not scroll Settings');
      await evaluate("document.querySelector('[data-tab=shortcuts]').click()");
      await pause(100);
      await press(40); await pause(100);
      assert.ok(await evaluate("document.querySelector('#shortcut-list').scrollTop") > 0, 'Alt+Down did not scroll the nested Hotkeys list');
      console.log('PASS: all four real Alt+arrow hotkeys scroll answers/code/Settings without moving Veyra or stealing foreground focus.');
      report({ status: 'passed', hotkeys: ['Alt+Up', 'Alt+Down', 'Alt+Left', 'Alt+Right'], answers: true, code: true, settings: true, windowUnchanged: true, foregroundFocusPreserved: true });
      clearTimeout(deadline); foreground.destroy(); app.quit();
    } catch (error) { report({ status: 'failed', error: error.message }); console.error(error); foreground?.destroy(); app.exit(1); }
  });
});
require('../main');
