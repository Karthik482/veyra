# Windows audio and Assist problem context

Latest Windows echo correction and measured results: [system-echo-fix.md](system-echo-fix.md).
The older echo-cancellation observations below describe earlier builds.

## Follow-up: source separation and realtime latency

The original app labeled sources at the IPC boundary: `mic:pcm` goes to `routeAudio('you', ...)`, and `system:pcm` goes to `routeAudio('them', ...)`. Each source has a separate transcription instance. It never identified speakers by voice. That routing is preserved and now has an explicit regression test.

The reported setup used **laptop speakers**, with YouTube also appearing as You. The microphone physically hears the loudspeakers, so the same playback can reach both channels. Echo cancellation was already requested. Headphones isolate the two sources; for playback-only tests, the new **Mute mic** control disables the microphone track while keeping loopback and Them transcription running. Settings → Audio now lets the user select the laptop/headset microphone explicitly, and shows the active input. No fuzzy transcript deduplication or automatic muting during remote speech is used, so simultaneous genuine speech is preserved.

An error in the previous patch enabled server VAD for `gpt-realtime-whisper`. A live configuration probe reproduced the API rejection (`invalid_value`: turn detection unsupported) and confirmed acceptance with `turn_detection: null`. The error path switched both sources to batch mode, which waits for silence or an utterance limit and therefore feels much slower. The original upstream code omitted turn detection and did not explicitly commit utterances; neither implementation correctly handled this model's turn boundaries.

The fix retains the existing model and uses `src/streaming-turn-detector.js`: 30 ms PCM frames, 240 ms pre-roll, continuous audio forwarding during speech, a local commit after 450 ms of trailing silence, and bounded 15-second continuous turns. It does **not** wait for an entire sentence before forwarding its audio. Session readiness now waits for `session.updated`, not the initial `session.created`. Cancelled OpenAI sockets cannot reconnect after capture is stopped or fallback starts. Batch fallback is explicitly displayed as **batch · slower**.

The audio worklet previously buffered 4096 samples (256 ms at 16 kHz) and read only the first channel. It now sends 480-sample chunks (30 ms) and mixes stereo playback to mono, preserving right-channel speech. The legacy ScriptProcessor fallback uses 512 samples.

Validation for this follow-up: **160 tests passed**, JavaScript syntax/whitespace checks passed, and the real Electron loopback/UI smoke passed, including microphone mute/unmute without interrupting system audio. A live OpenAI test streamed a generated 6.63-second sentence in real time through the corrected source class: first interim at **1,299 ms**, last final at **6,996 ms**, two correct finalized sentences, no pending transcription. This synthetic test verifies functionality, not a latency guarantee for real microphones, accents, background sound, or network conditions. No user microphone audio was used in the cloud test.

New/updated follow-up files: `src/streaming-turn-detector.js`, `src/stt-streaming.js`, `renderer/audio-worklet-processor.js`, `renderer/renderer.js`, `renderer/index.html`, `renderer/styles.css`, `main.js`, `src/store.js`, `test/streaming-turn-detector.test.js`, `test/audio-worklet.test.js`, `test/streaming-transcript.test.js`, `test/assist-flow.test.js`, `scripts/smoke-audio-assist.cjs`, and opt-in `scripts/probe-live-stt.cjs`.

