const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
require('./src/app-identity').configureIdentity(app);
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');
const { AssistSession, settleTranscription } = require('./src/assist-session');
const { findResidualEcho } = require('./src/echo-suppressor');
const { BatchTranscriber } = require('./src/batch-transcriber');
const { createDiagnostics } = require('./src/diagnostics');
const { ACTIONS, DEFAULTS: DEFAULT_SHORTCUTS, resolveShortcuts, validate: validateShortcuts, ShortcutManager } = require('./src/shortcuts');
const { MIN_WIDTH, MIN_HEIGHT, fitBounds, moveBounds, resizeBounds } = require('./src/window-geometry');
const { WindowsWindowMover } = require('./src/windows-window-mover');
let windowMover = null;

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
// Which global shortcuts veyra actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, quit: false };
let shortcutManager = null;
let shortcutRecordTimer = null;
let resizeGesture = null;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

let permWin = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
let transcriptSequence = 0;
const currentInterims = new Map();
const assistSession = new AssistSession();
let batchTranscriber = null;
const diagnostics = createDiagnostics({
  enabled: !app.isPackaged && process.env.VEYRA_DIAGNOSTICS === '1',
  secrets: () => Object.values(store.getSettings().apiKeys || {}),
  write: (event, data) => { console.log(event, data); send('diagnostic', { event, data }); }
});
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
// Assist settlement budget. The absolute cap only matters while the provider is
// still reporting progress; once nothing has changed for ASSIST_SETTLE_STALL_MS
// the transcript already on hand is the best available one and Assist proceeds
// with it instead of refusing the request (the behaviour that made a single
// immediate click fail).
const ASSIST_SETTLE_TIMEOUT_MS = 8000;
const ASSIST_SETTLE_STALL_MS = 1200;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  turn.seq = ++transcriptSequence;
  transcript.push(turn);
  transcript.sort((a, b) => ((a.startedAt || a.ts) - (b.startedAt || b.ts)) ||
    (a.channel === b.channel && a.order != null && b.order != null ? a.order - b.order : a.seq - b.seq));
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

// -------- residual echo gate --------
// The far-end turns a microphone echo is judged against. Interims are indexed
// as well as finals because either channel's final can land first: the loopback
// and the microphone hear the same speaker output at almost the same instant
// and the two provider sessions commit independently of each other.
const recentFarEnd = new Map(); // itemId (or a content key) -> turn
const FAR_END_WINDOW_MS = 60000;
const FAR_END_LIMIT = 16;
let suppressedEchoCount = 0;

function isEchoSuppressionEnabled() {
  return store.getSettings().echoSuppression !== false;
}

function trimFarEnd() {
  const cutoff = Date.now() - FAR_END_WINDOW_MS;
  for (const [key, entry] of recentFarEnd) {
    if ((entry.startedAt ?? entry.ts) < cutoff) recentFarEnd.delete(key);
  }
  while (recentFarEnd.size > FAR_END_LIMIT) recentFarEnd.delete(recentFarEnd.keys().next().value);
}

function trackFarEndTurn(turn) {
  const key = turn.itemId || `${turn.startedAt}:${turn.text.slice(0, 24)}`;
  recentFarEnd.delete(key); // re-insert so iteration order stays oldest-first
  recentFarEnd.set(key, turn);
  trimFarEnd();
}

function finishedFarEndTurns() {
  const cutoff = Date.now() - FAR_END_WINDOW_MS;
  return [...recentFarEnd.values()].filter(turn => (turn.startedAt ?? turn.ts) >= cutoff);
}

