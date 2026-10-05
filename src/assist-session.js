const { createHash } = require('node:crypto');

const MAX_MANUAL_IMAGES = 4;
const MAX_ASSIST_TURNS = 3;
const MAX_HISTORY_CHARS = 18000;
const MAX_TEXT_CHARS = 16000;

// Assist settlement. The old contract was a flat 650 ms wait followed by an
// abort, which failed exactly when the user clicks immediately: the local
// silence detector had committed the audio but the provider's `completed` event
// had not come back yet, so nothing looked pending *and* no final existed. Then
// the final arrived after the answer had already been refused.
const SETTLE_TIMEOUT_MS = 650;
const SETTLE_STALL_MS = 1200;
const SETTLE_POLL_MS = 10;

function boundedText(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  const end = value.lastIndexOf(' ', limit);
  return value.slice(0, end > limit / 2 ? end : limit) + ' [truncated]';
}

class AssistSession {
  constructor() {
    this.revision = 0;
    this.clear();
    this.clearedAt = 0;
  }

  clear(afterSequence = 0) {
    this.revision += 1;
    this.afterSequence = afterSequence;
    this.clearedAt = Date.now();
    this.manual = [];
    this.anchor = null;
    this.current = null;
    this.history = [];
  }

  image(dataUrl, kind = 'manual', now = Date.now()) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl || '')) throw new Error('Screen capture returned no image.');
    if (dataUrl.length > 5 * 1024 * 1024) throw new Error('Screenshot is too large. Reduce the display resolution and try again.');
    return { dataUrl, kind, ts: now, hash: createHash('sha256').update(dataUrl).digest('hex') };
  }

  addScreenshot(dataUrl, now) {
    const shot = this.image(dataUrl, 'manual', now);
    if (this.manual.some(image => image.hash === shot.hash)) return { ...this.status(), duplicate: true };
    if (this.manual.length >= MAX_MANUAL_IMAGES) throw new Error(`Up to ${MAX_MANUAL_IMAGES} screenshots can be attached. Clear screenshots or start a new context.`);
    this.manual.push(shot);
    return { ...this.status(), duplicate: false };
  }

  clearScreenshots() { this.manual = []; return this.status(); }
  status() { return { screenshots: this.manual.length, maxScreenshots: MAX_MANUAL_IMAGES, previousTurns: this.history.length }; }

  build({ transcript, interims = [], freshDataUrl = null, now = Date.now() }) {
    const finalized = transcript.filter(turn => (turn.seq || 0) > this.afterSequence &&
      (turn.contextRevision == null || turn.contextRevision === this.revision) &&
      (!turn.startedAt || turn.startedAt >= this.clearedAt)).slice(-14);
    // Prefer whole recent utterances when bounding unusually long provider output.
    const recent = [];
    let length = 0;
    for (const turn of [...finalized].reverse()) {
      if (recent.length && length + turn.text.length > MAX_TEXT_CHARS) break;
      const text = boundedText(turn.text, MAX_TEXT_CHARS);
      recent.unshift({ ...turn, text });
      length += text.length;
    }
    const pending = interims.filter(turn => turn.text?.trim()).map(turn => ({ ...turn, text: boundedText(turn.text, 4000) }));
    const latestQuestion = [...recent, ...pending].filter(turn => turn.channel === 'them').at(-1)?.text || '';
    const conversation = recent.map(turn => `${turn.channel === 'them' ? 'Them' : 'You'}: ${turn.text}`).join('\n');
    const interimText = pending.map(turn => `${turn.channel === 'them' ? 'Them' : 'You'} (not yet final): ${turn.text}`).join('\n');
    let fresh = null;
    let duplicateSkipped = false;
    if (freshDataUrl) {
      fresh = this.image(freshDataUrl, 'current', now);
      duplicateSkipped = [...this.manual, this.anchor, this.current].filter(Boolean).some(image => image.hash === fresh.hash);
      if (!this.anchor) this.anchor = { ...fresh, kind: 'problem' };
      this.current = fresh;
    }
    const images = [];
    // Explicit captures come first, in capture order; retained problem/current screens follow.
    for (const shot of [...this.manual, this.anchor, this.current].filter(Boolean)) {
      if (!images.some(image => image.hash === shot.hash)) images.push(shot);
    }
    const imageLegend = images.map((image, index) => `Image ${index + 1}: ${image.kind} screen, captured ${new Date(image.ts).toISOString()}`).join('\n');
    const prompt = 'Recent conversation:\n' + (conversation || '(none)') +
      (interimText ? '\n\nLatest speech still being finalized (may be revised):\n' + interimText : '') +
      '\n\nLatest spoken question:\n' + (latestQuestion || '(use the visible problem and conversation)') +
      '\n\nScreenshots in attachment order:\n' + (imageLegend || '(none available)') +
      '\n\nUse the conversation, attached code/screens, and previous Assist exchanges together. Resolve follow-up references using this problem context. ' +
      'Answer the latest question directly; explain and show corrected code when requested. If necessary context is missing, say what is missing rather than inventing it.';
    return {
      prompt, latestQuestion, finalized: recent, pending, images, duplicateSkipped,
      freshCaptured: !!fresh, revision: this.revision,
      turns: [...this.history.flatMap(turn => [
        { role: 'user', text: turn.question }, { role: 'assistant', text: turn.answer }
      ]), { role: 'user', text: prompt }]
    };
  }

  remember(context, answer) {
    if (context.revision !== this.revision || !answer?.trim()) return;
    const question = boundedText('Spoken question: ' + context.latestQuestion + '\n\n' + context.prompt, 6000);
    this.history.push({ question, answer: boundedText(answer, 6000) });
    while (this.history.length > MAX_ASSIST_TURNS || (this.history.length > 1 &&
      this.history.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0) > MAX_HISTORY_CHARS)) this.history.shift();
  }
}

