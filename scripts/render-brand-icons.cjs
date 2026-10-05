// Generate PNG and multi-resolution ICO assets from the original Veyra SVG.
// Run with Electron, using only a hidden local renderer.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadURL('data:text/html,<html><body></body></html>');
    const svg = fs.readFileSync(path.join(__dirname, '../renderer/assets/veyra.svg'), 'utf8');
    const images = [];
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const url = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
        await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size}); return canvas.toDataURL('image/png');
      })()`);
      const data = Buffer.from(url.split(',')[1], 'base64');
      if (size === 512) fs.writeFileSync(path.join(__dirname, '../build-resources/icon.png'), data);
      else images.push({ size, data });
    }
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, data }, i) => {
      const at = 6 + i * 16;
      header[at] = header[at + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += data.length;
    });
    fs.writeFileSync(path.join(__dirname, '../build-resources/icon.ico'), Buffer.concat([header, ...images.map(i => i.data)]));
    console.log('Generated Veyra PNG and multi-resolution ICO.');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
