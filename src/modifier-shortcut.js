const path = require('node:path');
const { spawn } = require('node:child_process');
class ModifierShortcut {
  constructor(options) { this.options = options; this.child = null; this.callback = null; this.suspended = false; }
  register(callback) {
    this.callback = callback;
    if (this.child) return true;
    const { isPackaged, resourcesPath, appPath } = this.options;
    const executable = path.join(isPackaged ? resourcesPath : path.join(appPath, '.cache'), 'window-runtime', 'Veyra.ModifierShortcut.exe');
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === 'say' && !this.suspended) this.callback?.();
      }
    });
    const failed = () => { if (this.child === child) { this.child = null; this.callback = null; this.options.onFailure?.(); } };
    child.once('error', failed); child.once('exit', failed); child.stdin.on('error', failed);
    return true;
  }
  unregister() { this.callback = null; }
  dispose() { const child = this.child; this.child = null; if (child) { child.stdin.end(); child.kill(); } }
}
module.exports = { ModifierShortcut };
