/**

- Forecaster — Continuous Background Forecast Engine
- 
- Runs every 3 minutes independently of the market window loop.
- Maintains a forecast state that agent.js reads before each signal evaluation.
- 
- Two purposes:
- 1. Pre-compute directional bias BEFORE a new window opens so the engine
- ```
   can fire in the first 90 seconds rather than waiting for data to accumulate.
  ```
- 
- 1. Allow evaluation of one-sided markets when the forecast DISAGREES with
- ```
   the crowd pricing — that disagreement is where contrarian edge lives.
  ```
- 
- Factors computed (each contributes −2 to +2):
- 1. 15m MACD crossover      — freshness of momentum shift
- 1. RSI divergence/exhaustion — continuation vs reversal signal
- 1. Volume velocity spike    — pump and dump detection
- 1. Price ROC acceleration   — is momentum building or dying
- 1. 15m EMA trend            — macro directional bias
- 
- Score range: −10 to +10
- 3 → forecast UP   (confidence = score / 10)
- < −3 → forecast DOWN (confidence = abs(score) / 10)
- −3 to 3 → NEUTRAL
- 
- No circular imports. Only depends on perception.js and config.js.
  */

import { fetchBTCKlines, fetchBTCKlines15m } from ‘./perception.js’;
import { HTF_CANDLE_LIMIT, REGIME_CANDLE_LIMIT } from ‘./config.js’;

const FORECAST_INTERVAL_MS   = 3 * 60_000;  // re-compute every 3 minutes
const VOLUME_SPIKE_THRESHOLD  = 3.0;         // 3× rolling average = spike
const VOLUME_SPIKE_LOOKBACK   = 20;          // candles for rolling average
const SCORE_THRESHOLD         = 5;           // net score required for directional call (was 3)
const MAX_SCORE               = 12;          // 6 factors × max ±2 each
const SPIKE_TTL_MS            = 10 * 60_000; // clear spike record after 10 minutes

// ── Shared forecast state ─────────────────────────────────────────────────────
const forecastState = {
direction:        null,   // ‘UP’ | ‘DOWN’ | ‘NEUTRAL’ | null (null = never computed)
confidence:       0,      // 0–1
score:            0,      // raw aggregate score
basis:            [],     // human-readable factor labels
updatedAt:        null,   // ISO string of last successful computation
volumeSpike:      null,   // { direction, magnitude, pricePct, detectedAt } | null
spikeDetectedAt:  null,   // ISO string, used for TTL
triggeredBy:      null,   // ‘scheduled’ | ‘one-sided-market (yesPrice=X)’
};

// ── Math helpers (self-contained, no imports from signal.js) ──────────────────

function _ema(values, period) {
if (values.length < period) return [];
const k    = 2 / (period + 1);
let   prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
const out  = [prev];
for (let i = period; i < values.length; i++) {
prev = values[i] * k + prev * (1 - k);
out.push(prev);
}
return out;
}

function _rsi(closes, period = 14) {
if (closes.length <= period) return null;
let gain = 0, loss = 0;
for (let i = 1; i <= period; i++) {
const d = closes[i] - closes[i - 1];
if (d >= 0) gain += d; else loss -= d;
}
let ag = gain / period, al = loss / period;
for (let i = period + 1; i < closes.length; i++) {
const d = closes[i] - closes[i - 1];
ag = (ag * (period - 1) + (d > 0 ?  d : 0)) / period;
al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
}
if (al === 0) return 100;
return 100 - 100 / (1 + ag / al);
}

function _macd(closes) {
const e12 = _ema(closes, 12);
const e26 = _ema(closes, 26);
if (!e12.length || !e26.length) return null;
const offset   = 26 - 12;
const macdLine = e26.map((v, i) => e12[i + offset] - v);
const sig      = _ema(macdLine, 9);
if (sig.length < 2) return null;
return {
macd:      macdLine.at(-1),
signal:    sig.at(-1),
prevMacd:  macdLine.at(-2) ?? macdLine.at(-1),
prevSig:   sig.at(-2)      ?? sig.at(-1),
histogram: macdLine.at(-1) - sig.at(-1),
};
}

