// Full-resolution screenshot via desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  let img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const ratio = Math.min(1, 2560 / size.width, 1600 / size.height);
  if (ratio < 1) img = img.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio), quality: 'best' });
  return 'data:image/jpeg;base64,' + img.toJPEG(88).toString('base64');
}

module.exports = { captureScreenshot };
