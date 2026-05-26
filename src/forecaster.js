/**
 * Forecaster — Continuous Background Forecast Engine
 *
 * Runs every 3 minutes independently of the market window loop.
 * Maintains a forecast state that agent.js reads before each signal evaluation.
 *
 * Two purposes:
 *   1. Pre-compute directional bias BEFORE a new window opens so the engine
 *      can fire in the first 90 seconds rather than waiting for data to accumulate.
 *
 *   2. Allow evaluation of one-sided markets when the forecast DISAGREES with
 *      the crowd pricing — that disagreement is where contrarian edge lives.
 *
 * Factors computed (each contributes −2 to +2):
 *   1. 15m MACD crossover      — freshness of momentum shift
 *   2. RSI divergence/exhaustion — continuation vs reversal signal
 *   3. Volume velocity spike    — pump and dump detection
 *   4. Price ROC acceleration   — is momentum building or dying
 *   5. 15m EMA trend            — macro directional bias
 *
 * Score range: −10 to +10
 *   >  3 → forecast UP   (confidence = score / 10)
 *   < −3 → forecast DOWN (confidence = abs(score) / 10)
 *   −3 to 3 → NEUTRAL
 *
 * No circular imports. Only depends on perception.js and config.js.
 */

import { fetchBTCKlines, fetchBTCKlines15m } from './perception.js';
import { HTF_CANDLE_LIMIT, REGIME_CANDLE_LIMIT } from './config.js';

const FORECAST_INTERVAL_MS   = 3 * 60_000;  // re-compute every 3 minutes
const VOLUME_SPIKE_THRESHOLD  = 3.0;         // 3× rolling average = spike
const VOLUME_SPIKE_LOOKBACK   = 20;          // candles for rolling average
const SCORE_THRESHOLD         = 3;           // |score| must exceed this for directional call
const MAX_SCORE               = 10;          // denominator for confidence normalisation
const SPIKE_TTL_MS            = 10 * 60_000; // clear spike record after 10 minutes

// ── Shared forecast state ─────────────────────────────────────────────────────
const forecastState = {
  direction:        null,   // 'UP' | 'DOWN' | 'NEUTRAL' | null (null = never computed)
  confidence:       0,      // 0–1
  score:            0,      // raw aggregate score
  basis:            [],     // human-readable factor labels
  updatedAt:        null,   // ISO string of last successful computation
  volumeSpike:      null,   // { direction, magnitude, pricePct, detectedAt } | null
  spikeDetectedAt:  null,   // ISO string, used for TTL
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
  if (!m) return { score: 0, label: 'MACD(15m): insufficient data' };

  const crossedUp   = m.prevMacd <= m.prevSig && m.macd > m.signal;
  const crossedDown = m.prevMacd >= m.prevSig && m.macd < m.signal;
  const h           = m.histogram.toFixed(2);

  if (crossedUp)         return { score:  2, label: `MACD(15m): fresh bullish cross (hist=${h})` };
  if (crossedDown)       return { score: -2, label: `MACD(15m): fresh bearish cross (hist=${h})` };
  if (m.macd > m.signal) return { score:  1, label: `MACD(15m): above signal (hist=${h})` };
  if (m.macd < m.signal) return { score: -1, label: `MACD(15m): below signal (hist=${h})` };
  return { score: 0, label: 'MACD(15m): at signal line' };
}