// ── Factor 1: 15m MACD crossover (−2 to +2) ──────────────────────────────────
// Fresh cross = highest conviction (±2). Sustained position = moderate (±1).
function scoreMACDCrossover(candles15m) {
const closes = candles15m.map(c => c.close);
const m      = _macd(closes);
if (!m) return { score: 0, label: ‘MACD(15m): insufficient data’ };

const crossedUp   = m.prevMacd <= m.prevSig && m.macd > m.signal;
const crossedDown = m.prevMacd >= m.prevSig && m.macd < m.signal;
const h           = m.histogram.toFixed(2);

if (crossedUp)         return { score:  2, label: `MACD(15m): fresh bullish cross (hist=${h})` };
if (crossedDown)       return { score: -2, label: `MACD(15m): fresh bearish cross (hist=${h})` };
if (m.macd > m.signal) return { score:  1, label: `MACD(15m): above signal (hist=${h})` };
if (m.macd < m.signal) return { score: -1, label: `MACD(15m): below signal (hist=${h})` };
return { score: 0, label: ‘MACD(15m): at signal line’ };
}

// ── Factor 2: RSI divergence / exhaustion (−2 to +2) ─────────────────────────
// Overbought + decelerating RSI = likely reversal DOWN next window.
// Oversold  + recovering  RSI = likely reversal UP next window.
// Mid-range trending RSI = continuation.
function scoreRSIDivergence(candles15m) {
const closes = candles15m.map(c => c.close);
if (closes.length < 20) return { score: 0, label: ‘RSI(15m): insufficient data’ };

const rsiNow  = _rsi(closes, 14);
const rsiPrev = _rsi(closes.slice(0, -2), 14);
if (rsiNow === null) return { score: 0, label: ‘RSI(15m): calculation failed’ };

const accel    = rsiPrev !== null ? rsiNow - rsiPrev : 0;
const rsiLabel = rsiNow.toFixed(1);
const accLabel = accel.toFixed(1);

// Overbought zone (>70)
if (rsiNow > 70) {
if (accel < -2) return { score: -2, label: `RSI(15m): overbought exhaustion (rsi=${rsiLabel} Δ=${accLabel})` };
if (accel >= 0) return { score:  1, label: `RSI(15m): overbought continuation (rsi=${rsiLabel})` };
return { score: -1, label: `RSI(15m): overbought fading (rsi=${rsiLabel} Δ=${accLabel})` };
}

// Oversold zone (<30)
if (rsiNow < 30) {
if (accel > 2)  return { score:  2, label: `RSI(15m): oversold reversal (rsi=${rsiLabel} Δ=+${accLabel})` };
if (accel <= 0) return { score: -1, label: `RSI(15m): oversold continuation (rsi=${rsiLabel})` };
return { score:  1, label: `RSI(15m): oversold recovering (rsi=${rsiLabel} Δ=+${accLabel})` };
}

// Bullish momentum zone: 50–70 and rising
if (rsiNow > 50 && accel > 0) return { score:  1, label: `RSI(15m): bullish zone rising (rsi=${rsiLabel})` };
// Bearish momentum zone: 30–50 and falling
if (rsiNow < 50 && accel < 0) return { score: -1, label: `RSI(15m): bearish zone falling (rsi=${rsiLabel})` };

return { score: 0, label: `RSI(15m): neutral (rsi=${rsiLabel})` };
}