function publishTranscript(channel, text, meta = {}) {
  if (!text || !text.trim()) return;
  const key = `${channel}:${meta.itemId || 'current'}`;
  const interim = currentInterims.get(key);
  const now = Date.now();
  const turn = {
    channel,
    text: text.trim(),
    itemId: meta.itemId,
    ts: now,
    // Clamped so the interval is always well formed: the echo gate reasons about
    // it, and a provider that reports a start after the final was published (clock
    // skew between the client and the session) would otherwise invert it.
    startedAt: meta.startedAt ?? now,
    endedAt: Math.max(now, meta.startedAt ?? now),
    final: true,
    source: channel === 'them' ? 'loopback' : 'microphone',
    speaker: channel === 'them' ? 'Them' : 'You',
    contextRevision: interim?.revision ?? assistSession.revision,
    order: meta.order
  };
  currentInterims.delete(key);

  if (channel === 'them') trackFarEndTurn(turn);

  // Windows loopback and the acoustic path deliver the same far-end audio; the
  // second copy arrives through the microphone. src/echo-suppressor.js explains
  // why the platform AEC cannot remove it in this architecture, and why this
  // gate is deliberately hard to trigger: a kept duplicate is cosmetic, a
  // suppressed answer is a lost turn.
  if (channel === 'you' && isEchoSuppressionEnabled()) {
    const echo = findResidualEcho(turn, finishedFarEndTurns());
    if (echo) {
      suppressedEchoCount += 1;
      diagnostics.log('ECHO SUPPRESSED', {
        text: turn.text,
        matchedThemText: echo.them.text,
        confidence: Number(echo.confidence.toFixed(3)),
        similarity: Number(echo.similarity.toFixed(3)),
        coverage: Number(echo.coverage.toFixed(3)),
        lagMs: turn.startedAt - (echo.them.startedAt ?? echo.them.ts),
        suppressedTotal: suppressedEchoCount
      });
      // Clear the interim row this turn had already put on screen, but never
      // publish it: a duplicate must not become part of the conversation.
      send('stt:interim', { channel, text: '', itemId: meta.itemId });
      return;
    }
  }

  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text, itemId: meta.itemId });
  diagnostics.log('STT FINAL', turn);
}

