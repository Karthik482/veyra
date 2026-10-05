<div align="center">
<img src="renderer/assets/veyra.svg" width="100" alt="Veyra logo" />

# Veyra

A private desktop copilot for conversations, screen context, and meeting notes.

</div>

Veyra offers configurable shortcuts, a spacious settings panel, separate conversation controls, and Windows movement that preserves the window's size. Maintained by Karthik Chevuru and distributed under GPL-3.0-or-later.

## Use Veyra

Download [`Veyra-win-x64.exe` from Releases](https://github.com/Karthik482/veyra/releases/latest), install it on Windows, then open **Veyra**. The installer is unsigned. Existing settings and downloaded models are preserved through profile compatibility data. New settings use `veyra-data.json`.

Open **Settings** to choose an AI provider and enter your own API key. Supported providers include OpenAI, Anthropic, Google Gemini, and Azure AI Foundry. Listening can use Deepgram, OpenAI Realtime, Gemini, or local Whisper, depending on your configuration. Local Whisper requires a downloaded or imported model in Settings.

- **Assist** uses screen context and the recent conversation.
- **What should I say?**, **Follow-up questions**, and **Recap** use conversation context.
- **Smart** chooses the configured higher-capability model.
- **View conversation** shows the transcript.
- **Settings → Hotkeys** lists each action and its binding. Click **Edit**, press your preferred keys, then **Apply**. Conflicts are reported before saving.
- Drag an edge or corner to resize. Drag the top bar to move. The redundant labeled Resize button has been removed.
- **Ctrl + arrow** moves the window without resizing on Windows.
- **Ctrl + Shift + X** quits on Windows; **Command + Shift + X** quits on macOS. These bindings can be customized.

The meeting controls do not contain a text-entry bar. The microphone and meeting-audio channels remain separate. Windows microphone capture requests system-wide echo cancellation; use the audio status in Settings to check what your device actually enabled.

## Capture protection

Veyra keeps Electron's content protection enabled while moving and resizing. Windows desktop screenshot and live screen-stream regression tests cover those operations. This does **not** prove exclusion from every meeting application or capture mode: some recording methods can bypass OS exclusion. Check your actual sharing setup before relying on it. Protection on macOS depends on the OS and capture method; Linux does not provide the same Windows exclusion guarantee.

For local UI debugging only, `VEYRA_NO_PROTECT=1` disables protection. Do not set it for normal use.

## Run and build

Requires Node.js 22.12+ and npm. From this checkout:

```sh
npm ci
npm start
npm test
```

Repository: [Karthik482/veyra](https://github.com/Karthik482/veyra). GitHub CI tests supported Node versions and checks Windows packaging. The manual **Build Windows installer** workflow creates a downloadable artifact; it does not overwrite published releases.

Windows builds must run on Windows. The small movement helper is compiled with the system .NET Framework C# compiler; Visual Studio is not needed. It uses `SetWindowPos` with `SWP_NOSIZE`, avoiding fractional-display-scale size drift. The helper only accepts movement requests for windows owned by its parent Veyra process.

```sh
npm run prepare:window
npm run build:icons
npm run pack:win
npm run dist:win
```

The installer is written to `dist/Veyra-win-x64.exe`; the unpacked executable is `dist/win-unpacked/Veyra.exe`. To include the local transcription runtime in a Windows build, use PowerShell:

```powershell
$env:VEYRA_BUNDLE_WHISPER = '1'
npm run dist:win
```

For development, `npm run prepare:whisper` prepares the pinned runtime. Windows and Linux use checksum-verified upstream binaries. macOS requires CMake and Xcode command-line tools to build Whisper. Models are managed separately in Settings. Environment variables use the `VEYRA_*` prefix.

Other targets: `npm run dist:mac`, `npm run dist:linux`, and `npm run dist:linux:arm64`. These platforms have not been validated by this Windows release's smoke tests. macOS signing/notarization is enabled through the environment options documented in `electron-builder.cjs`.

## Validation

```sh
npm test
npx electron scripts/smoke-window-controls.cjs
npx electron scripts/smoke-audio-assist.cjs
npx electron scripts/smoke-capture-protection.cjs
npx electron scripts/smoke-quit.cjs
```

The capture-protection test is Windows-only and temporarily displays a solid-color backdrop. The smoke tests use isolated settings, not the user's API keys. The window test includes 240 arrow moves at two sizes, shortcut editing/conflict checks, and settings layout checks at minimum and expanded sizes. The audio smoke test uses a synthetic microphone and real Windows loopback without sending audio to a provider.

## Data and attribution

API keys, preferences, and optional résumé context are stored locally in the `veyra-data.json` profile file. Provider requests transmit the context needed by the chosen feature. Local Whisper transcribes on-device. Audio utterances and the active transcript stay in memory; downloaded models remain on disk until deleted. Veyra has no hosted account service or telemetry.

The optional local app link requires user consent and exposes diagnostic counts/status rather than transcript text, résumé text, or API keys.

See [LICENSE](LICENSE) and [modification and third-party notices](NOTICE.md). Dependencies retain their respective licenses.
