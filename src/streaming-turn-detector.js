const { AdaptiveVAD } = require('./vad');

// Endpoint live PCM locally. Audio is forwarded during speech, not held until
// the whole utterance ends. Keep 240 ms of pre-roll to preserve initial sounds.
class StreamingTurnDetector {
  constructor({ onAudio, onEnd, maxTurnMs = 15000 }) {
    this.onAudio = onAudio;
    this.onEnd = onEnd;
    this.maxBytes = maxTurnMs * 32;
    this.vad = new AdaptiveVAD({ silenceFrames: 15, onsetThreshold: 220, offsetThreshold: 120 });
    this.reset();
  }
  reset() {
    this.vad.reset();
    this.remainder = Buffer.alloc(0);
    this.preRoll = [];
    this.active = false;
    this.bytes = 0;
  }
  push(pcm) {
    const input = Buffer.concat([this.remainder, Buffer.from(pcm)]);
    const size = this.vad.frameSize * 2;
    let offset = 0;
    for (; offset + size <= input.length; offset += size) {
      const frame = input.subarray(offset, offset + size);
      this.vad.processChunk(frame);
      const speaking = this.vad.getState().isSpeaking;
      if (speaking && !this.active) {
        this.active = true;
        for (const prefix of this.preRoll) this._send(prefix);
        this.preRoll = [];
      }
      if (this.active) {
        this._send(frame);
        if (!speaking || this.bytes >= this.maxBytes) this.finalize();
      } else {
        this.preRoll.push(Buffer.from(frame));
        if (this.preRoll.length > 8) this.preRoll.shift();
      }
    }
    this.remainder = Buffer.from(input.subarray(offset));
  }
  _send(frame) { this.bytes += frame.length; this.onAudio(frame); }
  flush() {
    if (this.active && this.remainder.length) {
      this._send(this.remainder);
      this.remainder = Buffer.alloc(0);
    }
    this.finalize();
  }
  finalize() {
    if (!this.bytes) return;
    // The API requires at least 100 ms per commit, including short utterances.
    if (this.bytes < 3200) this._send(Buffer.alloc(3200 - this.bytes));
    this.onEnd();
    this.bytes = 0;
    this.active = false;
    this.vad.reset();
  }
}
module.exports = { StreamingTurnDetector };