// ── Factor 2: RSI divergence / exhaustion (−2 to +2) ─────────────────────────
// Overbought + decelerating RSI = likely reversal DOWN next window.
// Oversold  + recovering  RSI = likely reversal UP next window.
// Mid-range trending RSI = continuation.
function scoreRSIDivergence(candles15m) {
  const closes = candles15m.map(c => c.close);
  if (closes.length < 20) return { score: 0, label: 'RSI(15m): insufficient data' };

  const rsiNow  = _rsi(closes, 14);
  const rsiPrev = _rsi(closes.slice(0, -2), 14);
  if (rsiNow === null) return { score: 0, label: 'RSI(15m): calculation failed' };

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
    return { score: 0, label: 'Volume(1m): insufficient data', spike: null };
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
      direction:  priceMove >= 0 ? 'UP' : 'DOWN',
      magnitude:  ratio,
      pricePct:   (priceMove * 100).toFixed(3),
      detectedAt: new Date().toISOString(),
    };

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
  if (candles1m.length < 9) return { score: 0, label: 'ROC(1m): insufficient data' };

  const closes = candles1m.map(c => c.close);
  const n      = closes.length;

  if (closes[n - 4] <= 0 || closes[n - 7] <= 0) return { score: 0, label: 'ROC(1m): invalid prices' };

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
  if (candles15m.length < 21) return { score: 0, label: 'EMA(15m): insufficient data' };

  const closes  = candles15m.map(c => c.close);
  const ema9    = _ema(closes, 9);
  const ema21   = _ema(closes, 21);
  const price   = closes.at(-1);

  if (!ema9.length || !ema21.length || price <= 0) return { score: 0, label: 'EMA(15m): calculation failed' };

  const sep    = (ema9.at(-1) - ema21.at(-1)) / price;
  const sepPct = (sep * 100).toFixed(3);

  if (sep >  0.001) return { score:  2, label: `EMA(15m): strong bull (sep=+${sepPct}%)` };
  if (sep >  0)     return { score:  1, label: `EMA(15m): mild bull (sep=+${sepPct}%)` };
  if (sep < -0.001) return { score: -2, label: `EMA(15m): strong bear (sep=${sepPct}%)` };
  if (sep <  0)     return { score: -1, label: `EMA(15m): mild bear (sep=${sepPct}%)` };

  return { score: 0, label: 'EMA(15m): aligned (no separation)' };
}

// ── Main forecast computation ─────────────────────────────────────────────────
async function computeForecast() {
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
    console.warn('[forecaster] Empty candle response — skipping this cycle');
    return;
  }

  const macdResult = scoreMACDCrossover(candles15m);
  const rsiResult  = scoreRSIDivergence(candles15m);
  const volResult  = scoreVolumeVelocity(candles1m);
  const rocResult  = scoreROCAcceleration(candles1m);
  const emaResult  = scoreEMATrend(candles15m);

  const rawScore = macdResult.score + rsiResult.score + volResult.score
                 + rocResult.score  + emaResult.score;
  const absScore = Math.abs(rawScore);

  const direction = rawScore >  SCORE_THRESHOLD ? 'UP'
                  : rawScore < -SCORE_THRESHOLD ? 'DOWN'
                  : 'NEUTRAL';

  const confidence = Math.min(absScore / MAX_SCORE, 1);

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
  ];
  forecastState.updatedAt = new Date().toISOString();

  console.log(
    `[forecaster] direction=${direction} confidence=${confidence.toFixed(3)} ` +
    `score=${rawScore}/${MAX_SCORE}\n` +
    forecastState.basis.map(b => `  • ${b}`).join('\n'),
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a shallow copy of the current forecast state.
 * Call this anywhere — it never triggers a network request.
 */
export function getLatestForecast() {
  return { ...forecastState };
}

/**
 * Returns true if a forecast has been computed within the last maxAgeMs.
 * @param {number} maxAgeMs — default 5 minutes
 */
export function isForecastFresh(maxAgeMs = 5 * 60_000) {
  if (!forecastState.updatedAt) return false;
  return Date.now() - new Date(forecastState.updatedAt).getTime() < maxAgeMs;
}

/**
 * Starts the background forecast loop.
 * Runs one computation immediately (awaited), then schedules on interval.
 * Call once from startAgent() before entering the main loop.
 */
export async function startForecaster() {
  console.log('[forecaster] Starting background forecast engine — 3-minute cycle');
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
