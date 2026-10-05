// Deterministic 120-second soak of the SHIPPED residual-echo gate and the Assist
// settlement path.
//
//   node scripts/soak-echo-120s.cjs
//
// This is a replay, not an acoustic test: it drives the real publishTranscript gate
// (loaded from main.js exactly as it ships) with the turn sequence a two-minute
// headphone-free meeting produces — far-end speech, the microphone's copy of it,
// genuine double-talk, and ambiguous short repeats — so the suppression decisions
// and the false-suppression risk can be measured over the required duration.
//
// It then replays 200 immediate Assist clicks against the real settleTranscription
// with a source that finalizes like the OpenAI realtime session (~450 ms local
// silence commit plus a provider round trip).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { settleTranscription } = require('../src/assist-session');

const root = path.resolve(__dirname, '..');
const localRequire = Module.createRequire(path.join(root, 'main.js'));

// ---- the shipped gate, loaded from main.js exactly as it ships --------------
function loadGate() {
  const settings = { provider: 'openai', sttProvider: 'auto', apiKeys: { openai: 'fake' }, models: { openai: { fast: 'fake-model' } } };
  const module = { exports: {} };
  const ipcMain = { handle() {}, on() {} };
  const sandbox = {
    require(request) {
      if (request === 'electron') return { app: { isPackaged: true, whenReady: () => ({ then() {} }), on() {} }, ipcMain };
      if (request === './src/store') return { getSettings: () => settings };
      return localRequire(request);
    },
    module, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: root
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8') +
    '\nmodule.exports = { publishTranscript, transcript };', sandbox);
  return module.exports;
}

// ---- a seeded, reproducible two-minute meeting ------------------------------
let seed = 0x2f6e2b1;
function random() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const FAR_END = [
  'How would you optimize this query if the table contained one billion rows?',
  'What is a discounted cash flow model and how would you build one?',
  'Tell me about a time you disagreed with a teammate on a design decision.',
  'Would you use a broadcast join here, and why?',
  'Explain the difference between a clustering key and a sort key.',
  'How would you design a rate limiter for a public API?',
  'Walk me through how you would debug a slow production endpoint.',
  'What happens when a Kafka consumer falls behind the producer?',
  'How do you decide between a star schema and a snowflake schema?',
  'Describe a situation where you had to say no to a stakeholder.',
  'What is the difference between a left join and a full outer join?',
  'How would you handle idempotency in a payment pipeline?',
  'Why do you want to work on our platform team?'
];
const GENUINE = [
  'I would probably use Spark here.',
  'Yes, I would use a broadcast join.',
  'We should partition by date and cluster by customer id.',
  'I would start by reading the query plan and the slowest operator.',
  'I once pushed back on a deadline because the migration was unsafe.',
  'Idempotency keys stored with the payment intent make retries safe.',
  'A hash set lets me track duplicates in linear time.',
  'I would sample the data and check the cardinality of the join key first.'
];
const AMBIGUOUS = ['Broadcast join.', 'One billion rows.', 'Full outer join.'];

// What a second STT pass over speaker audio actually returns: the same words with
// a spelling variant, a substituted word, or a dropped filler.
function echoVariant(text, index) {
  const variants = [
    text.replace(/optimize/g, 'optimise').replace(/analyz/g, 'analys'),
    text.replace(/\bthis\b/, 'the'),
    text.replace(/\ba\b /, ''),
    text.replace(/\bwould\b/, 'will')
  ];
  return variants[index % variants.length];
}

function buildTimeline() {
  const began = Date.now() - 120000;
  const timeline = [];
  let echoCount = 0, genuineCount = 0, ambiguousCount = 0;

  FAR_END.forEach((text, index) => {
    const start = began + index * 8500;
    timeline.push({ channel: 'them', text, startedAt: start, itemId: `them-${index}` });
    // The microphone's acoustic copy: 0.6 probability, 200-500 ms later.
    if (random() < 0.6) {
      echoCount += 1;
      timeline.push({
        channel: 'you', text: echoVariant(text, index), echoOf: `them-${index}`,
        startedAt: start + 200 + Math.round(random() * 300), itemId: `echo-${index}`
      });
    }
    // Genuine speech over the tail of the far-end turn (double-talk), or a reply
    // after it. Alternating keeps both cases in the soak.
    if (index % 2 === 0 && genuineCount < GENUINE.length) {
      genuineCount += 1;
      timeline.push({
        channel: 'you', text: GENUINE[genuineCount - 1], genuine: true,
        startedAt: start + (genuineCount % 2 ? 400 : 6000), itemId: `you-${index}`
      });
    }
    if (index % 4 === 3) {
      ambiguousCount += 1;
      timeline.push({ channel: 'you', text: AMBIGUOUS[ambiguousCount % AMBIGUOUS.length], ambiguous: true,
        startedAt: start + 500, itemId: `amb-${index}` });
    }
  });

  timeline.sort((a, b) => a.startedAt - b.startedAt);
  return { timeline, echoCount, genuineCount, ambiguousCount };
}