API evidence: [model-specific server VAD restriction](https://developers.openai.com/api/reference/cli/resources/realtime/subresources/client_secrets), [Realtime transcription and explicit commits](https://developers.openai.com/api/docs/guides/realtime-transcription).

## Root causes and implementation

- Electron **33.2.1** was installed. `main.js` supplied `audio: true` to `setDisplayMediaRequestHandler`; the installed `Streams` type requires `loopback`/`loopbackWithMute` or a frame. Windows now uses `audio: 'loopback'`. The renderer requires a live audio track and reports microphone and system-track status separately.
- `src/stt-streaming.js` forwarded each OpenAI delta as an entire interim message. It now accumulates by item ID, suppresses repeated event/final IDs, and preserves utterance ordering metadata. The renderer maintains separate interim rows per source/item. Finalized speech remains separate from interim speech.
- `main.js` built Assist before pending STT completed. It now asks active transcribers to finalize and waits up to **650 ms**. If streaming text is still pending, that accumulated text is included and labeled provisional. If batch/local processing has no text yet, veyra asks the user to retry when the text arrives instead of paying for an answer that misses the newest speech.
- Cloud fallback previously submitted independent audio slices every 900 ms. `src/batch-transcriber.js` now reuses the existing `UtteranceSegmenter`: silence ends an utterance, continuous speech is capped at 25 seconds, and Assist can flush it. The queue is bounded. No NLP sentence reconstruction is used.
- The renderer started the microphone twice on a capture-state event. It now has one start path plus an in-flight guard.

## Screen context

`src/screen.js` captures the **primary display** using Electron `desktopCapturer`. Capture is event-driven: once per manual screenshot click and freshly on each Assist. Images are resized only when larger than 2560 × 1600 while preserving aspect ratio, then encoded as JPEG quality 88. The model receives actual image data, not OCR text.

`src/assist-session.js` holds up to **four manual screenshots** in capture order, the first automatic problem screen, and the latest automatic screen. At most **six distinct images** are sent. SHA-256 detects identical encoded images. Tiny visual differences can still create distinct screenshots. Fresh capture failure falls back to retained images and reports the failure. Timestamps and ages distinguish old context from the current screen.

Screenshots and Q&A are stored **in memory only**, not uploaded until a user invokes an AI action. Manual captures remain attached across Assist responses. Clear removes manual attachments; **Clear Context** also removes automatic problem imagery and prior Q&A.

## Assist and follow-up context

One multimodal request includes:

1. Existing system instructions and configured profile context.
2. Up to **three prior Assist question/answer pairs** (18,000-character combined history budget; 6,000 characters per question/answer).
3. Up to **14 finalized recent conversation entries**, preserving You/Them labels and preferentially retaining complete utterances within a 16,000-character budget.
4. Any accumulated provisional speech after the bounded wait, plus the latest Them question.
5. Manual screenshots, retained original problem screen, and fresh current screen, deduplicated and ordered.

The prior answer is captured from the existing streaming LLM result. The model itself resolves follow-ups such as “Why?” or “What if it doesn't fit in memory?”; there is no keyword classifier. Clear Context establishes a new problem boundary for transcript context, images, and Q&A without stopping capture. Normal meeting history remains visible, but earlier problem entries are excluded from subsequent Assist requests.

`src/llm.js` retains legacy single-image compatibility and sends image arrays through the existing OpenAI/custom/Groq/MiniMax/Azure, Anthropic, Gemini, and Ollama adapters. The selected model must support images. No extra summarization/model call was added.

## Development diagnostics

Diagnostics require both an unpackaged app and `VEYRA_DIAGNOSTICS=1`. They appear in the launching terminal and are mirrored to the renderer console. `src/diagnostics.js` redacts configured credential values, credential fields, common key patterns, and image payloads. It logs no raw audio.

Events include `SYSTEM AUDIO REQUESTED`, `SYSTEM AUDIO TRACKS`, `SYSTEM AUDIO STARTED`, `STT DELTA`, `STT INTERIM`, `STT FINAL`, `ASSIST PENDING TRANSCRIPTION`, `ASSIST TRANSCRIPT CONTEXT`, `ASSIST SCREENSHOTS`, `ASSIST CONTEXT`, and request success/failure. `ASSIST REQUEST` contains model/provider, text/image content types, prior turn count, and a rough text-token estimate (characters / 4; image tokens are not included).

Close the installed veyra before launching the development version:

```powershell
Set-Location C:\Users\ckart\shadow\veyra
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:VEYRA_DIAGNOSTICS = '1'
npm.cmd start
```

For the development instance started by the coding agent, follow its redirected output in a separate PowerShell:

```powershell
Get-Content C:\Users\ckart\shadow\veyra\.cache\veyra-dev.stdout.log -Tail 100 -Wait
```

## Exact YouTube test

1. Use headphones so the microphone does not also hear the YouTube speaker through your loudspeakers. This avoids hearing the same voice on both source channels; veyra does not claim speaker diarization or acoustic cross-channel deduplication.
2. Start the development app as above. Keep the primary display on the content you intend to share with the AI.
3. Choose an STT provider with valid credentials in Settings → Audio, or local Whisper with its runtime **and a downloaded model**. Select a configured vision-capable AI model for Assist.
4. Click **Start / stop listening** once. Confirm **You: mic live** and **Them: system audio live**. If Them reports unavailable, inspect `SYSTEM AUDIO FAILED` instead of treating the main listening indicator as proof both channels are working.
5. Play a YouTube interview or technical explanation in Chrome. Open Conversation History using the history icon. Expect system speech under **Them** and accumulating interim text, followed by finalized text.
6. Pause YouTube and say a short sentence into the microphone. Expect **You**, separately from the existing Them transcript.
7. Play a complete technical question, pause, and immediately click **Assist**.
8. Inspect `ASSIST TRANSCRIPT CONTEXT` and `ASSIST CONTEXT`. Verify the question is present in full, finalized or explicitly provisional, along with recent conversation.
9. Check `ASSIST REQUEST` for the selected model and text/image content types. Verify the response addresses the question and visible screen.
10. If local/batch inference is still processing without text, wait for the transcript to appear and retry. This is deliberately reported rather than silently omitting the question.

## Exact coding/follow-up test

1. Put the first part of a function on the primary display; click **+ Screenshot**. Confirm **1 attached**.
2. Scroll to the remaining code and click **+ Screenshot**. Confirm **2 attached**.
3. Optionally show the caller/error and capture a third image.
4. Play a recorded question through Chrome: **“How would you optimize this code?”** Wait for Them text or click Assist immediately after the question.
5. Click **Assist**. In diagnostics verify the manual screenshot order, fresh capture flag, duplicate flag, complete spoken question, and a single logical LLM request. Check the answer against the code.
6. Without clearing or recapturing, play **“What if the input doesn't fit in memory?”** Click Assist again.
7. Verify `ASSIST CONTEXT` contains the previous question and assistant solution plus the follow-up. `ASSIST SCREENSHOTS` should still include the original code. The new answer should address that same implementation.
8. Click **Clear Context**. Confirm **0 attached**. Keep listening and speak/play a new question. Verify new requests omit the old screenshots/Q&A/problem transcript and both audio channels still work.

## Verification and limits

- Verified on this Windows machine: **153 tests passed, 0 failed**; JavaScript syntax checks and `git diff --check` passed. The real Electron audio/overlay smoke and quit-button smoke passed. The quit smoke emitted Chromium GPU teardown messages but exited successfully after the expected button/IPC path.
- Windows installer build succeeded with the bundled Whisper runtime. Installation completed with exit code 0, and all 13 changed runtime files in the installed app matched the tested source byte-for-byte. Veyra was then launched from source with development diagnostics enabled.
- `npm test` includes offline tests for delta accumulation, duplicate finals, out-of-order completions, Assist timing, both audio source labels, bounded history, ordered image payloads across providers, follow-up context, clear-context behavior, batch utterance segmentation, and secret redaction.
- `scripts/smoke-audio-assist.cjs` runs real Electron against an isolated profile. It verifies a live Windows loopback track after stopping the video track, separate You/Them renderer state, screenshot IPC/count, clear-context UI, and horizontal layout. It makes no cloud calls and saves no audio.
- `scripts/smoke-quit.cjs` remains available for the prior quit-button regression.
- There is no configured lint or typecheck command; JavaScript syntax and Git whitespace checks are used in addition to tests.
- Build with `VEYRA_BUNDLE_WHISPER=1` and `npm.cmd run dist:win` to include the pinned Whisper runtime. The runtime is separate from the selected speech-model download.
- Automated provider tests use stubs. Real paid transcription/model quality, all playback devices, and every third-party model's vision capability still require the manual tests above. Live system-track creation was verified on Windows/Electron 33.2.1.
- Windows Defender, Firewall, SmartScreen, and other OS security controls are unchanged.

## Files changed

- Main orchestration and IPC: `main.js`, `preload.js`.
- Overlay controls/audio/transcripts: `renderer/index.html`, `renderer/styles.css`, `renderer/renderer.js`.
- STT: `src/stt-streaming.js`, `src/batch-transcriber.js`, `src/utterance-segmenter.js`, `src/local-whisper-transcriber.js`.
- Context/images/providers/diagnostics: `src/assist-session.js`, `src/screen.js`, `src/llm.js`, `src/diagnostics.js`.
- Tests: `test/assist-flow.test.js`, `test/assist-session.test.js`, `test/batch-transcriber.test.js`, `test/streaming-transcript.test.js`, `test/multimodal.test.js`, `scripts/smoke-audio-assist.cjs`.

API references: [Electron display-media handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts), [OpenAI realtime transcription event semantics](https://developers.openai.com/api/docs/guides/realtime-transcription), [existing GPT-Realtime-Whisper model](https://developers.openai.com/api/docs/models/gpt-realtime-whisper). The existing model selection was retained.
