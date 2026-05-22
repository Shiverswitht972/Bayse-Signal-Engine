/**
 * Regime Classifier — Determines whether the current BTC market is
 * TRENDING, CHOPPY, or FLAT before any signal logic runs.
 *
 * Upgrades in this version:
 *   - ADX (Average Directional Index) added for objective trend strength.
 *     ADX > 25 = confirmed trend. ADX < 20 = weak or no trend.
 *   - ADX factored into the choppiness score: low ADX counts as a choppy signal.
 *   - ADX value returned in the result object for logging and notify.js.
 *
 * Read-only: takes candles as input, returns a regime object.
 * Always fail-safe: errors must be caught by the caller.
 *
 * Requires Binance candles (from fetchBTCKlines), NOT internal priceHistory ticks.
 * Minimum 30 candles recommended, 50+ for reliable classification.
 */

// ── ATR ───────────────────────────────────────────────────────────────────────
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    ));
  }

  let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  }

  return atrVal;
}

// ── ADX ───────────────────────────────────────────────────────────────────────
/**
 * Compute ADX (Average Directional Index) using Wilder smoothing.
 *
 * ADX measures trend STRENGTH, not direction.
 *   ADX >= 25 → confirmed, tradeable trend
 *   ADX 20–25 → weakening or forming trend
 *   ADX <  20 → no meaningful trend, ranging market
 *
 * Returns a value 0–100, or null if insufficient data.
 */
function computeADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const plusDM  = [];
  const minusDM = [];
  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove   = curr.high - prev.high;
    const downMove = prev.low  - curr.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    trueRanges.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close),
    ));
  }

  // Initial Wilder smoothed values (simple average of first `period`)
  let smoothedTR    = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM  = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues = [];

  // First DX from the initial smoothed window
  if (smoothedTR > 0) {
    const plusDI  = (smoothedPlusDM  / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;
    const diSum   = plusDI + minusDI;
    if (diSum > 0) {
      dxValues.push(Math.abs(plusDI - minusDI) / diSum * 100);
    }
  }

  // Wilder smooth the remaining bars
  for (let i = period; i < trueRanges.length; i++) {
    smoothedTR      = smoothedTR    - smoothedTR    / period + trueRanges[i];
    smoothedPlusDM  = smoothedPlusDM  - smoothedPlusDM  / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];

    if (smoothedTR > 0) {
      const plusDI  = (smoothedPlusDM  / smoothedTR) * 100;
      const minusDI = (smoothedMinusDM / smoothedTR) * 100;
      const diSum   = plusDI + minusDI;
      if (diSum > 0) {
        dxValues.push(Math.abs(plusDI - minusDI) / diSum * 100);
      }
    }
  }

  if (dxValues.length < period) return null;

  // ADX = simple average of the last `period` DX values
  // (Wilder uses his smoothing here too, but simple avg is accurate enough)
  const lastDX = dxValues.slice(-period);
  return lastDX.reduce((a, b) => a + b, 0) / lastDX.length;
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function computeEMA(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [prev];
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── EMA crossover count ───────────────────────────────────────────────────────
function countEMACrossovers(ema9, ema21, lookback = 10) {
  const offset = ema9.length - ema21.length;
  const aligned9 = ema9.slice(offset);
  const start = Math.max(0, aligned9.length - lookback);
  let crossovers = 0;

  for (let i = start + 1; i < aligned9.length; i++) {
    const prevAbove = aligned9[i - 1] > ema21[i - 1 - (aligned9.length - ema21.length)];
    const currAbove = aligned9[i]     > ema21[i     - (aligned9.length - ema21.length)];
    if (prevAbove !== currAbove) crossovers++;
  }

  return crossovers;
}

// ── MACD direction ────────────────────────────────────────────────────────────
/**
 * Returns 'UP' if MACD line > signal line, 'DOWN' if below, null if insufficient data.
 */
function computeMACDDirection(closes) {
  const emaFn = (values, period) => {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result = [prev];
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      result.push(prev);
    }
    return result;
  };

  const ema12 = emaFn(closes, 12);
  const ema26 = emaFn(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return null;

  const offset   = 26 - 12;
  const macdLine = ema26.map((val, i) => ema12[i + offset] - val);
  const signalLine = emaFn(macdLine, 9);
  if (signalLine.length === 0) return null;

  return macdLine.at(-1) > signalLine.at(-1) ? 'UP' : 'DOWN';
}

// ── Main classifier ───────────────────────────────────────────────────────────
/**
 * Classify the current market regime.
 *
 * Returns one of:
 *   { regime: 'TRENDING', direction: 'UP'|'DOWN', macdDirection, contradicted, adx, reason, atrPct, emaSeparation }
 *   { regime: 'CHOPPY',   adx, reason, atrPct, emaSeparation, crossovers }
 *   { regime: 'FLAT',     adx, reason, atrPct }
 *   { regime: 'UNKNOWN',  reason }
 *
 * @param {Array}  candles    — Binance OHLCV candles, newest last
 * @param {Object} thresholds — Optional overrides for classification thresholds
 */
export function classifyRegime(candles, thresholds = {}) {
  const {
    minCandles     = 30,
    flatAtrPct     = 0.0003,   // ATR < 0.03% = flat, no edge
    choppyAtrPct   = 0.0008,   // ATR < 0.08% = low conviction
    choppySepPct   = 0.0005,   // EMA separation < 0.05% = tangled
    choppySlopePct = 0.0003,   // EMA-9 slope < 0.03% = flat
    maxCrossovers  = 3,
    adxTrending    = 25,       // ADX >= 25 → confirmed trend
    adxWeak        = 20,       // ADX < 20  → counts as choppy signal
  } = thresholds;

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(candles) || candles.length < minCandles) {
    return {
      regime: 'UNKNOWN',
      reason: `Need at least ${minCandles} candles, got ${candles?.length ?? 0}`,
    };
  }

  const closes = candles.map(c => c.close);
  const currentPrice = closes.at(-1);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { regime: 'UNKNOWN', reason: 'Invalid close price in candles' };
  }

  // ── Step 1: ATR Volatility Check ───────────────────────────────────────────
  const atrVal = computeATR(candles, 14);
  if (atrVal === null) {
    return { regime: 'UNKNOWN', reason: 'ATR calculation failed — not enough candles' };
  }

  const atrPct = atrVal / currentPrice;

  if (atrPct < flatAtrPct) {
    return {
      regime: 'FLAT',
      reason: `ATR too low (${(atrPct * 100).toFixed(4)}% < ${(flatAtrPct * 100).toFixed(4)}%)`,
      atrPct,
      adx: null,
    };
  }

  // ── Step 2: ADX Trend Strength ─────────────────────────────────────────────
  const adx = computeADX(candles, 14);
  const adxLabel = adx !== null ? adx.toFixed(1) : 'n/a';

  // Very weak ADX immediately flags as choppy — no point checking EMAs
  if (adx !== null && adx < adxWeak) {
    return {
      regime: 'CHOPPY',
      reason: `ADX too weak for directional trading (${adxLabel} < ${adxWeak})`,
      atrPct,
      adx,
      crossovers: null,
    };
  }

  // ── Step 3: EMA Separation + Slope ────────────────────────────────────────
  const ema9  = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);

  if (ema9.length < 5 || ema21.length < 5) {
    return { regime: 'UNKNOWN', reason: 'EMA calculation failed', atrPct, adx };
  }

  const lastEma9  = ema9.at(-1);
  const lastEma21 = ema21.at(-1);

  const emaSeparation    = (lastEma9 - lastEma21) / currentPrice;
  const absEmaSeparation = Math.abs(emaSeparation);

  const ema9Slope    = (ema9.at(-1) - ema9.at(-5)) / currentPrice;
  const absEma9Slope = Math.abs(ema9Slope);

  const crossovers = countEMACrossovers(ema9, ema21, 10);

  const isEMATangled  = absEmaSeparation < choppySepPct;
  const isSlopeFlat   = absEma9Slope < choppySlopePct;
  const isTooChoppy   = crossovers > maxCrossovers;
  const isLowVol      = atrPct < choppyAtrPct;
  const isWeakADX     = adx !== null && adx < adxTrending; // 20–25 zone

  // Choppiness score: 2+ out of 5 signals = CHOPPY
  const choppinessScore = [isEMATangled, isSlopeFlat, isTooChoppy, isLowVol, isWeakADX]
    .filter(Boolean).length;

  if (choppinessScore >= 2) {
    return {
      regime: 'CHOPPY',
      reason: [
        isEMATangled && `EMAs tangled (sep=${(absEmaSeparation * 100).toFixed(4)}%)`,
        isSlopeFlat  && `EMA-9 slope flat (${(ema9Slope * 100).toFixed(4)}%)`,
        isTooChoppy  && `${crossovers} EMA crossovers in last 10 candles`,
        isLowVol     && `Low ATR (${(atrPct * 100).toFixed(4)}%)`,
        isWeakADX    && `Weak ADX (${adxLabel})`,
      ].filter(Boolean).join(' | '),
      atrPct,
      adx,
      emaSeparation,
      crossovers,
    };
  }

  // ── Step 4: Confirmed Trend ────────────────────────────────────────────────
  const emaDirection  = emaSeparation > 0 ? 'UP' : 'DOWN';
  const macdDirection = computeMACDDirection(closes);
  const contradicted  = macdDirection !== null && macdDirection !== emaDirection;

  if (contradicted) {
    console.log(`[regime] TRENDING ${emaDirection} but MACD says ${macdDirection} — flagging contradiction`);
  }

  const trendStrength = adx !== null && adx >= adxTrending ? 'strong' : 'moderate';

  return {
    regime: 'TRENDING',
    direction: emaDirection,
    macdDirection,
    contradicted,
    adx,
    trendStrength,
    reason: (
      `Clean ${emaDirection} trend (${trendStrength}) — ` +
      `sep=${(absEmaSeparation * 100).toFixed(4)}% ` +
      `slope=${(ema9Slope * 100).toFixed(4)}% ` +
      `ATR=${(atrPct * 100).toFixed(4)}% ` +
      `ADX=${adxLabel}` +
      (contradicted ? ` ⚠️ MACD contradiction (${macdDirection})` : '')
    ),
    atrPct,
    emaSeparation,
    crossovers,
  };
}
