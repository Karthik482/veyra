const { UtteranceSegmenter } = require('./utterance-segmenter');

// Reuse the local-Whisper silence segmentation for cloud fallback too.
class BatchTranscriber {
  constructor({ transcribe, onTranscript, onError = () => {}, onSpeechState = () => {} }) {
    this.pending = 0;
    this.closed = false;
    this.tails = { you: Promise.resolve(), them: Promise.resolve() };
    this.segmenters = new Map(['you', 'them'].map(channel => [channel, new UtteranceSegmenter({
      channel, overlapMs: 0,
      vadOptions: { onsetThreshold: channel === 'them' ? 200 : 220, offsetThreshold: 120, silenceFrames: 20 },
      onSpeechState,
      onUtterance: (source, pcm) => {
        if (this.closed) return;
        if (this.pending >= 8) { onError(new Error('Transcription is falling behind; an audio segment was skipped.')); return; }
        this.pending += 1;
        const startedAt = Date.now();
        this.tails[source] = this.tails[source].then(async () => {
          if (this.closed) return;
          const text = await transcribe(pcm);
          if (!this.closed && text) onTranscript(source, text, { startedAt });
        }).catch(onError).finally(() => { this.pending -= 1; });
      }
    })]));
  }
  push(channel, pcm) { if (!this.closed) this.segmenters.get(channel)?.push(pcm); }
  requestFinalize() { for (const segmenter of this.segmenters.values()) segmenter.flush(); }
  hasPending() { return this.pending > 0 || [...this.segmenters.values()].some(segmenter => segmenter.collecting); }
  stop() { this.closed = true; for (const segmenter of this.segmenters.values()) segmenter.reset(); }
}
module.exports = { BatchTranscriber };
