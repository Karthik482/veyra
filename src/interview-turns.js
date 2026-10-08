// Merge finalized and pending speech in spoken order, not delivery order.
function currentInterviewTurns(transcript, interims = [], { afterSequence = 0, revision } = {}) {
  const finalized = transcript.filter(turn => (turn.seq || 0) > afterSequence &&
    (revision == null || turn.contextRevision == null || turn.contextRevision === revision));
  const pending = interims.filter(turn => turn.text?.trim() &&
    (revision == null || turn.revision == null || turn.revision === revision) &&
    !finalized.some(final => turn.itemId && final.itemId === turn.itemId && final.channel === turn.channel));
  return [...finalized, ...pending].sort((a, b) =>
    (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
}
module.exports = { currentInterviewTurns };
