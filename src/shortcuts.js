// Configurable global shortcuts. Kept dependency-free so it is unit-testable.
// Accelerator strings follow Electron's format, e.g. 'CommandOrControl+Return'.

const ACTIONS = {
  assist: ['Assist', 'CommandOrControl+Return'],
  say: ['What should I say?', 'CommandOrControl+Shift+Return'],
  leetcode: ['Solve coding problem', 'CommandOrControl+H'],
  hide: ['Hide / show panel', 'CommandOrControl+Shift+/'],
  listening: ['Start / stop listening', 'CommandOrControl+Shift+L'],
  screen: ['Attach screenshot', 'CommandOrControl+Shift+S'],
  forceAnswer: ['Answer current question', 'CommandOrControl+Shift+A'],
  settings: ['Open settings', 'CommandOrControl+,'],
  moveUp: ['Move window up', 'Control+Up'],
  moveDown: ['Move window down', 'Control+Down'],
  moveLeft: ['Move window left', 'Control+Left'],
  moveRight: ['Move window right', 'Control+Right'],
  quit: ['Quit Veyra', 'CommandOrControl+Shift+X']
};
const DEFAULTS = Object.fromEntries(Object.entries(ACTIONS).map(([key, value]) => [key, value[1]]));
const MODIFIERS = { commandorcontrol: 'primary', cmdorctrl: 'primary', control: 'ctrl', ctrl: 'ctrl',
  command: 'cmd', cmd: 'cmd', alt: 'alt', option: 'alt', shift: 'shift', super: 'super', meta: 'super' };
const KEYS = new Set(['return', 'enter', 'space', 'tab', 'escape', 'esc', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'plus', 'comma', 'period', 'slash', 'backslash']);

// Every action that maps to a shortcut. Values = defaults; can be overridden via settings.
function resolveShortcuts(overrides = {}) {
  const out = {};
  for (const [action, def] of Object.entries(DEFAULTS)) {
    const v = typeof overrides?.[action] === 'string' ? overrides[action].trim() : def;
    out[action] = v;
  }
  return out;
}

// Detect collisions between configured accelerators (a global shortcut can only be
// registered once). Returns an array of [actionA, actionB, accelerator] pairs.
function findConflicts(map, platform = process.platform) {
  const seen = new Map();
  const conflicts = [];
  for (const [action, accel] of Object.entries(map)) {
    if (!accel) continue;
    const key = canonical(accel, platform);
    if (seen.has(key)) conflicts.push([seen.get(key), action, accel]);
    else seen.set(key, action);
  }
  return conflicts;
}

// Basic validity check: must contain at least a non-modifier key and plausible modifiers.
function isValid(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return false;
  const parts = accel.toLowerCase().split('+').map(s => s.trim());
  const key = parts.pop();
  if (!key || !(KEYS.has(key) || /^[a-z0-9,./;\[\]'\\=\-`]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key))) return false;
  const modifiers = parts.map(p => MODIFIERS[p]);
  return modifiers.every(Boolean) && new Set(modifiers).size === modifiers.length;
}

function canonical(accel, platform = process.platform) {
  const parts = accel.toLowerCase().split('+').map(s => s.trim());
  let key = parts.pop();
  key = ({ enter: 'return', esc: 'escape', comma: ',', period: '.', slash: '/', backslash: '\\' })[key] || key;
  const modifiers = parts.map(p => {
    const m = MODIFIERS[p];
    return m === 'primary' ? (platform === 'darwin' ? 'cmd' : 'ctrl') : m === 'super' && platform === 'darwin' ? 'cmd' : m;
  });
  return [...new Set(modifiers)].sort().concat(key).join('+');
}
function validate(map) {
  for (const [action, value] of Object.entries(map)) {
    if (value && !isValid(value)) return `Invalid hotkey for ${ACTIONS[action][0]}. Use a combination such as Ctrl+Alt+J.`;
  }
  const conflict = findConflicts(map)[0];
  return conflict ? `${ACTIONS[conflict[0]][0]} and ${ACTIONS[conflict[1]][0]} use the same hotkey.` : null;
}
class ShortcutManager {
  constructor(api, actions) { this.api = api; this.actions = actions; this.map = {}; this.status = {}; }
  register(map) {
    this.api.unregisterAll();
    this.map = { ...map }; this.status = {};
    for (const [action, accelerator] of Object.entries(map)) {
      try { this.status[action] = !!accelerator && this.api.register(accelerator, this.actions[action]); }
      catch { this.status[action] = false; }
    }
  }
  apply(overrides) {
    const next = resolveShortcuts(overrides), error = validate(next);
    if (error) return { ok: false, error };
    const previous = this.map, previousStatus = this.status;
    this.register(next);
    // Unchanged bindings already unavailable at startup don't block other edits.
    const failed = Object.keys(next).find(key => next[key] && !this.status[key] &&
      (next[key] !== previous[key] || previousStatus[key]));
    if (failed) {
      this.register(previous);
      return { ok: false, error: `${ACTIONS[failed][0]}: ${next[failed]} is unavailable or reserved by another app. Previous hotkeys restored.` };
    }
    return { ok: true };
  }
}
module.exports = { ACTIONS, DEFAULTS, resolveShortcuts, findConflicts, isValid, canonical, validate, ShortcutManager };
