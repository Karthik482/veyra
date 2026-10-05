// Real Electron UI/IPC smoke with an isolated profile; no microphone or provider calls.
const { app, globalShortcut, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-window-smoke-'));
app.setPath('userData', profile);
process.env.VEYRA_NO_PROTECT = '1';
process.env.LOCALAPPDATA = profile;
const appLink = require('../vendor/app-link');
const OriginalServer = appLink.AppLinkServer;
appLink.AppLinkServer = class extends OriginalServer {
  constructor(options) { super({ ...options, appId: `${options.appId}.window-smoke-${process.pid}` }); }
};
const callbacks = new Map();
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (key, callback) => { callbacks.set(key, callback); return register(key, callback); };
const deadline = setTimeout(() => { console.error('FAIL: window smoke timed out'); app.exit(1); }, 30000);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.on('browser-window-created', (_event, win) => {
  const contents = win.webContents;
  contents.setBackgroundThrottling(false);
  const evaluate = code => contents.executeJavaScript(code, true);
  const until = expression => evaluate(`new Promise((resolve, reject) => {
    const limit = Date.now() + 5000;
    const timer = setInterval(() => {
      if (${expression}) { clearInterval(timer); resolve(); }
      else if (Date.now() > limit) { clearInterval(timer); reject(new Error('Timed out: ' + ${JSON.stringify(expression)})); }
    }, 25);
  })`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  contents.once('did-finish-load', async () => {
    try {
      await until("document.querySelectorAll('[data-shortcut]').length === 13");
      win.show(); win.focus();
      await evaluate("document.querySelector('#ob-skip').click(); document.querySelector('#more-btn').click(); document.querySelector('[data-tab=shortcuts]').click()");
      await until("!document.querySelector('[data-pane=shortcuts]').classList.contains('hidden')");
      assert.equal(await evaluate("document.querySelectorAll('.window-resize').length"), 8);
      const initial = await evaluate('window.veyra.shortcutsGet()');
      // Capture an actual renderer key event while global shortcuts are suspended.
      await evaluate("document.querySelector('[data-shortcut=assist]').click()");
      await until("document.querySelector('[data-shortcut=assist]').classList.contains('recording')");
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'F24', modifiers: ['control', 'alt'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'F24', modifiers: ['control', 'alt'] });
      await until("document.querySelector('[data-keybinding=assist]').textContent === 'Ctrl+Alt+F24'");
      await evaluate("document.querySelector('#shortcuts-apply').click()");
      await until("document.querySelector('#shortcut-status').textContent === 'Hotkeys saved.'");
      assert.equal((await evaluate('window.veyra.settingsGet()')).shortcuts.assist, 'Control+Alt+F24');
      assert.equal(await evaluate("document.querySelector('#assist-shortcut-hint').textContent"), 'Ctrl+Alt+F24');
      const conflict = await evaluate(`window.veyra.shortcutsSet({ ...${JSON.stringify(initial.bindings)}, assist: ${JSON.stringify(initial.bindings.quit)} })`);
      assert.equal(conflict.ok, false);
      assert.equal((await evaluate('window.veyra.shortcutsGet()')).bindings.assist, 'Control+Alt+F24');
      await evaluate("document.querySelector('[data-shortcut=say]').click()");
      await until("document.querySelector('[data-shortcut=say]').classList.contains('recording')");
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await until("!document.querySelector('[data-shortcut=say]').classList.contains('recording')");
      assert.equal(await evaluate("document.querySelector('#settings-scrim').classList.contains('hidden')"), false);
      assert.equal((await evaluate('window.veyra.shortcutsGet()')).bindings.say, initial.bindings.say);
      await evaluate("document.querySelector('[data-shortcut=leetcode]').click()");
      await until("document.querySelector('[data-shortcut=leetcode]').classList.contains('recording')");
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      await until("document.querySelector('[data-keybinding=leetcode]').textContent === 'Disabled'");
      await evaluate("document.querySelector('#shortcuts-apply').click()");
      await until("document.querySelector('#shortcut-status').textContent === 'Hotkeys saved.'");
      assert.equal((await evaluate('window.veyra.settingsGet()')).shortcuts.leetcode, '');
      assert.equal(globalShortcut.isRegistered(initial.bindings.leetcode), false);
      console.log('PASS: real hotkey recording, registration, saved settings, live hints and conflict rejection.');
      contents.invalidate();
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await pause();
      fs.writeFileSync(path.join(__dirname, '..', '.cache', 'hotkeys-ui.png'), (await contents.capturePage()).toPNG());
      await evaluate("document.querySelector('#s-close').click()");
      await until("document.querySelector('#settings-scrim').classList.contains('hidden')");
      contents.invalidate();
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(__dirname, '..', '.cache', 'meeting-controls-ui.png'), (await contents.capturePage()).toPNG());
      assert.equal(await evaluate("document.querySelector('#input, #input-area, #placeholder, #send-btn')"), null);
      assert.equal(await evaluate("document.querySelector('#resize-grip')"), null);
      for (const id of ['smart-toggle', 'history-btn', 'more-btn']) {
        assert.equal(await evaluate(`document.querySelector('#${id}').getBoundingClientRect().width > 0`), true);
      }
      await evaluate("document.querySelector('#smart-toggle').click()");
      await until("document.querySelector('#smart-toggle').classList.contains('on')");
      assert.equal((await evaluate('window.veyra.settingsGet()')).smart, true);
      await evaluate("document.querySelector('#history-btn').click()");
      assert.equal(await evaluate("document.querySelector('#transcript-sidebar').classList.contains('hidden')"), false);
      await evaluate("document.querySelector('#close-sidebar-btn').click()");
      console.log('PASS: typing area and labeled Resize button removed; Smart, history and Settings remain functional.');
      // Main-process movement callback, using the same callback registered with Windows.
      win.setBounds({ x: 100, y: 100, width: 700, height: 600 });
      win.focus();
      await callbacks.get('Control+Right')();
      await pause();
      assert.equal(win.getBounds().x, 124, await evaluate("document.querySelector('#veyra-status')?.textContent || 'Native move did not update position'"));
      await callbacks.get('Control+Left')();
      assert.equal(win.getBounds().x, 100);
      await callbacks.get('Control+Down')();
      assert.equal(win.getBounds().y, 124);
      await callbacks.get('Control+Up')();
      assert.equal(win.getBounds().y, 100);
      for (const [width, height] of [[700, 600], [613, 547]]) {
        win.setSize(width, height);
        const initialSize = win.getSize();
        for (let i = 0; i < 30; i++) for (const direction of ['Right', 'Down', 'Left', 'Up']) {
          await callbacks.get(`Control+${direction}`)();
          assert.deepEqual(win.getSize(), initialSize, `Size drift on move ${i} ${direction}`);
        }
      }
      console.log('PASS: 240 arrow moves at two window sizes preserve the exact window dimensions.');
      win.setSize(700, 600);
      const before = win.getBounds();
      await pause();
      // The outer southeast handle remains after removing the labeled Resize button.
      await evaluate('window.veyra.setIgnoreMouse(false)');
      const grip = await evaluate("(() => { const r = document.querySelector('.window-resize-se').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
      contents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, globalX: before.x + grip.x, globalY: before.y + grip.y, button: 'left', clickCount: 1 });
      await pause();
      contents.sendInputEvent({ type: 'mouseMove', x: grip.x - 50, y: grip.y - 40, globalX: before.x + grip.x - 50, globalY: before.y + grip.y - 40 });
      await pause();
      contents.sendInputEvent({ type: 'mouseUp', x: grip.x - 50, y: grip.y - 40, button: 'left', clickCount: 1 });
      await pause();
      const resized = win.getBounds();
      assert.ok(resized.width < before.width && resized.height < before.height, 'Pointer drag did not resize window');
      await evaluate(`window.veyra.settingsSet({ windowX: 9999, windowWidth: 9999 })`);
      const saved = await evaluate('window.veyra.settingsGet()');
      assert.equal(saved.windowWidth, resized.width);
      assert.equal(saved.windowX, resized.x);
      console.log('PASS: keyboard movement, pointer resize and persisted geometry protected from stale settings.');
      for (const [width, height] of [[560, 360], [900, 750]]) {
        const area = screen.getDisplayMatching(win.getBounds()).workArea;
        win.setBounds({ x: area.x, y: area.y, width, height });
        await pause();
        await evaluate("document.querySelector('#panel-wrap').classList.add('sidebar-open'); document.querySelector('#transcript-sidebar').classList.remove('hidden')");
        const metrics = await evaluate(`(() => {
          const panel = document.querySelector('#panel').getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > innerWidth,
            panelOverflow: document.querySelector('#panel').scrollWidth > document.querySelector('#panel').clientWidth,
            visible: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight };
        })()`);
        assert.deepEqual(metrics, { overflow: false, panelOverflow: false, visible: true }, `Layout at ${width}x${height}`);
      }
      console.log('PASS: minimum and expanded layouts keep the panel visible without horizontal overflow.');
      await evaluate("document.querySelector('#more-btn').click(); document.querySelector('[data-tab=shortcuts]').click()");
      await until("!document.querySelector('[data-pane=shortcuts]').classList.contains('hidden')");
      for (const [width, height] of [[560, 360], [700, 600], [900, 750]]) {
        win.setSize(width, height);
        await pause();
        const layout = await evaluate(`(() => {
          const settings = document.querySelector('#settings');
          const r = settings.getBoundingClientRect();
          const apply = document.querySelector('#shortcuts-apply').getBoundingClientRect();
          const pane = document.querySelector('[data-pane=shortcuts]');
          return { visible: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            overflow: settings.scrollWidth > settings.clientWidth || pane.scrollWidth > pane.clientWidth,
            applyVisible: apply.bottom <= r.bottom && apply.top >= r.top };
        })()`);
        assert.deepEqual(layout, { visible: true, overflow: false, applyVisible: true }, `Settings at ${width}x${height}`);
      }
      console.log('PASS: spacious Settings and hotkey Apply controls fit all tested window sizes.');
      win.setSize(560, 360);
      await pause();
      for (const tab of ['keys', 'transcription', 'profile', 'prep', 'style', 'qa']) {
        await evaluate(`document.querySelector('[data-tab=${tab}]').click()`);
        await until(`!document.querySelector('[data-pane=${tab}]').classList.contains('hidden')`);
        assert.equal(await evaluate(`(() => { const p = document.querySelector('[data-pane=${tab}]'); return p.scrollWidth > p.clientWidth; })()`), false, `Horizontal overflow in ${tab}`);
      }
      console.log('PASS: all Settings panels remain usable at minimum window size.');
      clearTimeout(deadline); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../main');
