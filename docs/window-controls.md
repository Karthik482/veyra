# Window controls completion — September 19, 2026

## September 23 follow-up

The previous source was backed up to the user's GitHub fork on
`fix/audio-assist-context` at `f352341` before these follow-up changes.

- Settings now uses a larger, responsive dialog with left-side navigation.
  Every hotkey row shows the action, binding, and an explicit **Edit** button.
  Hotkey Apply controls stay visible while the binding list scrolls.
- The typing area and its auto-fill UI were removed. Smart, conversation history,
  and Settings remain in a compact control row. The answer-current-question hotkey
  invokes Assist using the pending-transcription-aware conversation context.
- The visible **Resize ↘** grip resizes the existing protected window. Edge and
  corner handles and Ctrl+Arrow movement remain available. The response panel
  expands with the window, and geometry persists across launches.
- A microphone-permission banner insertion bug was fixed; it now targets the
  correct panel element. Audio capture, transcription, and echo modules are unchanged.

Validation: all 204 Node tests passed. Real Electron checks passed for hotkey
editing/cancellation/disabling, persistence and conflict rejection, all four
movement directions, the visible resize grip, retained meeting controls, every
Settings tab at the minimum window size, and layouts at multiple sizes. The
existing audio smoke passed live loopback, separate You/Them transcripts,
screenshots, Clear Context, and microphone mute/unmute with the same requested
all-system echo cancellation.

`scripts/smoke-capture-protection.cjs` separately tested actual Windows desktop
screenshots and a live screen-sharing video stream with solid-color test windows. The unprotected positive control was
visible; with protection enabled, no Veyra marker pixels were captured before,
during three resize steps, after resizing, or after moving. The background remained visible
instead. Only numeric results are saved under `.cache`. This verifies the tested
Windows/Electron capture path, not live calls in every Teams, Zoom, or Meet version.

The older implementation notes below describe the September 19 delivery.

Completed the interrupted hotkey and window geometry work in `main.js`,
`preload.js`, `src/shortcuts.js`, `src/store.js`, and `src/window-geometry.js`.
The existing audio and all-system echo cancellation changes are retained.

## Using the controls

- Open Settings → Hotkeys. Click a binding, press a combination, then choose
  **Apply hotkeys**. Escape cancels recording; Backspace disables a binding.
  **Restore defaults** fills in the defaults; Apply saves them.
- Hotkeys cover Assist, What should I say, coding help, hide/show, listening,
  screenshots, answering the current question, settings, movement, and quit.
- Ctrl+Arrow moves the window by 24 pixels. Movement stops at the current
  display's work-area boundary.
- Drag any window edge or corner to resize. The bottom-right grip marks a corner.
  Size and position persist across launches and are fitted to an available
  display when restoring. Minimum size is 560 × 360 where the display permits it.

Duplicate combinations are rejected, including aliases such as Ctrl/Control
and Enter/Return. If Windows cannot register a replacement, the prior bindings
are restored. Existing unavailable bindings are marked in the editor and do not
block unrelated changes. Global shortcuts pause while recording and resume on
completion, blur, or timeout. Tooltips and Assist hints follow saved bindings.
Hardcoded renderer duplicates were removed so rebinding also replaces the old
combination while the app has focus.

Settings no longer overwrite newer window geometry with an old renderer copy.
The duplicated settings-close handlers were consolidated so save failures keep
the dialog open. The panel grows with the window and wraps controls at small sizes.

## Verification

- Full regression suite: 204 tests passed, zero failures.
- `scripts/smoke-window-controls.cjs`: real Electron hotkey recording, saving,
  live hints, conflict rejection, movement, pointer resize, geometry persistence,
  and layouts at 560 × 360 and 900 × 750. Uses an isolated temporary profile.
- Existing audio smoke: live Windows loopback, separate You/Them state,
  screenshot and Clear Context actions, and microphone mute/unmute passed.
- Existing quit-button smoke passed.
- JavaScript syntax and Git whitespace checks passed.
- All 53 packaged runtime source files match the workspace byte-for-byte;
  packaged version, entry point, and dependencies match. The bundled
  whisper.cpp 1.9.1 Windows x64 executable passed its runtime smoke check.

Build the Windows installer with the optional Whisper runtime included:

```powershell
$env:VEYRA_BUNDLE_WHISPER = '1'
npm.cmd run dist:win
```

Output: `dist/veyra-win-x64.exe`. Build validation does not replace the installed
copy; run the new installer to update it. macOS and Linux were not exercised.
