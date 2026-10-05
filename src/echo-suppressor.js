// Conservative transcript-level residual-echo filter.
//
// Designed for Veyra's Windows architecture:
//   loopback -> Them
//   physical microphone -> You
//
// Far-end speech played by Teams/Zoom/YouTube can also reach the physical mic.
// This module suppresses only HIGH-CONFIDENCE residual transcript duplicates.
// It deliberately prefers false negatives (keeping some echo) over false
// positives (deleting genuine user speech).

const SPELLING_VARIANTS = Object.freeze([
  [/isation\b/g, 'ization'],
  [/ising\b/g, 'izing'],
  [/ised\b/g, 'ized'],
  [/iser\b/g, 'izer'],
  [/ise\b/g, 'ize'],
  [/\bcolour/g, 'color'],
  [/\bbehaviour/g, 'behavior'],
  [/\bneighbour/g, 'neighbor'],
  [/\bcentre\b/g, 'center'],
  [/\bmetre\b/g, 'meter'],
  [/\blicence\b/g, 'license'],
  [/\bpaediatric/g, 'pediatric'],
  [/\bcatalogue\b/g, 'catalog']
]);

const ECHO_OPTIONS = Object.freeze({
  minTokens: 4,

  // Strong full-sequence match path.
  minSimilarity: 0.75,
  minConfidence: 0.82,

  // Degraded acoustic-STT path.
  // This does NOT simply lower minSimilarity.
  degradedMinCoverage: 0.88,
  degradedMinOrderedCoverage: 0.72,
  degradedMinSourceCoverage: 0.42,
  degradedMinConfidence: 0.86,

  leadToleranceMs: 300,
  trailToleranceMs: 900,
  timingDecayMs: 900,

  // Echo may lose words, but should not invent a substantially longer answer.
  tokenRatioCeiling: 1.25,
  tokenRatioSpan: 0.5,

  candidateWindowMs: 20000,
  maxCandidates: 12
});

function normalizeText(text) {
  let value = String(text || '').toLowerCase();

  for (const [pattern, replacement] of SPELLING_VARIANTS) {
    value = value.replace(pattern, replacement);
  }

  return value.replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeTokens(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index
  );

  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const substitution =
        previous[j - 1] +
        (a[i - 1] === b[j - 1] ? 0 : 1);

      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        substitution
      );
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length];
}

// 1 = identical token sequences.
function sequenceSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);

  if (!longest) return 0;

  return Math.max(
    0,
    1 - editDistance(a, b) / longest
  );
}

// Fraction of MIC tokens that also occur in the far-end transcript.
// Multiset-based so repeated words cannot inflate the result.
function tokenCoverage(micTokens, themTokens) {
  const remaining = new Map();

  for (const token of themTokens) {
    remaining.set(
      token,
      (remaining.get(token) || 0) + 1
    );
  }

  let covered = 0;

  for (const token of micTokens) {
    const left = remaining.get(token) || 0;

    if (left > 0) {
      remaining.set(token, left - 1);
      covered += 1;
    }
  }

  return micTokens.length
    ? covered / micTokens.length
    : 0;
}

// Fraction of far-end tokens represented by the microphone transcript.
// This prevents a tiny generic fragment from matching a long question.
function sourceCoverage(micTokens, themTokens) {
  if (!themTokens.length) return 0;

  const remaining = new Map();

  for (const token of micTokens) {
    remaining.set(
      token,
      (remaining.get(token) || 0) + 1
    );
  }

  let covered = 0;

  for (const token of themTokens) {
    const left = remaining.get(token) || 0;

    if (left > 0) {
      remaining.set(token, left - 1);
      covered += 1;
    }
  }

  return covered / themTokens.length;
}

