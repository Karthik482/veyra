const test = require('node:test');
const assert = require('node:assert/strict');
const { fitBounds, resizeBounds, moveBounds } = require('../src/window-geometry');
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const bounds = { x: 100, y: 100, width: 700, height: 600 };

test('restores an offscreen window within the current display', () => {
  assert.deepEqual(fitBounds({ x: 3000, y: -500, width: 700, height: 600 }, area),
    { x: 1220, y: 0, width: 700, height: 600 });
});
test('fits even displays smaller than the preferred minimum size', () => {
  assert.deepEqual(fitBounds(bounds, { x: -400, y: 0, width: 400, height: 300 }),
    { x: -400, y: 0, width: 400, height: 300 });
});
test('keyboard movement steps 24 pixels and stops at display boundaries', () => {
  assert.equal(moveBounds(bounds, 'right', area).x, 124);
  assert.equal(moveBounds({ ...bounds, x: 0 }, 'left', area).x, 0);
  assert.equal(moveBounds({ ...bounds, y: 440 }, 'down', area).y, 440);
});
test('northwest resize anchors the opposite corner', () => {
  assert.deepEqual(resizeBounds(bounds, 'nw', -50, -40, area),
    { x: 50, y: 60, width: 750, height: 640 });
});
test('shrinking clamps at the minimum without moving the opposite corner', () => {
  assert.deepEqual(resizeBounds(bounds, 'nw', 800, 800, area),
    { x: 240, y: 340, width: 560, height: 360 });
});
test('southeast resizing cannot cover the taskbar or leave the work area', () => {
  assert.deepEqual(resizeBounds(bounds, 'se', 3000, 3000, area),
    { x: 100, y: 100, width: 1820, height: 940 });
});
test('movement and resizing support monitors with negative coordinates', () => {
  const monitor = { x: -1920, y: -100, width: 1920, height: 1080 };
  const original = { ...bounds, x: -1800, y: 0 };
  assert.equal(moveBounds(original, 'left', monitor).x, -1824);
  assert.equal(resizeBounds(original, 'w', -1000, 0, monitor).x, -1920);
});