// ── Factor 3: Volume velocity spike (−2 to +2) ────────────────────────────────
// Volume > 3× rolling average AND meaningful price move = pump or dump.
// Returns a spike descriptor that gets stored on forecastState for agent.js use.
function scoreVolumeVelocity(candles1m) {
if (candles1m.length < VOLUME_SPIKE_LOOKBACK + 1) {
return { score: 0, label: ‘Volume(1m): insufficient data’, spike: null };
}

const recent  = candles1m.slice(-(VOLUME_SPIKE_LOOKBACK + 1));
const volumes = recent.map(c => c.volume);
const lastVol = volumes.at(-1);
const avgVol  = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
const ratio   = avgVol > 0 ? lastVol / avgVol : 1;

const lastCandle = candles1m.at(-1);
const prevCandle = candles1m.at(-2);
const priceMove  = prevCandle.close > 0
? (lastCandle.close - prevCandle.close) / prevCandle.close
: 0;

let spike = null;

if (ratio >= VOLUME_SPIKE_THRESHOLD) {
spike = {
direction:  priceMove >= 0 ? ‘UP’ : ‘DOWN’,
magnitude:  ratio,
pricePct:   (priceMove * 100).toFixed(3),
detectedAt: new Date().toISOString(),
};

```
if (priceMove > 0.003) {
  return {
    score: 2,
    label: `Volume(1m): PUMP spike ${ratio.toFixed(2)}× — price +${(priceMove * 100).toFixed(3)}%`,
    spike,
  };
}
if (priceMove < -0.003) {
  return {
    score: -2,
    label: `Volume(1m): DUMP spike ${ratio.toFixed(2)}× — price ${(priceMove * 100).toFixed(3)}%`,
    spike,
  };
}
// Spike but small price move — elevated but not directional
return {
  score: priceMove >= 0 ? 1 : -1,
  label: `Volume(1m): spike ${ratio.toFixed(2)}× but small price move (${(priceMove * 100).toFixed(3)}%)`,
  spike,
};
```

}

if (ratio >= 1.5) {
return {
score: priceMove > 0 ? 1 : priceMove < 0 ? -1 : 0,
label: `Volume(1m): elevated ${ratio.toFixed(2)}× — price ${priceMove > 0 ? 'up' : 'down'}`,
spike: null,
};
}

return { score: 0, label: `Volume(1m): normal (${ratio.toFixed(2)}× avg)`, spike: null };
}

// ── Factor 4: Price ROC acceleration (−2 to +2) ───────────────────────────────
// ROC of last 3 candles vs prior 3 candles.
// Accelerating in same direction = momentum building = continuation.
// Decelerating = momentum dying = possible reversal coming.
function scoreROCAcceleration(candles1m) {
if (candles1m.length < 9) return { score: 0, label: ‘ROC(1m): insufficient data’ };

const closes = candles1m.map(c => c.close);
const n      = closes.length;

if (closes[n - 4] <= 0 || closes[n - 7] <= 0) return { score: 0, label: ‘ROC(1m): invalid prices’ };

const roc3  = (closes[n - 1] - closes[n - 4]) / closes[n - 4]; // last 3 bars
const roc3p = (closes[n - 4] - closes[n - 7]) / closes[n - 7]; // prior 3 bars
const accel = roc3 - roc3p;

const pct  = (roc3  * 100).toFixed(3);
const apct = (accel * 100).toFixed(3);

if (roc3 > 0 && accel >  0.0005) return { score:  2, label: `ROC(1m): accelerating UP (${pct}% Δ=+${apct}%)` };
if (roc3 > 0 && accel >= 0)      return { score:  1, label: `ROC(1m): steady UP (${pct}%)` };
if (roc3 > 0 && accel < -0.0005) return { score: -1, label: `ROC(1m): UP but decelerating — reversal watch` };
if (roc3 < 0 && accel < -0.0005) return { score: -2, label: `ROC(1m): accelerating DOWN (${pct}% Δ=${apct}%)` };
if (roc3 < 0 && accel <= 0)      return { score: -1, label: `ROC(1m): steady DOWN (${pct}%)` };
if (roc3 < 0 && accel >  0.0005) return { score:  1, label: `ROC(1m): DOWN but decelerating — reversal watch` };

return { score: 0, label: `ROC(1m): flat (${pct}%)` };
}

