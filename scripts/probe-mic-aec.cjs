// Opt-in hardware probe. Reports what the microphone pipeline ACTUALLY negotiated
// on this machine, rather than what veyra asked for.
//
//   npx electron scripts/probe-mic-aec.cjs
//
// Opens the default input device for well under a second, reads the track's
// settings/constraints/capabilities and stops it. No audio is captured to disk,
// logged, or uploaded anywhere. The result is written to .cache/mic-aec-probe.json.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.join(__dirname, '..', '.cache');
const HTML = path.join(CACHE, 'mic-aec-probe.html');
const OUTPUT = path.join(CACHE, 'mic-aec-probe.json');

// Exactly the constraints veyra's renderer requests for a headphone-free setup.
const PROBE = `(async () => {
  const read = fn => { try { return fn(); } catch (error) { return { error: String(error && error.message) }; } };
  const supported = read(() => navigator.mediaDevices.getSupportedConstraints()) || {};
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'audioinput');
  const outputs = devices.filter(d => d.kind === 'audiooutput');
  const { stream, requested, fallback } = await VeyraMicrophone.openMicrophone(navigator.mediaDevices, { platform: '${process.platform}' });
  const track = stream.getAudioTracks()[0];
  const settings = read(() => track.getSettings()) || {};
  const report = {
    userAgent: navigator.userAgent,
    supportedConstraintNames: Object.keys(supported).filter(name => supported[name] === true),
    processingConstraintsSupported: ['echoCancellation', 'echoCancellationType', 'noiseSuppression', 'autoGainControl'].filter(name => supported[name] === true),
    requested,
    fallback,
    device: { label: track.label, deviceId: settings.deviceId || null },
    settings,
    constraints: read(() => track.getConstraints()),
    capabilities: read(() => (typeof track.getCapabilities === 'function' ? track.getCapabilities() : null)),
    defaultInputGroupId: inputs[0] ? inputs[0].groupId : null,
    defaultOutput: outputs[0] ? { label: outputs[0].label, groupId: outputs[0].groupId } : null,
    inputEndpoints: inputs.map(d => ({ label: d.label, groupId: d.groupId })),
    outputEndpoints: outputs.map(d => ({ label: d.label, groupId: d.groupId }))
  };
  stream.getTracks().forEach(t => t.stop());
  return report;
})()`;

app.whenReady().then(async () => {
  const allow = permission => permission === 'media' || permission === 'microphone' || permission === 'audioCapture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));

  // file:// is a secure context, which navigator.mediaDevices requires.
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(HTML, '<!doctype html><meta charset="utf-8"><title>veyra mic probe</title>');

  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(HTML);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'microphone-capture.js'), 'utf8'));
    const report = await win.webContents.executeJavaScript(PROBE, true);
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log('PROBE WROTE ' + OUTPUT);
    console.log('PROBE RESULT ' + JSON.stringify(report));
  } catch (error) {
    console.error('PROBE FAILED: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  }
  app.quit();
});
app.on('window-all-closed', () => app.quit());
