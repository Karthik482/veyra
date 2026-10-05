# OpenAI realtime transcription correction

## Delivery status

Source changes are implemented. **The installed application has not been updated with this correction.** A Windows build finished during this task, but two subsequent fixes (resetting local VAD after an Assist flush and preventing OpenAI-to-batch fallback) are newer than that artifact. Do not treat the existing installer as the final build.

Automatic approval review rejected the final full-test rerun because the account hit its execution usage limit (the rejection stated retry after 10:57 PM). Final rebuild, installation/restart, explicit OpenAI selection in the installed app, and the requested two-minute YouTube test remain pending. No two-minute playback or final deployed-version success is claimed.

## Old model and exact session payload

Model: `gpt-realtime-whisper`.

Connection: `wss://api.openai.com/v1/realtime?intent=transcription`. The authentication header is omitted here because it contains the user's key. The exact configuration event was:

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-realtime-whisper",
          "language": "en"
        },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.5,
          "prefix_padding_ms": 300,
          "silence_duration_ms": 500
        }
      }
    }
  }
}
```

The live API rejected this event with `invalid_value`: `Turn detection is not supported for this transcription model.` Veyra's error handler then selected batch transcription. The unsupported VAD configuration was introduced in the previous local patch. Upstream used the same model but omitted explicit turn detection and client commits.

There is one OpenAI Realtime session-creation path: `OpenAIRealtimeSTT.connect()` in `src/stt-streaming.js`. The factory creates a separate instance for You and Them. The other OpenAI transcription code uses the file-transcription endpoint for batch mode, not an additional Realtime session API version.

## New model and exact session payload

Model remains `gpt-realtime-whisper`; same GA WebSocket endpoint and nested session schema:

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-realtime-whisper",
          "language": "en"
        },
        "turn_detection": null
      }
    }
  }
}
```

No `server_vad`, `semantic_vad`, beta `transcription_session.update`, or beta flat `input_audio_format` fields are mixed into this event. The live API accepted the corrected event with the existing account/model.

## Why this configuration is valid; server-VAD evaluation

The current [OpenAI VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad) and [transcription session reference](https://developers.openai.com/api/reference/cli/resources/realtime/subresources/client_secrets) require omitted/null turn detection for `gpt-realtime-whisper`. The [model page](https://developers.openai.com/api/docs/models/gpt-realtime-whisper) describes live incremental transcription. The [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription) documents sending audio chunks, explicit commits, incremental deltas, and completed events.

`gpt-4o-transcribe` is a real supported transcription model, and the current session schema lists it alongside server-VAD configuration. Server VAD provides automatic silence-based turn boundaries. The schema describes this as responding at the end of speech, which is a different latency tradeoff from continuously available live captions. The engineering decision here is to retain the already verified live-caption model and commit locally rather than change the default to a turn-based model without a comparative live benchmark. No claim is made that `gpt-4o-transcribe` is invalid or unavailable. Its live performance has not been benchmarked in this task.

Client endpointing forwards PCM during speech with 240 ms of pre-roll, commits after 450 ms of silence, and caps continuous turns at 15 seconds. Silence affects finalization, not the start of streaming. Assist can explicitly flush the active turn and wait up to 650 ms for the final, or use available interim text. Pending commits are tracked until acknowledgement. Final events are deduplicated by item, and both sources retain independent state.

## Other fixes relevant to the report

- AudioWorklet buffering reduced from 4096 samples / 256 ms to 480 samples / 30 ms at 16 kHz.
- Stereo playback is mixed into mono instead of discarding the right channel.
- Session readiness waits for `session.updated`, not merely `session.created`.
- Cancelled OpenAI sockets cannot restart or deliver stale callbacks after stop/fallback.
- OpenAI Realtime errors stop visibly with a retry instruction; they no longer select batch mode.
- Settings → Audio adds microphone selection and shows the active input. Mute mic stops the You input without disabling Them.

The user confirmed testing through laptop speakers. Playback can therefore be captured by both the microphone and Windows loopback. This is acoustic leakage, not speaker classification: microphone PCM is always You, system PCM is always Them. Existing echo cancellation remains enabled. Headphones provide the cleanest simultaneous separation; Mute mic supports playback-only testing.

## Files changed for this correction

- `src/stt-streaming.js`: protocol, readiness, commits, cancellation.
- `src/streaming-turn-detector.js`: new client endpointing.
- `main.js`: visible status and no automatic OpenAI batch fallback.
- `renderer/audio-worklet-processor.js`: shorter frames and stereo mixing.
- `renderer/renderer.js`, `renderer/index.html`, `renderer/styles.css`, `src/store.js`: input selection, mute, status.
- `test/streaming-transcript.test.js`, `test/streaming-turn-detector.test.js`, `test/audio-worklet.test.js`, `test/assist-flow.test.js`: regressions.
- `scripts/smoke-audio-assist.cjs`: real Electron capture/UI checks.
- `scripts/probe-live-stt.cjs`: opt-in synthetic-audio live API probe.
- This report and `docs/audio-assist-context.md`.

## Test results

- Original invalid payload: live API rejection reproduced.
- Corrected payload: live API accepted the session.
- Generated 6.63-second speech, streamed through the real source adapter: first interim at 1,299 ms, last final at 6,996 ms, two correct completed sentences and no pending transcription. This is a synthetic sample, not a production latency guarantee.
- Full suite before the last two regression fixes: **160 passed, 0 failed**.
- Latest relevant isolated suite after both fixes: **18 passed, 0 failed**, including no batch fallback, no extra silent turn after Assist, channel routing, immediate Assist, deltas/finals, readiness and stereo audio.
- Electron smoke: live Windows loopback track, separate transcript display, screenshot UI, microphone mute/unmute preserving Them all passed before the last two main-process fixes.
- Syntax and Git whitespace checks passed. No lint or typecheck command is configured.
- Final full-suite rerun, final build/install and two-minute YouTube acceptance run: **pending due to execution approval limit**.

## Remaining acceptance run

1. Rebuild final source with the bundled Whisper runtime and install it; verify installed files match source.
2. Start Veyra with development diagnostics and explicitly select OpenAI under Settings → Audio.
3. Use headphones, or mute the microphone for a playback-only test. Play spoken YouTube content continuously for at least two minutes.
4. Confirm both Realtime sessions stay connected, no unsupported-turn-detection error appears, and no batch mode is entered.
5. Check accumulating text while speech is ongoing and finalized utterances during natural pauses.
6. Immediately after a question, invoke Assist and inspect its context to confirm the latest question is included.
7. Unmute/speak into the microphone and verify that only You receives that isolated input.