// ── Factor 5: 15m EMA trend (−2 to +2) ───────────────────────────────────────
// EMA(9) vs EMA(21) on 15m gives the macro directional bias.
// Wide separation = strong trend. Tight = ambiguous.
function scoreEMATrend(candles15m) {
if (candles15m.length < 21) return { score: 0, label: ‘EMA(15m): insufficient data’ };

const closes  = candles15m.map(c => c.close);
const ema9    = _ema(closes, 9);
const ema21   = _ema(closes, 21);
const price   = closes.at(-1);

if (!ema9.length || !ema21.length || price <= 0) return { score: 0, label: ‘EMA(15m): calculation failed’ };

const sep    = (ema9.at(-1) - ema21.at(-1)) / price;
const sepPct = (sep * 100).toFixed(3);

if (sep >  0.001) return { score:  2, label: `EMA(15m): strong bull (sep=+${sepPct}%)` };
if (sep >  0)     return { score:  1, label: `EMA(15m): mild bull (sep=+${sepPct}%)` };
if (sep < -0.001) return { score: -2, label: `EMA(15m): strong bear (sep=${sepPct}%)` };
if (sep <  0)     return { score: -1, label: `EMA(15m): mild bear (sep=${sepPct}%)` };

return { score: 0, label: ‘EMA(15m): aligned (no separation)’ };
}

