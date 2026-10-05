const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function prepareWindowRuntime() {
  if (process.platform !== 'win32') return null;
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'src', 'native', 'window-mover.cs');
  const output = path.join(root, '.cache', 'window-runtime', 'Veyra.WindowMover.exe');
  const stamp = output + '.sha256';
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (fs.existsSync(output) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return output;
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Building Windows movement support requires the Windows .NET Framework compiler.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:' + output, source], { windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(stamp, hash);
  return output;
}
if (require.main === module) console.log(prepareWindowRuntime() || 'Windows movement runtime is not needed on this platform.');
module.exports = { prepareWindowRuntime };