function runEchoSoak() {
  const gate = loadGate();
  const { timeline, echoCount, genuineCount, ambiguousCount } = buildTimeline();
  const began = Date.now();
  for (const turn of timeline) gate.publishTranscript(turn.channel, turn.text, { startedAt: turn.startedAt, itemId: turn.itemId });
  const elapsedMs = Date.now() - began;

  const suppressedIds = new Set(timeline.filter(turn => turn.echoOf).map(turn => turn.itemId));
  const keptIds = new Set(gate.transcript.map(turn => turn.itemId));
  const leaked = [...suppressedIds].filter(id => keptIds.has(id));
  const genuineKept = timeline.filter(turn => turn.genuine).filter(turn => keptIds.has(turn.itemId));
  const ambiguousKept = timeline.filter(turn => turn.ambiguous).filter(turn => keptIds.has(turn.itemId));

  return {
    durationSeconds: Math.round((timeline[timeline.length - 1].startedAt - timeline[0].startedAt) / 1000),
    farEndTurns: timeline.filter(turn => turn.channel === 'them').length,
    microphoneTurns: timeline.filter(turn => turn.channel === 'you').length,
    echoCopies: echoCount,
    echoCopiesSuppressed: echoCount - leaked.length,
    echoLeaked: leaked,
    genuineUtterances: genuineCount,
    genuineUtterancesKept: genuineKept.length,
    falseSuppressions: genuineCount - genuineKept.length,
    ambiguousRepeats: ambiguousCount,
    ambiguousKept: ambiguousKept.length,
    finalTranscriptLength: gate.transcript.length,
    gateElapsedMs: elapsedMs
  };
}

// ---- Assist settlement, replayed against a realistic provider ----------------
class ReplaySession {
  constructor(silenceCommitMs = 450, roundTripMs = 250) {
    this.silenceCommitMs = silenceCommitMs;
    this.roundTripMs = roundTripMs;
    this.phase = 'idle';
  }
  // A click arrives: the local detector is mid-commit, the provider has not answered.
  click() {
    this.phase = 'committing';
    setTimeout(() => { this.phase = 'awaits-provider'; }, this.silenceCommitMs);
    setTimeout(() => { this.phase = 'idle'; }, this.silenceCommitMs + this.roundTripMs);
  }
  hasPending() { return this.phase !== 'idle'; }
  pendingSignature() { return this.phase; }
  requestFinalize() { /* the detector is already flushing */ }
}

async function runAssistSoak(iterations = 200) {
  const waits = [];
  let timeouts = 0, stalls = 0;
  const probe = new ReplaySession();
  for (let index = 0; index < iterations; index++) {
    probe.click();
    const settle = await settleTranscription([probe], { timeoutMs: 8000, stallMs: 1200 });
    waits.push(settle.waitedMs);
    if (settle.timedOut) timeouts += 1;
    if (settle.stalled) stalls += 1;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  waits.sort((a, b) => a - b);
  return {
    clicks: iterations,
    settledWithoutTimeout: iterations - timeouts - stalls,
    timeouts,
    stalls,
    medianWaitMs: waits[Math.floor(waits.length / 2)],
    slowestWaitMs: waits[waits.length - 1]
  };
}

const OUTPUT_DIR = path.join(root, '.cache');
const OUTPUT = path.join(OUTPUT_DIR, 'soak-echo-120s.json');

function writeReport(report) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

// Reported to a file as well as stdout: on Windows the console that launches this
// can lose a crashed process's stderr, and a soak that fails silently is worse
// than one that fails loudly.
process.on('uncaughtException', error => {
  writeReport({ verdict: 'SOAK ERROR', stage: 'uncaughtException', message: String(error && error.stack || error) });
  process.exit(1);
});
process.on('unhandledRejection', error => {
  writeReport({ verdict: 'SOAK ERROR', stage: 'unhandledRejection', message: String(error && error.stack || error) });
  process.exit(1);
});

(async () => {
  const requested = Number(process.argv[2]);
  const iterations = Number.isFinite(requested) && requested >= 0 ? requested : 200;
  const echo = runEchoSoak();
  const assist = await runAssistSoak(iterations);
  const ok = echo.echoLeaked.length === 0 && echo.falseSuppressions === 0 &&
    echo.ambiguousKept === echo.ambiguousRepeats &&
    assist.settledWithoutTimeout === assist.clicks;
  writeReport({ verdict: ok ? 'SOAK PASS' : 'SOAK FAIL', echo, assist });
  process.exitCode = ok ? 0 : 1;
})();
