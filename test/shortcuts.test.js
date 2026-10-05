const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, resolveShortcuts, findConflicts, isValid } = require('../src/shortcuts');
const { ShortcutManager } = require('../src/shortcuts');
const { acceleratorFromEvent } = require('../renderer/window-controls');

test('disabled hotkeys remain disabled after resolving settings', () => {
  assert.strictEqual(resolveShortcuts({ assist: '' }).assist, '');
});
test('collisions account for platform modifiers, key aliases, and modifier ordering', () => {
  assert.strictEqual(findConflicts({ a: 'CommandOrControl+Shift+Return', b: 'Shift+Ctrl+Enter' }, 'win32').length, 1);
  assert.strictEqual(findConflicts({ a: 'CommandOrControl+,', b: 'Super+Comma' }, 'darwin').length, 1);
  assert.strictEqual(findConflicts({ a: 'Command+H', b: 'Control+H' }, 'darwin').length, 0);
});
test('hotkey recorder translates arrows, space, plus and modifier-only presses', () => {
  assert.strictEqual(acceleratorFromEvent({ key: 'ArrowUp', ctrlKey: true }), 'Control+Up');
  assert.strictEqual(acceleratorFromEvent({ key: '+', ctrlKey: true, shiftKey: true }), 'Control+Shift+Plus');
  assert.strictEqual(acceleratorFromEvent({ key: ' ', metaKey: true }), 'Super+Space');
  assert.strictEqual(acceleratorFromEvent({ key: 'Control', ctrlKey: true }), null);
});
function manager(blocked = new Set()) {
  const registered = new Map();
  const api = {
    unregisterAll() { registered.clear(); },
    register(key, callback) { if (blocked.has(key)) return false; registered.set(key, callback); return true; }
  };
  const instance = new ShortcutManager(api, Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, () => key])));
  instance.register(resolveShortcuts());
  return { instance, registered };
}
test('a changed hotkey unregisters the old binding and retains its action', () => {
  const { instance, registered } = manager();
  assert.strictEqual(instance.apply({ assist: 'Control+Alt+J' }).ok, true);
  assert.strictEqual(registered.has(DEFAULTS.assist), false);
  assert.strictEqual(registered.get('Control+Alt+J')(), 'assist');
});
test('invalid or conflicting hotkeys leave existing registrations untouched', () => {
  const { instance, registered } = manager();
  for (const assist of ['Ctrl+FakeKey', DEFAULTS.quit]) {
    assert.strictEqual(instance.apply({ assist }).ok, false);
    assert.strictEqual(registered.get(DEFAULTS.assist)(), 'assist');
  }
});
test('unavailable replacement rolls back all hotkeys', () => {
  const { instance, registered } = manager(new Set(['Control+Alt+J']));
  assert.strictEqual(instance.apply({ assist: 'Control+Alt+J', say: 'Control+Alt+K' }).ok, false);
  assert.deepStrictEqual(instance.map, DEFAULTS);
  assert.strictEqual(registered.get(DEFAULTS.say)(), 'say');
  assert.strictEqual(registered.has('Control+Alt+K'), false);
});
test('preexisting unavailable bindings do not block unrelated changes', () => {
  const { instance } = manager(new Set([DEFAULTS.hide]));
  assert.strictEqual(instance.status.hide, false);
  assert.strictEqual(instance.apply({ assist: 'Control+Alt+J' }).ok, true);
});
test('disabled hotkeys are unregistered', () => {
  const { instance, registered } = manager();
  assert.strictEqual(instance.apply({ assist: '' }).ok, true);
  assert.strictEqual(registered.has(DEFAULTS.assist), false);
  assert.strictEqual(instance.status.assist, false);
});

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Return');
  assert.ok(DEFAULTS.leetcode);
  assert.ok(DEFAULTS.quit);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+L' });
  assert.strictEqual(map.leetcode, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'leetcode') || (a === 'leetcode' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});
