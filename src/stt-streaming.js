// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session)
// or Deepgram Nova streaming. Falls back to batch Whisper/Gemini if streaming unavailable.
//
// This module manages a persistent WebSocket connection for real-time transcription
// with incremental results and automatic reconnection. Actual latency depends
// on the provider and network; a connected socket is not a configured session.

const { looksLikeHallucination } = require('./stt');
const { pcmToWav } = require('./wav');
const { CURRENT_GEMINI_DEFAULT } = require('./llm');
const { StreamingTurnDetector } = require('./streaming-turn-detector');

// ============================================================================
// OpenAI Realtime Transcription Session (WebSocket)
// Uses the dedicated transcription session type for lowest latency streaming STT
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'gpt-realtime-whisper';
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._pendingAudio = [];
    this._sessionReady = false;
    this._interims = new Map();
    this._completed = new Set();
    this._seenEvents = new Set();
    this._pendingItems = new Set();
    this._audioBytes = 0;
    this._awaitingCommits = 0;
    this._speechActive = false;
    this._itemMetadata = new Map();
    this._itemOrder = 0;
    this.onDiagnostic = options.onDiagnostic || (() => {});
    this._closed = false;
    this._reconnectTimer = null;
    this._turnDetector = new StreamingTurnDetector({
      onAudio: pcm => this._appendAudio(pcm),
      onEnd: () => this._commitAudio()
    });
  }

  async connect() {
    if (this.ws && this.connected) return;
    this._closed = false;

    try {
      const WebSocket = require('ws');
      // GA transcription endpoint: use ?intent=transcription (NOT ?model=)
      // The transcription model goes inside the session config
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      const socket = this.ws;
      this.ws.on('open', () => {
        if (this._closed || this.ws !== socket) return;
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connecting');

        // Configure the transcription session (GA format)
        this._sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: this.model,
                  language: 'en'
                },
                // gpt-realtime-whisper rejects server VAD. Commit turns locally.
                turn_detection: null
              }
            }
          }
        });
      });

      this.ws.on('message', (data) => {
        if (this._closed || this.ws !== socket) return;
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', (code) => {
        if (this._closed || this.ws !== socket) return;
        this.connected = false;
        this._sessionReady = false;
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (this._closed || this.ws !== socket) return;
        this.onError({ provider: 'openai-realtime', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'openai-realtime', message: e.message, status: null });
    }
  }

  _handleEvent(event) {
    if (event.event_id) {
      if (this._seenEvents.has(event.event_id)) return;
      this._seenEvents.add(event.event_id);
      if (this._seenEvents.size > 1000) this._seenEvents.delete(this._seenEvents.values().next().value);
    }
    const itemId = event.item_id || 'current';
    if (event.item_id && !this._itemMetadata.has(itemId) && !this._completed.has(itemId)) {
      this._itemMetadata.set(itemId, { itemId, startedAt: Date.now(), order: ++this._itemOrder });
    }
    const meta = this._itemMetadata.get(itemId) || { itemId };
    switch (event.type) {
      case 'session.created':
        // The default session has not accepted our transcription configuration.
        break;
      case 'session.updated':
        this._sessionReady = true;
        this.onStatusChange('connected');
        this.onDiagnostic('STT SESSION READY', { model: this.model, turnDetection: 'client' });
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta && !this._completed.has(itemId)) {
          const text = (this._interims.get(itemId) || '') + event.delta;
          this._interims.set(itemId, text);
          this._pendingItems.add(itemId);
          this.onDiagnostic('STT DELTA', { itemId, delta: event.delta, interim: text });
          this.onInterim(text, meta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (this._completed.has(itemId)) break;
        if (event.item_id) {
          this._completed.add(itemId);
          if (this._completed.size > 200) this._completed.delete(this._completed.values().next().value);
        }
        this._pendingItems.delete(itemId);
        this._interims.delete(itemId);
        this._itemMetadata.delete(itemId);
        if (!this._pendingItems.size) this._speechActive = false;
        if (event.transcript && event.transcript.trim()) {
          this.onTranscript(event.transcript.trim(), meta);
        }
        this.onInterim('', { itemId });
        break;

      case 'input_audio_buffer.speech_started':
        this._speechActive = true;
        this._pendingItems.add(itemId);
        break;

      case 'input_audio_buffer.speech_stopped':
        this._speechActive = false;
        this._audioBytes = 0;
        break;

      case 'input_audio_buffer.committed':
        // New audio may already have arrived since the commit was sent.
        this._awaitingCommits = Math.max(0, this._awaitingCommits - 1);
        this._pendingItems.add(itemId);
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this._pendingItems.delete(itemId);
        this._interims.delete(itemId);
        this._itemMetadata.delete(itemId);
        this.onInterim('', { itemId });
        this.onError({ provider: 'openai-realtime', message: event.error?.message || 'Transcription failed', status: event.error?.code });
        break;

      case 'error':
        // Server VAD can commit between our check and a manual Assist flush.
        if (event.error?.code === 'input_audio_buffer_commit_empty' && this._manualCommit) {
          this._manualCommit = false;
          this._awaitingCommits = Math.max(0, this._awaitingCommits - 1);
          break;
        }
        this.onError({
          provider: 'openai-realtime',
          message: event.error?.message || 'Unknown realtime error',
          status: event.error?.code
        });
        break;
    }
  }

  sendAudio(pcmBuffer) {
    if (this._closed) return;
    if (!this.connected || !this._sessionReady) {
      // Buffer audio until session is ready (max 5 seconds worth)
      this._pendingAudio.push(pcmBuffer);
      let bytes = this._pendingAudio.reduce((sum, pcm) => sum + pcm.byteLength, 0);
      while (bytes > 16000 * 2 * 5) bytes -= this._pendingAudio.shift().byteLength;
      return;
    }
    this._turnDetector.push(pcmBuffer);
  }

  _appendAudio(pcmBuffer) {
    this._audioBytes += pcmBuffer.byteLength;

    // Resample 16kHz -> 24kHz (linear interpolation) since the API requires 24kHz
    const resampled = this._resample16to24(Buffer.from(pcmBuffer));
    const b64 = resampled.toString('base64');
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: b64
    });
  }

  _resample16to24(pcm16kHz) {
    // Linear interpolation from 16000 Hz to 24000 Hz (ratio 2:3)
    const srcSamples = pcm16kHz.length / 2;
    const dstSamples = Math.floor(srcSamples * 24000 / 16000);
    const out = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcPos = i * 16000 / 24000;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = idx < srcSamples ? pcm16kHz.readInt16LE(idx * 2) : 0;
      const s1 = (idx + 1) < srcSamples ? pcm16kHz.readInt16LE((idx + 1) * 2) : s0;
      const sample = Math.round(s0 + (s1 - s0) * frac);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return out;
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0) {
      const chunk = this._pendingAudio.shift();
      this._turnDetector.push(chunk);
    }
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
      this.ws.send(JSON.stringify(event));
    }
  }

  hasPending() { return this._turnDetector.active || this._speechActive || this._awaitingCommits > 0 || this._pendingItems.size > 0; }

  // A compact description of everything still in flight. Assist uses it to tell
  // "the provider is still working" apart from "the provider stopped answering",
  // because both look identical through hasPending() alone.
  pendingSignature() {
    return [
      this._turnDetector.active ? 'on' : 'off',
      this._speechActive ? 'speaking' : 'quiet',
      this._awaitingCommits,
      this._pendingItems.size,
      this._interims.size,
      this._completed.size
    ].join(':');
  }

  requestFinalize() {
    this._turnDetector.flush();
    this._commitAudio();
  }

  _commitAudio() {
    // At least 100 ms of 16 kHz PCM; don't commit idle/empty buffers.
    if (this.connected && this._sessionReady && this._audioBytes >= 3200) {
      this._manualCommit = true;
      this._awaitingCommits += 1;
      this._sendEvent({ type: 'input_audio_buffer.commit' });
      this._audioBytes = 0;
      this._speechActive = false;
    }
  }

  _attemptReconnect() {
    if (this._closed) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'openai-realtime', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this.reconnecting = true;
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    this._reconnectTimer = setTimeout(() => {
      this.reconnecting = false;
      if (!this._closed) this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._turnDetector.reset();
    this._awaitingCommits = 0;
    this._sessionReady = false;
    this._pendingAudio = [];
    for (const itemId of this._interims.keys()) this.onInterim('', { itemId });
    this._interims.clear();
    this._itemMetadata.clear();
    this._pendingItems.clear();
    this._speechActive = false;
    this._audioBytes = 0;
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova Streaming STT (WebSocket)
// Ultra-low latency, supports interim results, speaker diarization, punctuation
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'nova-3';
    this.ws = null;
    this.connected = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._keepAliveInterval = null;
    this._committed = ''; // is_final segments not yet closed out by speech_final
    this._interim = '';
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      const params = new URLSearchParams({
        model: this.model,
        language: 'en',
        smart_format: 'true',
        interim_results: 'true',
        utterance_end_ms: '1000',
        vad_events: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        endpointing: '300',
        punctuate: 'true'
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `Token ${this.apiKey}` }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        // Keep-alive every 3 seconds to prevent timeout
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) { /* ignore */ }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._clearKeepAlive();
        this.onStatusChange('disconnected');
        if (code !== 1000) this._attemptReconnect();
      });

      this.ws.on('error', (err) => {
        this.onError({ provider: 'deepgram', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'deepgram', message: e.message, status: null });
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || '').trim();

      // Deepgram splits one spoken sentence into several is_final segments and only sets
      // speech_final on the last one. Accumulate the is_final pieces and emit a single turn
      // at speech_final so a sentence is not fragmented across transcript rows.
      if (msg.speech_final) {
        const full = ((this._committed || '') + ' ' + text).trim();
        this._committed = '';
        this._interim = '';
        if (full && !looksLikeHallucination(full)) this.onTranscript(full);
        this.onInterim('');
        return;
      }
      if (!text) return;
      if (msg.is_final) {
        this._committed = ((this._committed || '') + ' ' + text).trim();
        this.onInterim(this._committed);
      } else {
        this._interim = text;
        this.onInterim(((this._committed || '') + ' ' + text).trim());
      }
    } else if (msg.type === 'UtteranceEnd') {
      // Safety net: if endpointing never produced a speech_final, flush whatever is_final
      // segments we accumulated so the turn is not silently dropped.
      this._flushCommitted();
    } else if (msg.type === 'Error') {
      this.onError({ provider: 'deepgram', message: msg.description || msg.message, status: msg.variant });
    }
  }

  _flushCommitted() {
    const full = (this._committed || '').trim();
    this._committed = '';
    this._interim = '';
    if (full && !looksLikeHallucination(full)) this.onTranscript(full);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  _clearKeepAlive() {
    if (this._keepAliveInterval) { clearInterval(this._keepAliveInterval); this._keepAliveInterval = null; }
  }

  hasPending() { return !!(this._committed || this._interim); }
  pendingSignature() { return `${this.connected ? 'open' : 'closed'}:${this._committed.length}:${this._interim.length}`; }
  requestFinalize() {
    if (this.hasPending() && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'Finalize' }));
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'deepgram', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    setTimeout(() => this.connect(), Math.min(delay, 16000));
  }

  disconnect() {
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      // Send CloseStream message for clean shutdown
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* ignore */ }
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Batch STT (enhanced version of the original — used as fallback)
// Supports Whisper and Gemini with better error handling
// ============================================================================