// Longest-common-subsequence coverage of the MIC transcript.
//
// Acoustic echo STT often drops words while preserving order.
// LCS catches that without treating a bag of shared interview
// vocabulary as an echo.
function orderedCoverage(micTokens, themTokens) {
  if (!micTokens.length || !themTokens.length) {
    return 0;
  }

  let previous =
    new Array(themTokens.length + 1).fill(0);

  let current =
    new Array(themTokens.length + 1).fill(0);

  for (let i = 1; i <= micTokens.length; i++) {
    current[0] = 0;

    for (let j = 1; j <= themTokens.length; j++) {
      current[j] =
        micTokens[i - 1] === themTokens[j - 1]
          ? previous[j - 1] + 1
          : Math.max(
              previous[j],
              current[j - 1]
            );
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  return (
    previous[themTokens.length] /
    micTokens.length
  );
}

function turnStart(turn) {
  return turn.startedAt != null
    ? turn.startedAt
    : (turn.ts || 0);
}

function turnEnd(turn) {
  return turn.endedAt != null
    ? turn.endedAt
    : (
        turn.startedAt != null
          ? turn.startedAt
          : (turn.ts || 0)
      );
}

// Echo should begin at roughly the same time as the far-end audio
// or shortly afterwards.
//
// If the user clearly began speaking BEFORE the far-end audio,
// protect it as double-talk rather than suppressing it.
function timingScore(mic, them, options) {
  const lag =
    turnStart(mic) -
    turnStart(them);

  if (lag < -options.leadToleranceMs) {
    return 0;
  }

  const sourceDuration = Math.max(
    0,
    turnEnd(them) - turnStart(them)
  );

  const allowed =
    sourceDuration +
    options.trailToleranceMs;

  if (lag <= allowed) {
    return 1;
  }

  return Math.max(
    0,
    1 -
      (lag - allowed) /
        options.timingDecayMs
  );
}

function lengthScore(
  micCount,
  themCount,
  options
) {
  if (!themCount) return 0;

  const ratio =
    micCount / themCount;

  // Lost words are normal for acoustic echo STT.
  //
  // Added words are more suspicious because they may represent
  // an actual response from the user.
  if (ratio <= options.tokenRatioCeiling) {
    return 1;
  }

  return Math.max(
    0,
    1 -
      (
        ratio -
        options.tokenRatioCeiling
      ) /
        options.tokenRatioSpan
  );
}

function echoConfidence(
  mic,
  them,
  options = ECHO_OPTIONS
) {
  const micTokens =
    normalizeTokens(mic && mic.text);

  const themTokens =
    normalizeTokens(them && them.text);

  if (
    micTokens.length < options.minTokens ||
    themTokens.length === 0
  ) {
    return {
      confidence: 0,
      reason: 'ambiguous-short-utterance',
      micTokens: micTokens.length,
      themTokens: themTokens.length
    };
  }

  const timing =
    timingScore(
      mic,
      them,
      options
    );

  if (!timing) {
    return {
      confidence: 0,
      reason: 'no-interval-overlap',
      timing,
      micTokens: micTokens.length,
      themTokens: themTokens.length
    };
  }

  const similarity =
    sequenceSimilarity(
      micTokens,
      themTokens
    );

  const coverage =
    tokenCoverage(
      micTokens,
      themTokens
    );

  const ordered =
    orderedCoverage(
      micTokens,
      themTokens
    );

  const source =
    sourceCoverage(
      micTokens,
      themTokens
    );

  const length =
    lengthScore(
      micTokens.length,
      themTokens.length,
      options
    );

  // -------------------------------------------------------
  // PATH 1:
  // Strong near-identical transcript.
  // -------------------------------------------------------

  const textual =
    Math.sqrt(
      similarity *
      coverage
    );

  const strictConfidence =
    textual *
    timing *
    length;

  if (
    similarity >=
      options.minSimilarity &&
    strictConfidence >=
      options.minConfidence
  ) {
    return {
      confidence: strictConfidence,
      similarity,
      coverage,
      orderedCoverage: ordered,
      sourceCoverage: source,
      timing,
      length,
      textual,
      path: 'strict-sequence',
      reason: 'probable-echo'
    };
  }

  // -------------------------------------------------------
  // PATH 2:
  // Degraded acoustic microphone transcription.
  //
  // Example:
  //
  // Them:
  // "how would you optimize this query if the table
  // contained one billion rows"
  //
  // Mic:
  // "optimize this query table one billion rows"
  //
  // Most mic words still came from Them and remain in
  // approximately the same order, even though the normal
  // Levenshtein similarity is much lower.
  // -------------------------------------------------------

  const enoughForDegradedPath =
    micTokens.length >=
      Math.max(
        options.minTokens + 1,
        5
      ) &&

    coverage >=
      options.degradedMinCoverage &&

    ordered >=
      options.degradedMinOrderedCoverage &&

    source >=
      options.degradedMinSourceCoverage &&

    length > 0;

  // Weight containment and ordering much more heavily
  // than full edit-distance similarity.
  const degradedTextual =
    0.40 * coverage +
    0.35 * ordered +
    0.15 * source +
    0.10 * similarity;

  const degradedConfidence =
    degradedTextual *
    timing *
    length;

  if (
    enoughForDegradedPath &&
    degradedConfidence >=
      options.degradedMinConfidence
  ) {
    return {
      confidence:
        degradedConfidence,

      similarity,
      coverage,

      orderedCoverage:
        ordered,

      sourceCoverage:
        source,

      timing,
      length,

      textual:
        degradedTextual,

      strictConfidence,

      path:
        'degraded-acoustic',

      reason:
        'probable-echo'
    };
  }

  // Not confident enough.
  // KEEP the user's microphone turn.
  return {
    confidence:
      Math.max(
        strictConfidence,
        degradedConfidence
      ),

    similarity,
    coverage,

    orderedCoverage:
      ordered,

    sourceCoverage:
      source,

    timing,
    length,

    textual:
      Math.max(
        textual,
        degradedTextual
      ),

    strictConfidence,
    degradedConfidence,

    path: null,

    reason:
      similarity <
      options.minSimilarity
        ? 'text-differs'
        : 'below-threshold'
  };
}

// Returns the best HIGH-CONFIDENCE far-end match.
//
// null means:
// KEEP the microphone turn.
function findResidualEcho(
  micTurn,
  themTurns,
  overrides = {}
) {
  const options = {
    ...ECHO_OPTIONS,
    ...overrides
  };

  if (
    !micTurn ||
    !micTurn.text ||
    !/^you$/i.test(
      micTurn.speaker ??
      micTurn.channel ??
      'you'
    )
  ) {
    return null;
  }

  const micStart =
    turnStart(micTurn);

  let best = null;

  for (
    const them of
    (themTurns || [])
      .slice(-options.maxCandidates)
  ) {
    if (
      !them ||
      !them.text
    ) {
      continue;
    }

    if (
      Math.abs(
        turnStart(them) -
        micStart
      ) >
      options.candidateWindowMs
    ) {
      continue;
    }

    const scored =
      echoConfidence(
        micTurn,
        them,
        options
      );

    if (
      !best ||
      scored.confidence >
        best.confidence
    ) {
      best = {
        ...scored,
        them
      };
    }
  }

  if (
    !best ||
    best.reason !==
      'probable-echo'
  ) {
    return null;
  }

  return best;
}

module.exports = {
  ECHO_OPTIONS,
  normalizeTokens,
  sequenceSimilarity,
  tokenCoverage,
  sourceCoverage,
  orderedCoverage,
  echoConfidence,
  findResidualEcho
};