function pendingSignature(active) {
  return active.map((source) => {
    if (typeof source.pendingSignature === 'function') {
      try { return source.pendingSignature(); } catch { return 'unavailable'; }
    }
    return source.hasPending?.() ? 'pending' : 'idle';
  }).join('|');
}

function hasPending(active) { return active.some(source => source.hasPending?.()); }

// Ask every source to flush, then wait for the resulting finals. Returns what
// happened so the caller can log it and decide whether to proceed: a slow
// provider annotates the Assist request, it never cancels it.
async function settleTranscription(sources, options = {}) {
  const settings = typeof options === 'number' ? { timeoutMs: options } : (options || {});
  const timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : SETTLE_TIMEOUT_MS;
  const stallMs = Number.isFinite(settings.stallMs) ? settings.stallMs : 0;
  const pollMs = Number.isFinite(settings.pollMs) ? settings.pollMs : SETTLE_POLL_MS;

  const active = sources.filter(Boolean);
  for (const source of active) {
    // A provider that cannot flush must not block Assist.
    try { source.requestFinalize?.(); } catch { /* ignored */ }
  }

  const began = Date.now();
  if (!hasPending(active)) return { settled: true, pending: false, timedOut: false, stalled: false, waitedMs: 0 };

  const deadline = began + timeoutMs;
  let signature = pendingSignature(active);
  let lastProgressAt = began;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    if (!hasPending(active)) {
      return { settled: true, pending: false, timedOut: false, stalled: false, waitedMs: Date.now() - began };
    }
    const next = pendingSignature(active);
    if (next !== signature) { signature = next; lastProgressAt = Date.now(); continue; }
    if (stallMs > 0 && Date.now() - lastProgressAt >= stallMs) {
      return { settled: false, pending: true, timedOut: false, stalled: true, waitedMs: Date.now() - began };
    }
  }
  return { settled: false, pending: true, timedOut: true, stalled: false, waitedMs: Date.now() - began };
}

module.exports = {
  AssistSession,
  settleTranscription,
  pendingSignature,
  SETTLE_TIMEOUT_MS,
  SETTLE_STALL_MS,
  MAX_MANUAL_IMAGES,
  MAX_ASSIST_TURNS
};
