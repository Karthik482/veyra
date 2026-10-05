// Opt-in acoustic check: plays a synthetic WAV through Windows speakers while
// measuring microphone and loopback energy. No microphone audio is saved/uploaded.
// electron scripts/probe-system-aec.cjs path/to/synthetic.wav
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const wav = path.resolve(process.argv[2] || '.cache/stt-synthetic.wav');
const output = path.resolve('.cache/system-aec-probe.json');
let player;
const timeout = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, done) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    done({ video: sources[0], audio: 'loopback' });
  });
  try {
    if (!fs.existsSync(wav)) throw new Error('Supply a synthetic speech WAV');
    await win.loadFile(path.resolve('renderer/permissions.html'));
    const rows = [];
    for (const mode of [false, true, 'all']) {
      await win.webContents.executeJavaScript(`(async () => {
        window.probeMic = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: { exact: ${JSON.stringify(mode)} }, noiseSuppression: true,
          autoGainControl: false, channelCount: 1
        }});
        window.probeLoop = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        probeLoop.getVideoTracks().forEach(t => t.stop());
        if (!probeLoop.getAudioTracks().length) throw new Error('No loopback track');
        window.probeCtx = new AudioContext();
        await probeCtx.resume();
        window.probeAnalysers = [probeMic, probeLoop].map(stream => {
          const analyser = probeCtx.createAnalyser(); analyser.fftSize = 2048;
          probeCtx.createMediaStreamSource(stream).connect(analyser);
          return analyser;
        });
      })()`, true);
      // Playback happens in a separate Windows process, as it would in YouTube.
      player = spawn('powershell.exe', ['-NoProfile', '-Command',
        "Add-Type -AssemblyName System; $player = New-Object System.Media.SoundPlayer($env:VEYRA_PROBE_WAV); $player.PlayLooping(); Start-Sleep -Seconds 15; $player.Stop()"],
      { windowsHide: true, env: { ...process.env, VEYRA_PROBE_WAV: wav }, stdio: 'ignore' });
      const result = await win.webContents.executeJavaScript(`(async () => {
        await new Promise(r => setTimeout(r, 2500));
        const energy = [0, 0]; const peaks = [0, 0]; let frames = 0;
        const data = new Float32Array(2048); const end = Date.now() + 7500;
        while (Date.now() < end) {
          probeAnalysers.forEach((a, i) => {
            a.getFloatTimeDomainData(data);
            for (const sample of data) { energy[i] += sample * sample; peaks[i] = Math.max(peaks[i], Math.abs(sample)); }
          });
          frames += data.length;
          await new Promise(r => setTimeout(r, 25));
        }
        const result = { negotiated: probeMic.getAudioTracks()[0].getSettings().echoCancellation,
          micRms: Math.sqrt(energy[0] / frames), loopbackRms: Math.sqrt(energy[1] / frames), peaks };
        [...probeMic.getTracks(), ...probeLoop.getTracks()].forEach(t => t.stop());
        await probeCtx.close(); return result;
      })()`, true);
      player.kill(); player = null;
      rows.push({ requested: mode, ...result });
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
    const report = { electron: process.versions.electron, chromium: process.versions.chrome, rows,
      reductionDb: 20 * Math.log10(rows[1].micRms / rows[2].micRms),
      note: 'Synthetic speaker playback; energy measurement, not speech recognition or double-talk acceptance.' };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { if (player) player.kill(); clearTimeout(timeout); }
});
app.on('will-quit', () => { if (player) player.kill(); });
