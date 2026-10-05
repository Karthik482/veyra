const MIN_WIDTH = 560, MIN_HEIGHT = 360, MOVE_STEP = 24;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function fitBounds(bounds, area) {
  const width = clamp(Math.round(bounds.width), Math.min(MIN_WIDTH, area.width), area.width);
  const height = clamp(Math.round(bounds.height), Math.min(MIN_HEIGHT, area.height), area.height);
  return { x: clamp(Math.round(bounds.x), area.x, area.x + area.width - width),
    y: clamp(Math.round(bounds.y), area.y, area.y + area.height - height), width, height };
}
function moveBounds(bounds, direction, area) {
  const [dx, dy] = { up: [0, -MOVE_STEP], down: [0, MOVE_STEP], left: [-MOVE_STEP, 0], right: [MOVE_STEP, 0] }[direction] || [0, 0];
  return fitBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, area);
}
function resizeBounds(bounds, edge, dx, dy, area) {
  let left = bounds.x, top = bounds.y, right = left + bounds.width, bottom = top + bounds.height;
  const minW = Math.min(MIN_WIDTH, area.width), minH = Math.min(MIN_HEIGHT, area.height);
  if (edge.includes('w')) left = clamp(left + dx, area.x, right - minW);
  if (edge.includes('e')) right = clamp(right + dx, left + minW, area.x + area.width);
  if (edge.includes('n')) top = clamp(top + dy, area.y, bottom - minH);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH, area.y + area.height);
  return fitBounds({ x: left, y: top, width: right - left, height: bottom - top }, area);
}
module.exports = { MIN_WIDTH, MIN_HEIGHT, MOVE_STEP, fitBounds, moveBounds, resizeBounds };