async function transcribeBatchOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    response_format: 'text',
    language: 'en'
  });
  return (typeof res === 'string' ? res : res.text || '').trim();
}

async function transcribeBatchGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// ============================================================================
// Unified Streaming STT Factory
// Creates the best available streaming STT based on the user's API keys.
// Priority: Deepgram (lowest latency) > OpenAI Realtime > Batch fallback
// ============================================================================

function createStreamingSTT(settings, channel, callbacks) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const { onTranscript, onInterim, onError, onStatusChange, onDiagnostic } = callbacks;

  if (selectedProvider === 'local' || selectedProvider === 'gemini') {
    return { type: 'batch', provider: selectedProvider, instance: null };
  }

  // Priority 1: Deepgram (purpose-built for streaming STT, lowest latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'deepgram') && keys.deepgram) {
    const stt = new DeepgramStreamingSTT(keys.deepgram, {
      model: 'nova-3',
      onTranscript: (text, meta) => onTranscript(channel, text, meta),
      onInterim: (text, meta) => onInterim(channel, text, meta),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'deepgram', instance: stt };
  }

  // Priority 2: OpenAI Realtime API (excellent quality, slightly higher latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const stt = new OpenAIRealtimeSTT(keys.openai, {
      model: 'gpt-realtime-whisper',
      onTranscript: (text, meta) => onTranscript(channel, text, meta),
      onInterim: (text, meta) => onInterim(channel, text, meta),
      onDiagnostic: (event, data) => onDiagnostic?.(event, { channel, ...data }),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'openai-realtime', instance: stt };
  }

  // Priority 3: Batch fallback (Gemini or Whisper via old system)
  return {
    type: 'batch',
    provider: selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none',
    instance: null
  };
}

module.exports = {
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};
