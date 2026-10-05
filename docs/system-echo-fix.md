# Windows speaker echo correction — September 19, 2026

This resumes the interrupted September 18 task: YouTube played through laptop
speakers was still transcribed as both You and Them. It builds on the restored
previous version requested by the user, rather than restoring the reverted UI work.

## Cause and correction

Electron 33.2.1 / Chromium 130 ignored `echoCancellationType: 'system'`. Its
negotiated `echoCancellation: true` did not cancel playback from external apps on
this machine. The transcript filter could only try to remove duplicates after
recognition; it could not separate the input audio.

The app now pins Electron 42.11.6 / Chromium 148 and requests
`echoCancellation: { exact: 'all' }` on Windows. Chromium's all-system playback
reference cancels speaker leakage before the microphone reaches transcription.
The system loopback channel continues to receive the original playback.

`renderer/microphone-capture.js` holds the shared capture code. Only an
`OverconstrainedError` specifically for echo cancellation permits fallback to
ordinary cancellation. Missing microphones, denied permission and busy devices
retain their original errors. The selected microphone is preserved on fallback.
Other platforms keep their existing boolean request.

Settings → Audio uses the track's actual settings to show **Speaker echo
cancellation active**, or an explicit unavailable message. A requested constraint
alone is not treated as proof of success.

References: [Chrome 141's new cancellation modes](https://developer.chrome.com/release-notes/141),
[Electron's reported Windows boolean-cancellation issue](https://github.com/electron/electron/issues/47043).

## Measured on this laptop

Default devices: Realtek speakers and Realtek microphone array. A synthetic speech
WAV played through a separate Windows SoundPlayer process; Electron measured the
microphone and system loopback in memory. No microphone recording was saved or
uploaded. Each mode had a 2.5-second warm-up and 7.5-second measurement.

| Cancellation requested | Microphone RMS | System loopback RMS |
| --- | ---: | ---: |
| Disabled | 0.019262 | 0.125085 |
| Ordinary (`true`) | 0.019847 | 0.127221 |
| All system playback (`all`) | 0.00008784 | 0.128682 |

Microphone energy dropped **47.08 dB** relative to ordinary cancellation; playback
remained present in the Them feed. The final shared capture code separately
negotiated `echoCancellation: "all"`, with no fallback.

Raw numeric reports are in `.cache/system-aec-probe.json` and
`.cache/mic-aec-probe.json`. Reproduce with:

```powershell
npx electron scripts/probe-mic-aec.cjs
npx electron scripts/probe-system-aec.cjs path/to/synthetic-speech.wav
```

The acoustic probe plays audible sound and opens the default microphone. Keep
speaker volume and room conditions steady while comparing its modes.

## Validation and delivery

- Full Node regression suite: **189 passed, zero failed**.
- Real Electron 42.11.6 smoke: live Windows loopback, separate You/Them display,
  screenshot/Clear Context controls, overlay width and mic mute/unmute passed.
- Shared capture helper confirmed `all` on the real default microphone.
- Quit-button smoke passed; all 51 packaged runtime source files match the
  workspace byte-for-byte.
- JavaScript syntax and Git whitespace checks passed.
- Windows installer is built with the newer runtime and bundled Whisper runtime;
  see `dist/veyra-win-x64.exe`.

### Follow-up: installed copy verified

After the user reported continued duplicates, inspection found both the desktop
and Start-menu shortcuts targeting `%LOCALAPPDATA%/Programs/veyra/veyra.exe`. That
installation still contained September 17 files and lacked
`renderer/microphone-capture.js`; it did not contain this correction.

On September 19 the new installer was run successfully (exit code 0). All 51
installed runtime source files matched the workspace. The installed app was then
launched and reported Electron 42.11.6 / Chromium 148.0.7778.280 with the new
microphone helper loaded. The user was asked to start listening and play the same
YouTube video through laptop speakers while silent, then confirmed **"yes
working"**. This is user-confirmed acceptance after updating the actual installed
copy. The temporary diagnostic endpoint was no longer available for a final
counter snapshot, so no automated live-transcript counts are claimed.

The numeric measurements above are an acoustic energy test, not transcript
accuracy or a test of a person speaking simultaneously over playback. The later
YouTube check was confirmed by the user as described above. Double-talk still
needs a separate check with the user's preferred volume and microphone. No
claim of perfect cancellation on every device or volume is made. macOS/Linux
runtime upgrades have not been exercised here.
