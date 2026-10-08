/* Window controls share the validated shortcut map owned by the main process. */
(function () {
  function acceleratorFromEvent(event) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(event.key)) return null;
    const key = ({ ' ': 'Space', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' })[event.key] ||
      (event.key.length === 1 ? event.key.toUpperCase() : event.key);
    return [event.ctrlKey && 'Control', event.metaKey && 'Super', event.altKey && 'Alt',
      event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }

  function init({ veyra, actions }) {
    const $ = selector => document.querySelector(selector);
    let hovered = null;
    document.addEventListener('mousemove', event => { hovered = event.target; });
    function scrollContent(direction) {
      const horizontal = direction === 'left' || direction === 'right';
      const canScroll = el => {
        if (!el?.getClientRects().length) return false;
        const style = getComputedStyle(el);
        return /auto|scroll|overlay/.test(horizontal ? style.overflowX : style.overflowY) &&
          (horizontal ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1);
      };
      const scrim = $('#settings-scrim');
      let root = scrim && !scrim.classList.contains('hidden') ? scrim : $('#panel');
      const sidebar = $('#transcript-sidebar');
      if (root === $('#panel') && sidebar && !sidebar.classList.contains('hidden') && sidebar.contains(hovered)) root = sidebar;
      if (!root?.getClientRects().length) return;
      let target = root.contains(hovered) ? hovered : null;
      while (target && target !== root && !canScroll(target)) target = target.parentElement;
      if (!canScroll(target)) target = null;
      if (!target) {
        const preferred = root === scrim ? root.querySelector('.s-tab-pane:not(.hidden)') : root.querySelector('#messages');
        if (!horizontal && canScroll(preferred)) target = preferred;
        if (!target) {
          const bounds = (preferred || root).getBoundingClientRect();
          const candidates = [...root.querySelectorAll(horizontal ? 'pre, textarea, .s-tab-pane, #messages' : '.s-tab-pane, .ts-list, #shortcut-list, textarea, #messages')]
            .filter(el => { const r = el.getBoundingClientRect(); return canScroll(el) && r.bottom > bounds.top && r.top < bounds.bottom; });
          target = candidates.at(-1) || (canScroll(root) ? root : null);
        }
      }
      if (target) {
        const step = Math.max(80, Math.min(240, (horizontal ? target.clientWidth : target.clientHeight) * 0.65));
        const amount = direction === 'up' || direction === 'left' ? -step : step;
        target.scrollBy({ left: horizontal ? amount : 0, top: horizontal ? 0 : amount, behavior: 'instant' });
      }
    }
    for (const direction of ['up', 'down', 'left', 'right']) actions['scroll' + direction[0].toUpperCase() + direction.slice(1)] = () => scrollContent(direction);
    let overview = null, draft = {}, recording = null, recordTimer = null, resizing = null;
    const format = value => (value || 'Disabled').replace(/CommandOrControl|CmdOrCtrl/g,
      veyra.platform === 'darwin' ? 'Cmd' : 'Ctrl').replace(/Control/g, 'Ctrl').replace(/Super/g,
      veyra.platform === 'darwin' ? 'Cmd' : 'Win').replace(/Return/g, 'Enter');
    function render() {
      const list = $('#shortcut-list');
      list.replaceChildren();
      if (!overview) return;
      for (const [action, label] of Object.entries(overview.labels)) {
        const row = document.createElement('div'); row.className = 'shortcut-row';
        const name = document.createElement('span'); name.textContent = label;
        const binding = document.createElement('kbd');
        binding.dataset.keybinding = action;
        binding.textContent = recording === action ? 'Press keys…' : format(draft[action]);
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.shortcut = action;
        button.textContent = recording === action ? 'Cancel' : 'Edit';
        button.setAttribute('aria-label', `${button.textContent} ${label} hotkey`);
        button.classList.toggle('recording', recording === action);
        if (draft[action] && draft[action] === overview.bindings[action] && !overview.registered[action]) {
          binding.title = 'Unavailable: another app may be using this hotkey';
          binding.classList.add('unavailable');
        }
        button.addEventListener('click', () => recording === action ? stopRecording() : startRecording(action));
        row.append(name, binding, button); list.append(row);
      }
    }
    function updateHints() {
      for (const [action, selector] of Object.entries({ assist: '#assist-shortcut-hint', say: '#say-shortcut-hint' })) {
        $(selector).textContent = overview.bindings[action] ? format(overview.bindings[action]) : '';
      }
      for (const [action, selector] of Object.entries({ quit: '#quit-btn', listening: '#stop-btn',
        screen: '#add-screenshot', hide: '#hide-btn', settings: '#more-btn' })) {
        $(selector).title = overview.labels[action] + (overview.bindings[action] ? ` (${format(overview.bindings[action])})` : '');
      }
    }
    async function stopRecording() {
      clearTimeout(recordTimer);
      recording = null;
      await veyra.shortcutsRecord(false);
      render();
    }
    async function startRecording(action) {
      await stopRecording();
      if (!(await veyra.shortcutsRecord(true))) return;
      recording = action;
      $('#shortcut-status').textContent = 'Press a combination. Escape cancels; Backspace disables.';
      render();
      recordTimer = setTimeout(() => { void stopRecording(); }, 25000);
    }
    document.addEventListener('keydown', event => {
      if (!recording) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') { void stopRecording(); return; }
      const value = event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        ? '' : acceleratorFromEvent(event);
      if (value === null) return;
      draft[recording] = value;
      $('#shortcut-status').textContent = 'Unsaved changes. Choose Apply hotkeys.';
      void stopRecording();
    }, true);
    document.addEventListener('pointerdown', event => {
      if (recording && !event.target.closest('[data-shortcut]')) void stopRecording();
    }, true);
    window.addEventListener('blur', () => { if (recording) void stopRecording(); });
    $('#shortcuts-reset').addEventListener('click', async () => {
      await stopRecording();
      if (!overview) return;
      draft = { ...overview.defaults }; render();
      $('#shortcut-status').textContent = 'Defaults selected. Choose Apply hotkeys.';
    });
    $('#shortcuts-apply').addEventListener('click', async () => {
      await stopRecording();
      const button = $('#shortcuts-apply'); button.disabled = true;
      try {
        const result = await veyra.shortcutsSet(draft);
        overview = result;
        if (result.ok) draft = { ...result.bindings };
        render(); updateHints();
        $('#shortcut-status').textContent = result.ok ? 'Hotkeys saved.' : result.error;
      } catch (error) { $('#shortcut-status').textContent = error.message; }
      finally { button.disabled = false; }
    });
    veyra.on('shortcuts:changed', value => { overview = value; render(); updateHints(); });
    veyra.on('shortcut:action', action => { if (!recording) actions[action]?.(); });
    veyra.shortcutsGet().then(value => {
      overview = value; draft = { ...value.bindings }; render(); updateHints();
    }).catch(error => { $('#shortcut-status').textContent = error.message; });

    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = document.createElement('div');
      handle.className = `window-resize window-resize-${edge}`;
      handle.dataset.edge = edge;
      handle.title = 'Drag to resize window';
      document.body.append(handle);
    }
    for (const handle of document.querySelectorAll('.window-resize')) {
      const edge = handle.dataset.edge;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizing = handle;
        handle.setPointerCapture(event.pointerId);
        veyra.resizeWindow({ phase: 'start', edge, screenX: event.screenX, screenY: event.screenY });
      });
      handle.addEventListener('pointermove', event => {
        if (resizing === handle) veyra.resizeWindow({ phase: 'move', screenX: event.screenX, screenY: event.screenY });
      });
      const end = () => {
        if (!resizing) return;
        resizing = null;
        veyra.resizeWindow({ phase: 'end' });
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
      window.addEventListener('blur', end);
    }
  }
  if (typeof module !== 'undefined') module.exports = { acceleratorFromEvent };
  else window.VeyraWindowControls = { init };
})();
