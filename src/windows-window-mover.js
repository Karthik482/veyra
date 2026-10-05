const path = require('node:path');
const { spawn } = require('node:child_process');
class WindowsWindowMover {
  constructor({ isPackaged, resourcesPath, appPath }) {
    this.executable = path.join(isPackaged ? resourcesPath : path.join(appPath, '.cache'), 'window-runtime', 'Veyra.WindowMover.exe');
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
  }
  start() {
    if (this.child) return;
    const child = spawn(this.executable, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const [id, status, width, height] = buffer.slice(0, end).trim().split('|');
        buffer = buffer.slice(end + 1);
        const request = this.pending.get(Number(id));
        if (!request) continue;
        this.pending.delete(Number(id)); clearTimeout(request.timer);
        if (status === 'ok') request.resolve({ width: Number(width), height: Number(height) });
        else request.reject(new Error(width || 'Window movement failed.'));
      }
    });
    const fail = () => {
      if (this.child === child) this.child = null;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Window movement helper unavailable. Restart Veyra or rebuild its Windows runtime.')); }
      this.pending.clear();
    };
    child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail);
  }
  move(win, direction) {
    if (!['left', 'right', 'up', 'down'].includes(direction)) return Promise.reject(new Error('Invalid movement direction.'));
    this.start();
    const id = ++this.sequence;
    const bytes = win.getNativeWindowHandle();
    const handle = bytes.length === 8 ? bytes.readBigUInt64LE().toString() : String(bytes.readUInt32LE());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Window movement timed out.')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${id}|${handle}|${direction}\n`);
    });
  }
  dispose() { if (this.child) { this.child.stdin.end(); this.child.kill(); this.child = null; } }
}
module.exports = { WindowsWindowMover };