// ── Factor 6: Crowd signal — one-sided market analysis (−2 to +2) ────────────
//
// This is the core of next-window forecasting from a one-sided market.
// When yesPrice > 0.75 or < 0.25, the crowd has already committed heavily
// to a direction. The question for the NEXT window is:
//   - Is that commitment backed by real momentum? → continuation
//   - Or is momentum fading/reversing despite the crowd? → reversal
//
// Reversal indicators (crowd over-extended):
//   UP crowd + RSI > 70 + momentum decelerating  → DOWN reversal next window
//   UP crowd + RSI contradicts (<50 despite UP)  → DOWN reversal next window
//   DOWN crowd + RSI < 30 + momentum recovering  → UP reversal next window
//   DOWN crowd + RSI contradicts (>50 despite DWN)→ UP reversal next window
//
// Continuation indicators (crowd backed by genuine momentum):
//   UP crowd + RSI > 60 + volume spike + ROC accelerating → UP continuation
//   DOWN crowd + RSI < 40 + volume spike + ROC accelerating → DOWN continuation
//
// Returns score = 0 when yesPrice is balanced (0.25–0.75) — not applicable.
function scoreCrowdSignal(yesPrice, candles1m, candles15m) {
if (
yesPrice === null ||
yesPrice === undefined ||
(yesPrice >= 0.25 && yesPrice <= 0.75)
) {
return { score: 0, label: ‘Crowd: balanced market — not applicable’ };
}

const crowdIsUp     = yesPrice > 0.75;
const crowdStrength = crowdIsUp ? yesPrice : (1 - yesPrice); // 0.75 → 1.00

const closes1m  = candles1m.map(c => c.close);
const closes15m = candles15m.map(c => c.close);

// RSI from 15m candles — primary exhaustion indicator
const rsiVal = _rsi(closes15m, 14);

// Recent 1m momentum — is price still moving in the crowd’s direction?
const n          = closes1m.length;
const rocRecent  = n >= 4 && closes1m[n - 4] > 0
? (closes1m[n - 1] - closes1m[n - 4]) / closes1m[n - 4]
: 0;
const momentumMatchesCrowd = crowdIsUp ? rocRecent > 0 : rocRecent < 0;

// Volume conviction — is the crowd backed by real participation?
const recent   = candles1m.slice(-(VOLUME_SPIKE_LOOKBACK + 1));
const avgVol   = recent.slice(0, -1).reduce((s, c) => s + c.volume, 0) / Math.max(recent.length - 1, 1);
const lastVol  = recent.at(-1)?.volume ?? 0;
const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
const hasVolumeConviction = volRatio >= 2.0;

let score = 0;
let label = ‘’;

if (crowdIsUp) {
// ── UP crowd scenarios ───────────────────────────────────────────────────
if (rsiVal !== null) {
if (rsiVal > 70 && !momentumMatchesCrowd) {
// Classic overbought exhaustion: crowd all-in UP but price already turning
score = -2;
label = `Crowd: UP over-extended (rsi=${rsiVal.toFixed(1)}, mom reversing) → reversal DOWN next window`;
} else if (rsiVal > 70 && momentumMatchesCrowd && hasVolumeConviction) {
// Genuinely strong: RSI high, price still climbing, volume backing it
score = 1;
label = `Crowd: UP crowd genuine (rsi=${rsiVal.toFixed(1)}, vol=${volRatio.toFixed(1)}×) → continuation UP`;
} else if (rsiVal > 70 && momentumMatchesCrowd && !hasVolumeConviction) {
// Price still up but volume fading = weak conviction
score = -1;
label = `Crowd: UP crowd thinning (rsi=${rsiVal.toFixed(1)}, vol fading) → weak continuation, reversal risk`;
} else if (rsiVal < 50) {
// RSI below 50 but crowd saying UP: disconnect = crowd likely wrong
score = -2;
label = `Crowd: UP crowd but RSI disagrees (rsi=${rsiVal.toFixed(1)}) → reversal DOWN likely next window`;
} else if (rsiVal >= 50 && rsiVal <= 70) {
// Mid-range RSI with UP crowd: lean on momentum direction
score = momentumMatchesCrowd ? 1 : -1;
label = `Crowd: UP crowd, RSI mid-range (rsi=${rsiVal.toFixed(1)}) — momentum ${momentumMatchesCrowd ? 'confirming UP' : 'diverging → lean DOWN'}`;
} else {
score = 0;
label = `Crowd: UP crowd — RSI unavailable`;
}
}
} else {
// ── DOWN crowd scenarios ─────────────────────────────────────────────────
if (rsiVal !== null) {
if (rsiVal < 30 && !momentumMatchesCrowd) {
// Classic oversold exhaustion: crowd all-in DOWN but price recovering
score = 2;
label = `Crowd: DOWN over-extended (rsi=${rsiVal.toFixed(1)}, mom recovering) → reversal UP next window`;
} else if (rsiVal < 30 && momentumMatchesCrowd && hasVolumeConviction) {
// Genuine sell-off: RSI crushed, price still falling, volume backing it
score = -1;
label = `Crowd: DOWN crowd genuine (rsi=${rsiVal.toFixed(1)}, vol=${volRatio.toFixed(1)}×) → continuation DOWN`;
} else if (rsiVal < 30 && momentumMatchesCrowd && !hasVolumeConviction) {
// Price still down but volume drying up = selling exhausting
score = 1;
label = `Crowd: DOWN crowd thinning (rsi=${rsiVal.toFixed(1)}, vol fading) → reversal UP setting up`;
} else if (rsiVal > 50) {
// RSI above 50 but crowd saying DOWN: disconnect = crowd likely wrong
score = 2;
label = `Crowd: DOWN crowd but RSI disagrees (rsi=${rsiVal.toFixed(1)}) → reversal UP likely next window`;
} else if (rsiVal >= 30 && rsiVal <= 50) {
score = momentumMatchesCrowd ? -1 : 1;
label = `Crowd: DOWN crowd, RSI mid-range (rsi=${rsiVal.toFixed(1)}) — momentum ${momentumMatchesCrowd ? 'confirming DOWN' : 'diverging → lean UP'}`;
} else {
score = 0;
label = `Crowd: DOWN crowd — RSI unavailable`;
}
}
}

// Amplify by 1 when crowd is extreme (>80%) — more extreme = more meaningful signal
if (score !== 0 && crowdStrength > 0.80) {
score = Math.sign(score) * Math.min(Math.abs(score) + 1, 2);
label += ` [extreme conviction ${(crowdStrength * 100).toFixed(0)}%]`;
}

return { score, label };
}

