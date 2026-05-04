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

function countEMACrossovers(ema9, ema21, lookback = 10) {
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
 * Computes MACD direction from closes.
 * Returns 'UP' if macd line > signal line, 'DOWN' if below, null if insufficient data.
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

  const offset = 26 - 12;
  const macdLine = ema26.map((val, i) => ema12[i + offset] - val);
  const signalLine = emaFn(macdLine, 9);
  if (signalLine.length === 0) return null;

  return macdLine.at(-1) > signalLine.at(-1) ? 'UP' : 'DOWN';
}

/**
 * Main regime classifier.
 *
 * Returns one of:
 *   { regime: 'TRENDING', direction: 'UP'|'DOWN', macdDirection: 'UP'|'DOWN'|null, contradicted: bool, reason, atrPct, emaSeparation }
 *   { regime: 'CHOPPY',   reason, atrPct, emaSeparation }
 *   { regime: 'FLAT',     reason, atrPct }
 *   { regime: 'UNKNOWN',  reason }
 *
 * @param {Array} candles - Binance OHLCV candles, newest last
 * @param {Object} thresholds - Optional overrides for classification thresholds
 */
export function classifyRegime(candles, thresholds = {}) {
  const {
    minCandles     = 30,
    flatAtrPct     = 0.0003,  // ATR < 0.03% = flat, no edge
    choppyAtrPct   = 0.0008,  // ATR < 0.08% = low conviction
    // ✅ FIX: Raised from 0.0002 to 0.0005 — 0.02% separation was too thin
    // to call a real trend. At sep=0.021% the old code called TRENDING DOWN
    // and the engine fired into an 85% YES market and lost. Now requires
    // 0.05% minimum separation before calling TRENDING.
    choppySepPct   = 0.0005,
    // ✅ FIX: Raised slope threshold too for the same reason
    choppySlopePct = 0.0003,
    maxCrossovers  = 3,
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

  const emaSeparation    = (lastEma9 - lastEma21) / currentPrice;
  const absEmaSeparation = Math.abs(emaSeparation);

  const ema9Slope    = (ema9.at(-1) - ema9.at(-5)) / currentPrice;
  const absEma9Slope = Math.abs(ema9Slope);

  const crossovers = countEMACrossovers(ema9, ema21, 10);

  const isEMATangled  = absEmaSeparation < choppySepPct;
  const isSlopeFlat   = absEma9Slope < choppySlopePct;
  const isTooChoppy   = crossovers > maxCrossovers;
  const isLowVol      = atrPct < choppyAtrPct;

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
  const emaDirection   = emaSeparation > 0 ? 'UP' : 'DOWN';

  // ✅ FIX 2: Compute MACD direction and flag contradictions
  // If MACD disagrees with EMA trend direction, the trend is unreliable.
  // signal.js uses this to block trades where indicators conflict.
  const macdDirection  = computeMACDDirection(closes);
  const contradicted   = macdDirection !== null && macdDirection !== emaDirection;

  if (contradicted) {
    console.log(`[regime] TRENDING ${emaDirection} but MACD says ${macdDirection} — flagging contradiction`);
  }

  return {
    regime: 'TRENDING',
    direction: emaDirection,
    macdDirection,
    contradicted,  // ← signal.js checks this before firing
    reason: `Clean ${emaDirection} trend — sep=${(absEmaSeparation * 100).toFixed(4)}% slope=${(ema9Slope * 100).toFixed(4)}% ATR=${(atrPct * 100).toFixed(4)}%${contradicted ? ` ⚠️ MACD contradiction (${macdDirection})` : ''}`,
    atrPct,
    emaSeparation,
    crossovers,
  };
}
