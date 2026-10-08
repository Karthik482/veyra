const SPOKEN_CATEGORIES = new Set(['behavioral', 'motivation', 'situational', 'experience', 'compensation']);
function useSpokenModel(mode, category, question = '') {
  if (mode === 'say') {
    // Fast spoken answers, with conservative exclusions for hard technical work.
    if (/\b(code|coding|program|implement|algorithm|complexity|sql|query|queries|design|architecture|architect|scale|scaling|trade.?offs?|debug|optimi[sz]e|distributed|concurrency|data structure|pseudocode|calculate|prove)\b/i.test(question)) return false;
    if (category === 'general') return true;
    if (category === 'technical' && /^(?:can you |could you |please )?(?:what (?:is|are)|explain|define|what does|difference between)\b/i.test(question.trim())) return true;
  }
  return (mode === 'say' || mode === 'assist') && SPOKEN_CATEGORIES.has(category);
}
function interviewerSources({ local, batch, streaming = {} }) {
  const sources = [local, batch].filter(Boolean).map(source => ({
    hasPending: () => source.hasPending('them'),
    requestFinalize: () => source.requestFinalize('them'),
  }));
  if (streaming.them) sources.push(streaming.them);
  return sources;
}
function questionKey(turn) {
  return turn ? `${turn.itemId || turn.startedAt || turn.seq || ''}:${turn.text}` : '';
}
// Stop waiting as soon as a new final lands, or a new partial stays stable.
function questionReadiness(getTurns, previousKey = '', stableMs = 180, now = Date.now, useExistingStability = false) {
  let signature = '', changedAt = now();
  return () => {
    const latest = getTurns().filter(turn => turn.channel === 'them').at(-1);
    const key = questionKey(latest);
    if (!key || key === previousKey) return false;
    if (latest.seq) return true;
    if (key !== signature) {
      signature = key;
      changedAt = useExistingStability && Number.isFinite(latest.updatedAt) ? Math.min(now(), latest.updatedAt) : now();
    }
    return latest.text.trim().split(/\s+/).length >= 4 && now() - changedAt >= stableMs;
  };
}
module.exports = { useSpokenModel, interviewerSources, questionKey, questionReadiness };