// ── Main forecast computation ─────────────────────────────────────────────────
async function computeForecast(yesPrice = null) {
let candles15m, candles1m;

try {
[candles15m, candles1m] = await Promise.all([
fetchBTCKlines15m(HTF_CANDLE_LIMIT),
fetchBTCKlines(REGIME_CANDLE_LIMIT),
]);
} catch (err) {
console.error(`[forecaster] Candle fetch failed: ${err.message}`);
return;
}

if (!candles15m?.length || !candles1m?.length) {
console.warn(’[forecaster] Empty candle response — skipping this cycle’);
return;
}

const macdResult  = scoreMACDCrossover(candles15m);
const rsiResult   = scoreRSIDivergence(candles15m);
const volResult   = scoreVolumeVelocity(candles1m);
const rocResult   = scoreROCAcceleration(candles1m);
const emaResult   = scoreEMATrend(candles15m);
const crowdResult = scoreCrowdSignal(yesPrice, candles1m, candles15m);

const rawScore = macdResult.score + rsiResult.score + volResult.score
+ rocResult.score  + emaResult.score + crowdResult.score;
const absScore = Math.abs(rawScore);

// ── Coherence check ────────────────────────────────────────────────────────
// Among factors that actually have an opinion (score ≠ 0), count how many
// agree with the tentative direction vs how many push against it.
// A forecast is only valid if agreeing factors outnumber disagreeing ones.
const tentativeUp       = rawScore > 0;
const allFactors        = [macdResult, rsiResult, volResult, rocResult, emaResult, crowdResult];
const nonZeroFactors    = allFactors.filter(f => f.score !== 0);
const agreeingFactors   = nonZeroFactors.filter(f => tentativeUp ? f.score > 0 : f.score < 0);
const disagreeingFactors = nonZeroFactors.filter(f => tentativeUp ? f.score < 0 : f.score > 0);

const isCoherent = agreeingFactors.length > disagreeingFactors.length;

// ── MACD / EMA structural veto ─────────────────────────────────────────────
// MACD (momentum shift) and EMA (trend direction) are the two structural
// backbone indicators. If both have meaningful scores that point in OPPOSITE
// directions the market is structurally ambiguous — not tradeable.
const macdMeaningful       = Math.abs(macdResult.score) >= 1;
const emaMeaningful        = Math.abs(emaResult.score)  >= 1;
const macdEmaContradiction = macdMeaningful && emaMeaningful
&& (macdResult.score > 0) !== (emaResult.score > 0);

// ── Volume spike contra-veto ───────────────────────────────────────────────
// A volume spike in the OPPOSITE direction of the forecast is the market
// telling us real money is flowing the other way. Veto the forecast.
const spikeContradicts = volResult.spike !== null
&& ((tentativeUp && volResult.spike.direction === ‘DOWN’)
||  (!tentativeUp && volResult.spike.direction === ‘UP’));

// ── Direction decision ────────────────────────────────────────────────────
let direction;
let neutralReason = null;

if (absScore < SCORE_THRESHOLD) {
direction   = ‘NEUTRAL’;
neutralReason = `score ${rawScore} below threshold ±${SCORE_THRESHOLD}`;
} else if (!isCoherent) {
direction   = ‘NEUTRAL’;
neutralReason = `incoherent — ${agreeingFactors.length} agree, ${disagreeingFactors.length} disagree`;
} else if (macdEmaContradiction) {
direction   = ‘NEUTRAL’;
neutralReason = `MACD/EMA contradiction (macd=${macdResult.score > 0 ? 'UP' : 'DOWN'}, ema=${emaResult.score > 0 ? 'UP' : 'DOWN'})`;
} else if (spikeContradicts) {
direction   = ‘NEUTRAL’;
neutralReason = `volume spike contradicts direction (spike=${volResult.spike?.direction})`;
} else {
direction = rawScore > 0 ? ‘UP’ : ‘DOWN’;
}

if (neutralReason) {
console.log(`[forecaster] NEUTRAL override — ${neutralReason}`);
}

// ── Confidence ─────────────────────────────────────────────────────────────
// Base: raw score magnitude relative to MAX_SCORE.
// Penalty: multiply by coherence ratio (agreeing / non-zero) so contradicted
// signals stay below agent.js’s 0.55 gate even if the net score looks strong.
const coherenceRatio = nonZeroFactors.length > 0
? agreeingFactors.length / nonZeroFactors.length
: 0;

const confidence = direction === ‘NEUTRAL’
? 0
: Math.min((absScore / MAX_SCORE) * coherenceRatio, 1);

// ── Volume spike lifecycle management ────────────────────────────────────────
if (volResult.spike) {
forecastState.volumeSpike    = volResult.spike;
forecastState.spikeDetectedAt = volResult.spike.detectedAt;
console.log(
`[forecaster] 🚨 SPIKE ${volResult.spike.direction} — ` +
`${volResult.spike.magnitude.toFixed(2)}× volume | price ${volResult.spike.pricePct}%`,
);
} else if (
forecastState.spikeDetectedAt &&
Date.now() - new Date(forecastState.spikeDetectedAt).getTime() > SPIKE_TTL_MS
) {
forecastState.volumeSpike    = null;
forecastState.spikeDetectedAt = null;
}

// ── Write state ───────────────────────────────────────────────────────────────
forecastState.direction  = direction;
forecastState.confidence = confidence;
forecastState.score      = rawScore;
forecastState.basis      = [
macdResult.label,
rsiResult.label,
volResult.label,
rocResult.label,
emaResult.label,
crowdResult.label,
];
forecastState.updatedAt   = new Date().toISOString();
forecastState.triggeredBy = yesPrice !== null
? `one-sided-market (yesPrice=${yesPrice.toFixed(2)})`
: ‘scheduled’;

console.log(
`[forecaster] direction=${direction} confidence=${confidence.toFixed(3)} ` +
`score=${rawScore}/${MAX_SCORE} coherence=${agreeingFactors.length}/${nonZeroFactors.length} ` +
`trigger=${forecastState.triggeredBy}\n` +
forecastState.basis.map(b => `  • ${b}`).join(’\n’),
);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**

- Returns a shallow copy of the current forecast state.
- Call this anywhere — it never triggers a network request.
  */
  export function getLatestForecast() {
  return { …forecastState };
  }

/**

- Returns true if a forecast has been computed within the last maxAgeMs.
- @param {number} maxAgeMs — default 5 minutes
  */
  export function isForecastFresh(maxAgeMs = 5 * 60_000) {
  if (!forecastState.updatedAt) return false;
  return Date.now() - new Date(forecastState.updatedAt).getTime() < maxAgeMs;
  }

/**

- Triggers an immediate forecast computation using the current one-sided market
- yesPrice as an additional analytical input (Factor 6: Crowd Signal).
- 
- Call this fire-and-forget from agent.js when a one-sided market is detected.
- By the time the next window opens, the forecast is ready with crowd context baked in.
- 
- @param {number} yesPrice — current market yesPrice (e.g. 0.81)
  */
  export async function triggerImmediateForecast(yesPrice) {
  console.log(
  `[forecaster] ⚡ Immediate trigger — yesPrice=${yesPrice.toFixed(2)} ` +
  `— pre-computing next window direction`,
  );
  try {
  await computeForecast(yesPrice);
  } catch (err) {
  console.error(`[forecaster] Immediate forecast failed: ${err.message}`);
  }
  }

/**

- Starts the background forecast loop.
- Runs one computation immediately (awaited), then schedules on interval.
- Call once from startAgent() before entering the main loop.
  */
  export async function startForecaster() {
  console.log(’[forecaster] Starting background forecast engine — 3-minute cycle’);
  try {
  await computeForecast();
  } catch (err) {
  // Non-fatal: engine proceeds without an initial forecast
  console.error(`[forecaster] Initial computation failed: ${err.message}`);
  }
  setInterval(async () => {
  try {
  await computeForecast();
  } catch (err) {
  console.error(`[forecaster] Cycle error: ${err.message}`);
  }
  }, FORECAST_INTERVAL_MS);
  }