function publishInterim(channel, text, meta = {}) {
  const key = `${channel}:${meta.itemId || 'current'}`;
  if (text) currentInterims.set(key, { channel, text, itemId: meta.itemId, revision: currentInterims.get(key)?.revision ?? assistSession.revision });
  else currentInterims.delete(key);
  send('stt:interim', { channel, text, itemId: meta.itemId });
  diagnostics.log('STT INTERIM', { channel, text, itemId: meta.itemId });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const restored = {
    x: Number.isFinite(savedSettings.windowX) ? savedSettings.windowX : startX,
    y: Number.isFinite(savedSettings.windowY) ? savedSettings.windowY : startY,
    width: Number.isFinite(savedSettings.windowWidth) ? savedSettings.windowWidth : W,
    height: Number.isFinite(savedSettings.windowHeight) ? savedSettings.windowHeight : H
  };
  const restoreArea = screen.getDisplayMatching(restored).workArea;
  const winOptions = {
    ...fitBounds(restored, restoreArea),
    minWidth: Math.min(MIN_WIDTH, restoreArea.width),
    minHeight: Math.min(MIN_HEIGHT, restoreArea.height),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  const shouldProtect = !process.env.VEYRA_NO_PROTECT;
  if (shouldProtect) {
    if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[veyra] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  const saveGeometrySoon = () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(saveWindowGeometry, 300);
  };
  win.on('move', saveGeometrySoon);
  win.on('resize', saveGeometrySoon);
  win.on('close', () => { clearTimeout(moveSaveTimer); saveWindowGeometry(); });
  win.on('blur', () => { resizeGesture = null; suspendShortcutRecording(false); });

  win.setTitle('Veyra'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Veyra');
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[veyra] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state veyra is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startBatchTranscription() {
  if (batchTranscriber) return;
  const settings = store.getSettings();
  const stt = createSTT(settings);
  send('stt:status', { status: 'batch', provider: stt.provider || 'batch' });
  diagnostics.log('STT MODE', { mode: 'batch', provider: stt.provider || settings.sttProvider });
  batchTranscriber = new BatchTranscriber({
    transcribe: async pcm => {
      if (sttDisabled) return '';
      if (!stt.available) { send('status', { message: 'Select a transcription provider in Settings → Audio.' }); sttDisabled = true; return ''; }
      const result = await stt.transcribe(pcm);
      if (result.error) { handleSttError(result.error, settings); return ''; }
      return result.text;
    },
    onTranscript: publishTranscript,
    onSpeechState: (channel, speaking, durationMs) => send('vad:state', { channel, speaking, durationMs }),
    onError: error => send('status', { message: error.message })
  });
}
function stopBatchTranscription() { batchTranscriber?.stop(); batchTranscriber = null; }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: publishTranscript,
      onInterim: publishInterim,
      onDiagnostic: (event, data) => diagnostics.log(event, data),
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        // An OpenAI realtime failure must stay visible; silently switching to
        // uploaded utterances defeats the user's live-transcription selection.
        const batchFallbackAvailable = err.provider !== 'openai-realtime' && createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startBatchTranscription();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('stt:status', { status: 'error', provider: err.provider });
          send('status', { message: `Realtime transcription stopped (${err.provider}): ${err.message}. Stop and restart listening to retry. Veyra did not switch to batch transcription.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
  currentInterims.clear();
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    batchTranscriber?.push(channel, buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside veyra's own process
// and use veyra's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[veyra] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startBatchTranscription();
    }
    console.log('[veyra] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopBatchTranscription();
  stopStreamingSTT();
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  // Single-flight. A second click while a request is in flight is coalesced into
  // the one already running rather than queued as a duplicate LLM call — the
  // first request is the one that will carry the finalised transcript.
  if (state.busy) {
    diagnostics.log('REQUEST COALESCED', { mode, reason: 'a request is already in flight' });
    return;
  }
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  const requestRevision = assistSession.revision;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    // Assist is a queued operation, not a snapshot. Clicking the instant the
    // interviewer stops used to abort with "still being transcribed": the local
    // silence detector commits the turn at ~450 ms, but the provider's
    // `completed` event — the only thing that clears hasPending() — has not
    // arrived yet at that moment. The request is instead held until the final
    // lands, and the prompt is built afterwards so it can never carry stale
    // context. A provider that stops making progress for ASSIST_SETTLE_STALL_MS
    // is treated as stalled and Assist proceeds with what accumulated.
    if (mode === 'assist') {
      const sources = [localWhisperTranscriber, batchTranscriber, ...Object.values(streamingSTT)].filter(Boolean);
      const pendingAtClick = sources.some(source => source.hasPending?.());
      diagnostics.log('ASSIST CLICKED', {
        sttPending: pendingAtClick,
        interims: [...currentInterims.values()].map(turn => `${turn.channel}: ${turn.text}`)
      });
      if (pendingAtClick) {
        diagnostics.log('ASSIST WAITING FOR FINALIZATION', { sources: sources.length, timeoutMs: ASSIST_SETTLE_TIMEOUT_MS, stallMs: ASSIST_SETTLE_STALL_MS });
        const settle = await settleTranscription(sources, { timeoutMs: ASSIST_SETTLE_TIMEOUT_MS, stallMs: ASSIST_SETTLE_STALL_MS });
        if (settle.settled) {
          diagnostics.log('ASSIST FINAL TRANSCRIPT RECEIVED', { waitedMs: settle.waitedMs, finals: transcript.length });
        } else {
          diagnostics.log(settle.timedOut ? 'ASSIST TRANSCRIPTION TIMEOUT' : 'ASSIST TRANSCRIPTION STALLED', {
            waitedMs: settle.waitedMs,
            finals: transcript.length,
            interims: [...currentInterims.values()].map(turn => `${turn.channel}: ${turn.text}`)
          });
        }
      } else {
        diagnostics.log('ASSIST FINAL TRANSCRIPT RECEIVED', { waitedMs: 0, finals: transcript.length, alreadySettled: true });
      }
      // Nothing to wait for and nothing on hand: there is no question to answer
      // and no screen-only fallback worth sending.
      if (!transcript.length && !currentInterims.size) {
        diagnostics.log('ASSIST NO CONTEXT', { transcript: 0, interims: 0 });
      }
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        diagnostics.log('ASSIST SCREEN CAPTURE FAILED', { message: e?.message });
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        const message = process.platform === 'darwin'
          ? 'Screen capture needs permission — grant Screen Recording to Veyra in System Settings.'
          : process.platform === 'win32'
            ? 'Screen capture failed. Make sure Veyra is not blocked by Windows privacy or security software, then try again.'
            : 'Screen capture failed. Check your desktop capture permissions, then try again.';
        send('status', { message });
      }
    }

    const settingsForPrompt = store.getSettings();
    const promptTranscript = mode === 'assist' ? transcript.filter(turn => turn.seq > assistSession.afterSequence && turn.contextRevision === assistSession.revision) : transcript;
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, promptTranscript);
    const system = def.buildSystem ? def.buildSystem(contextBlock, settingsForPrompt.aiRules || '') : (def.system || '');
    if (mode === 'assist' && requestRevision !== assistSession.revision) return;
    const assistContext = mode === 'assist' ? assistSession.build({
      transcript, interims: [...currentInterims.values()].filter(turn => turn.revision === assistSession.revision), freshDataUrl: imageDataUrl
    }) : null;
    const built = assistContext ? assistContext.prompt : def.build({ transcript, userText: userText || '' });
    const turns = assistContext ? assistContext.turns : [{ role: 'user', text: built }];
    const imageDataUrls = assistContext ? assistContext.images.map(image => image.dataUrl) : (imageDataUrl ? [imageDataUrl] : []);
    if (assistContext) {
      diagnostics.log('ASSIST CONTEXT', { system, turns });
      diagnostics.log('ASSIST TRANSCRIPT CONTEXT', { finalized: assistContext.finalized, interim: assistContext.pending, latestQuestion: assistContext.latestQuestion });
      diagnostics.log('ASSIST SCREENSHOTS', { count: imageDataUrls.length, freshCaptured: assistContext.freshCaptured, duplicateSkipped: assistContext.duplicateSkipped,
        images: assistContext.images.map(({ kind, ts }) => ({ kind, timestamp: ts, ageMs: Date.now() - ts })) });
      // Rebuilt from the post-settlement transcript, so a turn that finalised
      // while Assist was waiting is already part of the request.
      diagnostics.log('ASSIST CONTEXT REBUILT', {
        latestQuestion: assistContext.latestQuestion,
        finalizedTurns: assistContext.finalized.length,
        pendingTurns: assistContext.pending.length,
        previousAssistExchanges: assistSession.history.length,
        screenshots: imageDataUrls.length
      });
      diagnostics.log('ASSIST REQUEST', { provider: llm.provider, model: llm.model, previousTurns: assistSession.history.length,
        contentTypes: imageDataUrls.length ? ['text', 'image'] : ['text'], approximateTextTokens: Math.ceil((system.length + turns.reduce((n, turn) => n + turn.text.length, 0)) / 4) });
      diagnostics.log('ASSIST REQUEST SENT', { provider: llm.provider, model: llm.model, latestQuestion: assistContext.latestQuestion });
    }

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    try {
      const answer = await Promise.race([
        llm.stream({
          system,
          turns,
          imageDataUrls,
          onToken: (t) => { if (streamSettled || (mode === 'assist' && requestRevision !== assistSession.revision)) return; rearm(); send('llm:token', { text: t }); }
        }),
        stalled
      ]);
      if (assistContext) { assistSession.remember(assistContext, answer); send('assist:context', assistSession.status()); }
      diagnostics.log('ASSIST REQUEST SUCCESS', { mode, provider: llm.provider, model: llm.model });
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    diagnostics.log('ASSIST REQUEST FAILURE', { mode, message: e?.message });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  // Hotkeys are saved only by the validated registration transaction below.
  const { shortcuts, windowX, windowY, windowWidth, windowHeight, ...other } = patch || {};
  return store.setSettings(other);
});
ipcMain.handle('shortcuts:get', () => shortcutOverview());
ipcMain.handle('shortcuts:set', (event, overrides) => {
  if (!win || event.sender !== win.webContents || !shortcutManager) return { ok: false, error: 'Window is unavailable.' };
  suspendShortcutRecording(false);
  const result = shortcutManager.apply(overrides);
  Object.assign(shortcutState, shortcutManager.status);
  if (result.ok) store.setSettings({ shortcuts: shortcutManager.map });
  const overview = shortcutOverview();
  send('shortcuts:changed', overview);
  return { ...result, ...overview };
});
ipcMain.handle('shortcuts:record', (event, active) => {
  if (!win || event.sender !== win.webContents) return false;
  suspendShortcutRecording(active === true);
  return true;
});
ipcMain.on('window:resize', (event, gesture = {}) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (gesture.phase === 'end') { resizeGesture = null; saveWindowGeometry(); return; }
  const { screenX, screenY } = gesture;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (gesture.phase === 'start') {
    if (!['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(gesture.edge)) return;
    const bounds = win.getBounds();
    resizeGesture = { edge: gesture.edge, bounds, screenX, screenY, area: screen.getDisplayMatching(bounds).workArea };
    win.setIgnoreMouseEvents(false);
  } else if (gesture.phase === 'move' && resizeGesture) {
    const start = resizeGesture;
    win.setBounds(resizeBounds(start.bounds, start.edge, screenX - start.screenX, screenY - start.screenY, start.area));
  }
});
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  currentInterims.clear();
  assistSession.clear(transcriptSequence);
  send('assist:context', assistSession.status());
  return { ok: true };
});
ipcMain.handle('assist:context', () => assistSession.status());
ipcMain.handle('assist:screenshot', async () => {
  const revision = assistSession.revision;
  try {
    const image = await captureScreenshot();
    if (revision !== assistSession.revision) return assistSession.status();
    const result = assistSession.addScreenshot(image);
    send('assist:context', result);
    return result;
  } catch (error) { return { ...assistSession.status(), error: error.message }; }
});
ipcMain.handle('assist:clear-screenshots', () => {
  const result = assistSession.clearScreenshots(); send('assist:context', result); return result;
});
ipcMain.handle('assist:clear-context', () => {
  localWhisperTranscriber?.requestFinalize();
  batchTranscriber?.requestFinalize();
  assistSession.clear(transcriptSequence);
  send('assist:context', assistSession.status());
  return assistSession.status();
});
ipcMain.on('diagnostic', (_event, { event, data } = {}) => diagnostics.log(event, data));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(resizeGesture ? false : !!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => diagnostics.log('RENDERER', { message: msg }));
// The renderer reports what the microphone track actually negotiated. Recorded
// here so "is echo cancellation actually active?" is answerable from veyra's own
// diagnostics, not only from a devtools console that is usually closed.
ipcMain.on('mic:processing', (_e, report) => diagnostics.log('MIC AUDIO PROCESSING', report));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  const actions = {
    assist: () => runFeature('assist', ''), say: () => runFeature('say', ''), leetcode: () => runFeature('leetcode', ''),
    quit: () => app.quit(), hide: () => send('hide:toggle', {}),
    listening: () => send('shortcut:action', 'listening'), screen: () => send('shortcut:action', 'screen'),
    forceAnswer: () => send('shortcut:action', 'forceAnswer'), settings: () => { win?.show(); win?.focus(); send('shortcut:action', 'settings'); },
    moveUp: () => moveWindow('up'), moveDown: () => moveWindow('down'),
    moveLeft: () => moveWindow('left'), moveRight: () => moveWindow('right')
  };
  shortcutManager = new ShortcutManager(globalShortcut, actions);
  const requested = resolveShortcuts(store.getSettings().shortcuts);
  shortcutManager.register(validateShortcuts(requested) ? resolveShortcuts() : requested);
  Object.assign(shortcutState, shortcutManager.status);
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}
function shortcutOverview() {
  return { bindings: shortcutManager?.map || resolveShortcuts(store.getSettings().shortcuts),
    registered: { ...shortcutState }, defaults: DEFAULT_SHORTCUTS,
    labels: Object.fromEntries(Object.entries(ACTIONS).map(([key, value]) => [key, value[0]])) };
}
function suspendShortcutRecording(active) {
  clearTimeout(shortcutRecordTimer);
  globalShortcut.setSuspended?.(active);
  if (active) shortcutRecordTimer = setTimeout(() => suspendShortcutRecording(false), 30000);
}
function saveWindowGeometry() {
  if (!win || win.isDestroyed()) return;
  const { x, y, width, height } = win.getBounds();
  store.setSettings({ windowX: x, windowY: y, windowWidth: width, windowHeight: height });
}
async function moveWindow(direction) {
  if (!win || win.isDestroyed() || resizeGesture) return;
  if (isWindows) {
    if (!windowMover) windowMover = new WindowsWindowMover({ isPackaged: app.isPackaged && !process.defaultApp, resourcesPath: process.resourcesPath, appPath: __dirname });
    try { await windowMover.move(win, direction); }
    catch (error) { send('status', { message: error.message }); }
    return;
  }
  const bounds = win.getBounds();
  const next = moveBounds(bounds, direction, screen.getDisplayMatching(bounds).workArea);
  win.setPosition(next.x, next.y);
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using veyra's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  app.setName('Veyra');
  if (isWindows) {
    process.title = 'Veyra';
  }

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  windowMover?.dispose();
  clearTimeout(shortcutRecordTimer);
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
