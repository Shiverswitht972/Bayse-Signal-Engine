/**
 * Regime Classifier — Determines whether the current BTC market is
 * TRENDING, CHOPPY, or FLAT before any signal logic runs.
 *
 * Read-only: takes candles as input, returns a regime object.
 * Always fail-safe: errors must be caught by the caller.
 *
 * Requires Binance candles (from fetchBTCKlines), NOT internal priceHistory ticks.
 * Minimum 30 candles recommended, 50+ for reliable classification.
 */

/**
 * Wilder-smoothed ATR over a given period.
 * Returns null if there aren't enough candles.
 */
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

  // Seed with simple average over first `period` TRs
  let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder smoothing for the rest
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  }

  return atrVal;
}

/**
 * Standard EMA over an array of close prices.
 * Returns [] if there aren't enough values.
 */
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

/**
 * Measures how much EMA-9 and EMA-21 have crossed/tangled
 * over the last `lookback` candles.
 * Returns the number of crossovers — high count = choppy.
 */
function countEMACrossovers(ema9, ema21, lookback = 10) {
  // Align: ema9 always has more values since it uses a shorter period
  const offset = ema9.length - ema21.length;
  const aligned9 = ema9.slice(offset);

  const start = Math.max(0, aligned9.length - lookback);
  let crossovers = 0;

  for (let i = start + 1; i < aligned9.length; i++) {
    const prevAbove = aligned9[i - 1] > ema21[i - 1 - (aligned9.length - ema21.length)];
    const currAbove = aligned9[i] > ema21[i - (aligned9.length - ema21.length)];
    if (prevAbove !== currAbove) crossovers++;
  }

  return crossovers;
}

/**
 * Main regime classifier.
 *
 * Returns one of:
 *   { regime: 'TRENDING', direction: 'UP'|'DOWN', reason, atrPct, emaSeparation }
 *   { regime: 'CHOPPY',   reason, atrPct, emaSeparation }
 *   { regime: 'FLAT',     reason, atrPct }
 *   { regime: 'UNKNOWN',  reason }
 *
 * @param {Array} candles - Binance OHLCV candles, newest last
 * @param {Object} thresholds - Optional overrides for classification thresholds
 */
export function classifyRegime(candles, thresholds = {}) {
  const {
    minCandles        = 30,    // Minimum candles needed
    flatAtrPct        = 0.0003, // ATR < 0.03% of price = flat market, no edge
    choppyAtrPct      = 0.0008, // ATR < 0.08% = low conviction, treat as choppy
    choppySepPct      = 0.0002, // EMA separation < 0.02% = tangled
    choppySlopePct    = 0.0002, // EMA-9 slope < 0.02% = no directional momentum
    maxCrossovers     = 3,     // Too many EMA crosses in last 10 candles = choppy
  } = thresholds;

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(candles) || candles.length < minCandles) {
    return {
      regime: 'UNKNOWN',
      reason: `Need at least ${minCandles} candles, got ${candles?.length ?? 0}`,
    };
  }

  const closes      = candles.map(c => c.close);
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
      reason: `ATR too low to call direction (${(atrPct * 100).toFixed(4)}% < ${(flatAtrPct * 100).toFixed(4)}%)`,
      atrPct,
    };
  }

  // ── Step 2: EMA Separation + Slope ────────────────────────────────────────
  const ema9  = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);

  if (ema9.length < 5 || ema21.length < 5) {
    return { regime: 'UNKNOWN', reason: 'EMA calculation failed', atrPct };
  }

  const lastEma9  = ema9.at(-1);
  const lastEma21 = ema21.at(-1);

  // Separation between EMAs as a fraction of price — the "spread"
  const emaSeparation    = (lastEma9 - lastEma21) / currentPrice;
  const absEmaSeparation = Math.abs(emaSeparation);

  // Slope of EMA-9 over last 4 candles as a fraction of price
  const ema9Slope    = (ema9.at(-1) - ema9.at(-5)) / currentPrice;
  const absEma9Slope = Math.abs(ema9Slope);

  // Crossover choppiness check
  const crossovers = countEMACrossovers(ema9, ema21, 10);

  const isEMATangled  = absEmaSeparation < choppySepPct;
  const isSlopeFlat   = absEma9Slope < choppySlopePct;
  const isTooChoppy   = crossovers > maxCrossovers;
  const isLowVol      = atrPct < choppyAtrPct;

  // Call it choppy if two or more choppiness signals fire
  const choppinessScore = [isEMATangled, isSlopeFlat, isTooChoppy, isLowVol]
    .filter(Boolean).length;

  if (choppinessScore >= 2) {
    return {
      regime: 'CHOPPY',
      reason: [
        isEMATangled  && `EMAs tangled (sep=${(absEmaSeparation * 100).toFixed(4)}%)`,
        isSlopeFlat   && `EMA-9 slope flat (${(ema9Slope * 100).toFixed(4)}%)`,
        isTooChoppy   && `${crossovers} EMA crossovers in last 10 candles`,
        isLowVol      && `Low ATR (${(atrPct * 100).toFixed(4)}%)`,
      ].filter(Boolean).join(' | '),
      atrPct,
      emaSeparation,
      crossovers,
    };
  }

  // ── Step 3: Confirmed Trend ────────────────────────────────────────────────
  const direction = emaSeparation > 0 ? 'UP' : 'DOWN';

  return {
    regime: 'TRENDING',
    direction,
    reason: `Clean ${direction} trend — sep=${(absEmaSeparation * 100).toFixed(4)}% slope=${(ema9Slope * 100).toFixed(4)}% ATR=${(atrPct * 100).toFixed(4)}%`,
    atrPct,
    emaSeparation,
    crossovers,
  };
}
