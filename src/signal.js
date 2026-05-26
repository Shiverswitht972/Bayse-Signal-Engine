import { BASE_URL, buildWriteHeaders } from './auth.js';
import { getCandles } from './candles.js';
import { generateAlphaSignal, combineSignals } from './alpha.js';
import { fetchBTCKlines, fetchBTCKlines15m } from './perception.js';
import { classifyRegime } from './regime.js';
import { getCurrentSession } from './sessions.js';
import { getWinRates } from './journal.js';
import {
  BOLLINGER_PERIOD,
  BOLLINGER_STD_DEVS,
  CURRENCY,
  HTF_CANDLE_LIMIT,
  KELLY_FRACTION,
  MAX_STAKE_NGN,
  MIN_STAKE_NGN,
  MIN_VOL_THRESHOLD,
  REGIME_CANDLE_LIMIT,
  SESSION_AWARENESS_ENABLED,
  SIGNAL_SCORE_MIN,
  TRADE_JOURNAL_ENABLED,
} from './config.js';

const QUOTE_FEE_PROBE_AMOUNT = 100;

// ── Math helpers ──────────────────────────────────────────────────────────────
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── Indicators ────────────────────────────────────────────────────────────────

/**
 * Wilder RSI.
 * Returns a value 0–100, or null if insufficient data.
 */
function rsiWilder(closes, period = 14) {
  if (closes.length <= period) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const currentGain = delta > 0 ? delta : 0;
    const currentLoss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (12/26/9).
 * Returns { macd, signal, histogram } or null.
 */
function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return null;

  const offset   = 26 - 12;
  const macdLine = ema26.map((value, index) => ema12[index + offset] - value);
  const signalLine = ema(macdLine, 9);
  if (signalLine.length === 0) return null;

  const macdVal   = macdLine.at(-1);
  const signalVal = signalLine.at(-1);

  return {
    macd:      macdVal,
    signal:    signalVal,
    histogram: macdVal - signalVal,
  };
}

/**
 * Bollinger Bands (SMA ± N standard deviations).
 * Returns { upper, lower, sma, pctB, width } or null.
 *
 * pctB: where current price sits within the bands (0 = lower, 1 = upper).
 *   pctB > 0.80 → price pressing upper band → bullish momentum
 *   pctB < 0.20 → price pressing lower band → bearish momentum
 *
 * width: (upper - lower) / sma — band squeeze indicator.
 *   width < 0.003 → bands too tight, low-volatility, avoid trading.
 */
function bollingerBands(closes, period = BOLLINGER_PERIOD, stdDevs = BOLLINGER_STD_DEVS) {
  if (closes.length < period) return null;

  const slice  = closes.slice(-period);
  const sma    = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, c) => s + (c - sma) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);

  const upper   = sma + stdDevs * stddev;
  const lower   = sma - stdDevs * stddev;
  const current = closes.at(-1);
  const width   = sma > 0 ? (upper - lower) / sma : 0;
  const pctB    = stddev > 0 ? clamp((current - lower) / (upper - lower), 0, 1) : 0.5;

  return { upper, lower, sma, pctB, width };
}

/**
 * 5-minute price delta from WebSocket tick history.
 */
function computeDelta5m(priceHistory) {
  if (priceHistory.length < 2) return 0;

  const latest   = priceHistory.at(-1);
  const latestTs = new Date(latest.timestamp).getTime();
  if (!Number.isFinite(latestTs)) return 0;

  const targetTs = latestTs - 5 * 60 * 1000;
  let baseline   = null;

  for (let i = priceHistory.length - 2; i >= 0; i -= 1) {
    const tick   = priceHistory[i];
    const tickTs = new Date(tick.timestamp).getTime();
    if (!Number.isFinite(tickTs)) continue;
    if (tickTs <= targetTs) { baseline = tick; break; }
  }

  if (!baseline || !baseline.price) return 0;
  return ((latest.price - baseline.price) / baseline.price) * 100;
}

/**
 * Higher-timeframe (15m) EMA bias.
 * Returns { direction: 'UP'|'DOWN', strength } or null.
 * Only trade in the direction of the 15m bias — prevents firing against the macro move.
 */
function computeHTFBias(htfCandles) {
  if (!htfCandles || htfCandles.length < 21) return null;

  const closes   = htfCandles.map(c => c.close);
  const ema9arr  = ema(closes, 9);
  const ema21arr = ema(closes, 21);

  if (ema9arr.length === 0 || ema21arr.length === 0) return null;

  const lastEma9  = ema9arr.at(-1);
  const lastEma21 = ema21arr.at(-1);
  const price     = closes.at(-1);
  const separation = Math.abs(lastEma9 - lastEma21) / price;

  return {
    direction: lastEma9 > lastEma21 ? 'UP' : 'DOWN',
    strength:  separation,
  };
}

/**
 * Composite momentum score using Binance candles.
 * Prefers Binance if ≥35 candles available; falls back to internal candles.
 */
function computeMomentum(priceHistory, internalCandles, binanceCandles) {
  const candles = (binanceCandles && binanceCandles.length >= 35)
    ? binanceCandles
    : internalCandles;

  const closes     = candles.map((c) => c.close);
  const rsi        = rsiWilder(closes, 14);
  const macdValues = macd(closes);
  const delta5m    = computeDelta5m(priceHistory);

  // Graduated RSI scoring (was: ternary ±1)
  let rsiScore = 0;
  if (rsi !== null) {
    if      (rsi > 65) rsiScore =  1.0;
    else if (rsi > 55) rsiScore =  0.5;
    else if (rsi < 35) rsiScore = -1.0;
    else if (rsi < 45) rsiScore = -0.5;
    // 45–55: neutral = 0
  }

  // MACD score weighted by histogram magnitude (was: strict ±1)
  let macdScore = 0;
  if (macdValues) {
    const histNorm = clamp(macdValues.histogram / 50, -1, 1); // normalise by $50 scale
    macdScore = Math.sign(macdValues.histogram) * (0.5 + 0.5 * Math.abs(histNorm));
  }

  const deltaScore    = clamp(delta5m / 1.0, -1, 1);
  const momentumScore = clamp((rsiScore + macdScore + deltaScore) / 3, -1, 1);

  console.log(
    `[signal:data] source=${candles === binanceCandles ? 'binance' : 'internal'} ` +
    `candles=${candles.length} rsi=${rsi?.toFixed(2) ?? 'null'} ` +
    `macd_hist=${macdValues?.histogram?.toFixed(4) ?? 'null'} ` +
    `rsiScore=${rsiScore.toFixed(2)} macdScore=${macdScore.toFixed(2)} ` +
    `deltaScore=${deltaScore.toFixed(2)} momentum=${momentumScore.toFixed(3)}`,
  );

  return { momentumScore, delta5m, rsi, macdValues };
}

function computeVolumeScore(candles, momentumScore) {
  if (candles.length < 6) return 0;

  const last3 = candles.slice(-3);
  const prev3 = candles.slice(-6, -3);

  const avg     = (arr) => arr.reduce((sum, c) => sum + Number(c.volume ?? 0), 0) / arr.length;
  const lastAvg = avg(last3);
  const prevAvg = avg(prev3);

  if (prevAvg <= 0) return 0;

  const trend       = (lastAvg - prevAvg) / prevAvg;
  const directional = Math.sign(momentumScore) || 1;
  return clamp(trend * directional, -1, 1);
}

// ── Signal scoring system (0–10) ──────────────────────────────────────────────
/**
 * Counts how many independent factors confirm the trade.
 * Each factor contributes 0–2 points. Score ≥ SIGNAL_SCORE_MIN required to trade.
 *
 * Factors and max contribution:
 *   Regime alignment    2 pts
 *   RSI alignment       2 pts
 *   MACD alignment      2 pts
 *   HTF (15m) bias      2 pts
 *   Bollinger Bands     2 pts
 *   Volume + delta      1 pt
 *   Active session      1 pt
 *   Total max:         12 pts → capped at 10
 */
function computeSignalScore({
  direction,
  rsi,
  macdValues,
  volumeScore,
  bollingerData,
  htfBias,
  delta5m,
  regime,
  session,
  forecastBias,
}) {
  let score  = 0;
  const isUp = direction === 'YES';

  // 1. Regime alignment (0–2 pts)
  if (regime?.regime === 'TRENDING') {
    if ((regime.direction === 'UP') === isUp) {
      // Strong ADX = full 2 pts; moderate = 1 pt
      score += regime.adx != null && regime.adx >= 25 ? 2 : 1;
    }
    // Trending against us = 0 pts (signal is already at risk of being blocked)
  } else if (regime?.regime === 'UNKNOWN') {
    score += 0.5; // partial credit when data is unavailable
  }
  // CHOPPY / FLAT = 0 pts (shouldn't reach scoring; blocked upstream)

  // 2. RSI alignment (0–2 pts)
  if (rsi !== null) {
    if (isUp) {
      if      (rsi > 65) score += 2;
      else if (rsi > 55) score += 1;
      // RSI < 45 = unfavourable for YES, no points
    } else {
      if      (rsi < 35) score += 2;
      else if (rsi < 45) score += 1;
      // RSI > 55 = unfavourable for NO, no points
    }
  }

  // 3. MACD alignment (0–2 pts)
  if (macdValues) {
    const macdIsUp = macdValues.macd > macdValues.signal;
    if (macdIsUp === isUp) {
      // Stronger histogram = more conviction
      const histAbs = Math.abs(macdValues.histogram ?? 0);
      score += histAbs > 20 ? 2 : 1;
    }
    // MACD against us = 0 pts
  }

  // 4. Higher-timeframe (15m) bias (0–2 pts)
  if (htfBias) {
    const htfIsUp = htfBias.direction === 'UP';
    if (htfIsUp === isUp) {
      // Wider EMA separation = stronger HTF conviction
      score += htfBias.strength > 0.0008 ? 2 : 1;
    }
    // HTF against us = 0 pts (this is the most important non-scorer)
  }

  // 5. Bollinger Bands (0–2 pts)
  if (bollingerData && bollingerData.width >= 0.003) {
    const { pctB } = bollingerData;
    if (isUp) {
      if      (pctB > 0.85) score += 2;
      else if (pctB > 0.65) score += 1;
    } else {
      if      (pctB < 0.15) score += 2;
      else if (pctB < 0.35) score += 1;
    }
  }

  // 6. Volume + delta alignment (0–1 pt)
  const deltaAligned  = isUp ? delta5m > 0.2  : delta5m < -0.2;
  const volumeAligned = isUp ? volumeScore > 0.1 : volumeScore < -0.1;
  if (deltaAligned && volumeAligned) score += 1;
  else if (deltaAligned || volumeAligned) score += 0.5;

  // 7. Active trading session bonus (0–1 pt)
  if (session.name === 'LONDON' || session.name === 'NEW_YORK') score += 1;

  // 8. Forecast alignment (0–2 pts)
  // Background forecast agreeing with this direction adds strong independent confirmation.
  // Disagreement adds 0 pts — the edge calc already favours the opposite side in that case.
  if (forecastBias && forecastBias.direction !== 'NEUTRAL') {
    const forecastIsUp = forecastBias.direction === 'UP';
    if (forecastIsUp === isUp && forecastBias.confidence > 0.55) {
      score += forecastBias.confidence > 0.75 ? 2 : 1;
    }
  }

  return Math.min(Math.round(score * 10) / 10, 10); // cap at 10, keep 1 decimal
}

// ── Quote fee probe ───────────────────────────────────────────────────────────
async function fetchQuoteFeeRatio(eventId, marketId, outcomeId) {
  const path    = `/v1/pm/events/${eventId}/markets/${marketId}/quote`;
  const bodyObj = {
    type: 'MARKET',
    side: 'BUY',
    outcomeId,
    amount: QUOTE_FEE_PROBE_AMOUNT,
    currency: CURRENCY,
  };
  const body = JSON.stringify(bodyObj);

  const response = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: buildWriteHeaders('POST', path, body),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Quote request failed (${response.status}): ${text}`);
  }

  const data      = await response.json();
  const feeAmount = Number(data.fee ?? data.quote?.fee ?? data.fees?.total ?? 0);
  const feeRate   = Number(data.feeRate ?? data.quote?.feeRate ?? data.fees?.rate ?? Number.NaN);

  if (Number.isFinite(feeRate) && feeRate >= 0) {
    return feeRate > 1 ? feeRate / 100 : feeRate;
  }
  if (feeAmount <= 0) return 0;
  return feeAmount / QUOTE_FEE_PROBE_AMOUNT;
}

// ── Main signal generator ─────────────────────────────────────────────────────
export async function generateSignal(state, forecastBias = null) {
  const yesPrice = Number(state.yesPrice);

  // ── Session ────────────────────────────────────────────────────────────────
  const session = getCurrentSession();
  console.log(`[signal] Session: ${session.name} (threshold multiplier: ${session.multiplier}x)`);

  // ── Early window detection ─────────────────────────────────────────────────
  // Within the first 90 seconds of a new window, a fresh forecast enables faster
  // entry with a reduced score requirement — instead of waiting for indicators
  // to accumulate, the pre-computed forecast provides the directional thesis.
  const secondsSinceWindowOpen = state.windowOpenTime
    ? (Date.now() - new Date(state.windowOpenTime).getTime()) / 1000
    : Number.POSITIVE_INFINITY;
  const isEarlyWindow = secondsSinceWindowOpen <= 90;

  if (isEarlyWindow) {
    console.log(
      `[signal] Early window — ${secondsSinceWindowOpen.toFixed(0)}s since open` +
      (forecastBias ? ` | forecast: ${forecastBias.direction} (conf=${forecastBias.confidence.toFixed(2)})` : ' | no forecast'),
    );
  }

  // ── Fetch Binance candles (1m + 15m) ──────────────────────────────────────
  let binanceCandles = null;
  let htfCandles     = null;

  try {
    binanceCandles = await fetchBTCKlines(REGIME_CANDLE_LIMIT);
    console.log(`[signal] 1m Binance candles fetched: ${binanceCandles.length}`);
  } catch (err) {
    console.warn(`[signal] 1m Binance fetch failed, falling back to internal: ${err.message}`);
  }

  try {
    htfCandles = await fetchBTCKlines15m(HTF_CANDLE_LIMIT);
    console.log(`[signal] 15m Binance candles fetched: ${htfCandles.length}`);
  } catch (err) {
    console.warn(`[signal] 15m Binance fetch failed — HTF bias unavailable: ${err.message}`);
  }

  // ── Regime classification ──────────────────────────────────────────────────
  let regime = null;
  if (binanceCandles && binanceCandles.length >= 30) {
    try {
      regime = classifyRegime(binanceCandles);
    } catch (err) {
      console.warn(`[regime] Classification error — proceeding without filter: ${err.message}`);
      regime = { regime: 'UNKNOWN', reason: err.message };
    }

    console.log(`[regime] ${regime.regime} — ${regime.reason}`);

    if (regime.regime === 'CHOPPY' || regime.regime === 'FLAT') {
      return {
        shouldTrade: false,
        direction:   null,
        pUp:         0.5,
        netEdge:     0,
        confidence:  0,
        stake:       0,
        regime:      regime.regime,
        signalScore: 0,
        session:     session.name,
        reason:      `Regime filter blocked: ${regime.regime} — ${regime.reason}`,
        delta5m:     0,
      };
    }

    if (regime.regime === 'TRENDING' && regime.contradicted) {
      console.warn(`[regime] TRENDING ${regime.direction} blocked — MACD contradicts (${regime.macdDirection})`);
      return {
        shouldTrade: false,
        direction:   null,
        pUp:         0.5,
        netEdge:     0,
        confidence:  0,
        stake:       0,
        regime:      'CONTRADICTED',
        signalScore: 0,
        session:     session.name,
        reason:      `Regime contradiction blocked: EMA says ${regime.direction} but MACD says ${regime.macdDirection}`,
        delta5m:     0,
      };
    }
  }

  // ── Indicator calculations ─────────────────────────────────────────────────
  const internalCandles = getCandles(state.priceHistory);
  const {
    momentumScore,
    delta5m,
    rsi,
    macdValues,
  } = computeMomentum(state.priceHistory, internalCandles, binanceCandles);

  const candlesForVolume = (binanceCandles && binanceCandles.length >= 6)
    ? binanceCandles
    : internalCandles;
  const volumeScore = computeVolumeScore(candlesForVolume, momentumScore);

  // Bollinger Bands (on 1m closes)
  const candlesForBollinger = binanceCandles?.length >= BOLLINGER_PERIOD
    ? binanceCandles
    : internalCandles;
  const bollingerData = bollingerBands(
    candlesForBollinger.map(c => c.close),
    BOLLINGER_PERIOD,
    BOLLINGER_STD_DEVS,
  );

  // Higher-timeframe bias
  const htfBias = computeHTFBias(htfCandles);
  if (htfBias) {
    console.log(
      `[signal:htf] 15m bias=${htfBias.direction} ` +
      `separation=${(htfBias.strength * 100).toFixed(4)}%`,
    );
  } else {
    console.log('[signal:htf] 15m bias unavailable — score factor skipped');
  }

  if (bollingerData) {
    console.log(
      `[signal:bollinger] pctB=${bollingerData.pctB.toFixed(3)} ` +
      `width=${(bollingerData.width * 100).toFixed(4)}% ` +
      `upper=${bollingerData.upper.toFixed(2)} lower=${bollingerData.lower.toFixed(2)}`,
    );
  }

  // ── Model probability ──────────────────────────────────────────────────────
  const modelP    = clamp(0.5 + momentumScore * 0.3 + volumeScore * 0.2, 0, 1);
  const hasSignal = Math.abs(momentumScore) > 0.1 || Math.abs(volumeScore) > 0.1;
  const pUp       = hasSignal ? modelP : 0.5;

  const yesEdgeRaw = pUp - yesPrice;
  const noEdgeRaw  = (1 - pUp) - (1 - yesPrice);

  const yesOutcomeId = state.outcome1Id ?? state.yesOutcomeId;
  const noOutcomeId  = state.outcome2Id ?? state.noOutcomeId;

  // ── Quote fee probes ───────────────────────────────────────────────────────
  let yesFeeRatio = null;
  let noFeeRatio  = null;

  try {
    if (yesOutcomeId) {
      yesFeeRatio = await fetchQuoteFeeRatio(state.eventId, state.marketId, yesOutcomeId);
    }
  } catch (e) {
    if (!e.message.includes('no liquidity')) {
      return {
        shouldTrade: false, direction: null, pUp, netEdge: 0,
        confidence: 0, stake: 0, signalScore: 0, session: session.name,
        reason: `Quote fee error YES: ${e.message}`, delta5m,
      };
    }
  }

  try {
    if (noOutcomeId) {
      noFeeRatio = await fetchQuoteFeeRatio(state.eventId, state.marketId, noOutcomeId);
    }
  } catch (e) {
    if (!e.message.includes('no liquidity')) {
      return {
        shouldTrade: false, direction: null, pUp, netEdge: 0,
        confidence: 0, stake: 0, signalScore: 0, session: session.name,
        reason: `Quote fee error NO: ${e.message}`, delta5m,
      };
    }
  }

  if (yesFeeRatio === null && noFeeRatio === null) {
    return {
      shouldTrade: false, direction: null, pUp, netEdge: 0,
      confidence: 0, stake: 0, signalScore: 0, session: session.name,
      reason: 'No liquidity on either side', delta5m,
    };
  }

  // ── Edge calculation ───────────────────────────────────────────────────────
  const netYesEdge = yesFeeRatio !== null ? yesEdgeRaw - yesFeeRatio : -Infinity;
  const netNoEdge  = noFeeRatio  !== null ? noEdgeRaw  - noFeeRatio  : -Infinity;

  const direction       = netYesEdge >= netNoEdge ? 'YES' : 'NO';
  const outcomeId       = direction === 'YES' ? yesOutcomeId : noOutcomeId;
  const directionalEdge = direction === 'YES' ? netYesEdge : netNoEdge;
  const oddsDivergence  = clamp(directionalEdge, -1, 1);

  const directionMultiplier = direction === 'NO' ? -1 : 1;
  const compositeScore =
    oddsDivergence * 0.4 +
    (momentumScore * directionMultiplier) * 0.35 +
    (volumeScore   * directionMultiplier) * 0.25;

  // ── Dynamic threshold ──────────────────────────────────────────────────────
  let threshold = yesPrice >= 0.4 && yesPrice <= 0.6 ? 0.65 : 0.55;
  if (Math.abs(delta5m) > 0.5) threshold -= 0.05;

  const marketIsExtreme = yesPrice > 0.65 || yesPrice < 0.35;
  if (!marketIsExtreme) {
    const absEdge = Math.abs(directionalEdge);
    if      (absEdge >= 0.25) threshold = Math.min(threshold, 0.35);
    else if (absEdge >= 0.15) threshold = Math.min(threshold, 0.45);
    else if (absEdge >= 0.10) threshold -= 0.05;
  } else {
    threshold = Math.min(threshold + 0.10, 0.80);
  }

  // Session multiplier: adjusts threshold based on session reliability
  if (SESSION_AWARENESS_ENABLED) {
    threshold = clamp(threshold * session.multiplier, 0.25, 0.90);
  }

  // Adaptive threshold from journal win rates
  if (TRADE_JOURNAL_ENABLED) {
    const rates = getWinRates();
    if (rates.totalResolved >= 5) {
      const sessionRate = rates.bySession[session.name];
      const regimeRate  = rates.byRegime[regime?.regime ?? 'UNKNOWN'];
      let adaptiveDelta = 0;

      // Session win rate < 40% → tighten by 0.05
      if (sessionRate && sessionRate.total >= 3) {
        const sessionWR = sessionRate.wins / sessionRate.total;
        if (sessionWR < 0.40) {
          adaptiveDelta += 0.05;
          console.log(
            `[adaptive] Session ${session.name} win rate low ` +
            `(${(sessionWR * 100).toFixed(0)}%) — raising threshold +0.05`,
          );
        }
      }

      // Regime win rate > 65% → relax by 0.03
      if (regimeRate && regimeRate.total >= 3) {
        const regimeWR = regimeRate.wins / regimeRate.total;
        if (regimeWR > 0.65) {
          adaptiveDelta -= 0.03;
          console.log(
            `[adaptive] Regime ${regime?.regime} win rate high ` +
            `(${(regimeWR * 100).toFixed(0)}%) — lowering threshold -0.03`,
          );
        }
      }

      threshold = clamp(threshold + adaptiveDelta, 0.25, 0.90);
    }
  }

  // ── Signal score ───────────────────────────────────────────────────────────
  const signalScore = computeSignalScore({
    direction,
    rsi,
    macdValues,
    volumeScore,
    bollingerData,
    htfBias,
    delta5m,
    regime,
    session,
    forecastBias,
  });

  console.log(
    `[signal:detail] yes_edge=${netYesEdge === -Infinity ? 'no-liq' : netYesEdge.toFixed(3)} ` +
    `no_edge=${netNoEdge === -Infinity ? 'no-liq' : netNoEdge.toFixed(3)} ` +
    `direction=${direction} odds=${oddsDivergence.toFixed(3)} ` +
    `momentum=${momentumScore.toFixed(3)} volume=${volumeScore.toFixed(3)} ` +
    `composite=${compositeScore.toFixed(3)} threshold=${threshold.toFixed(3)} ` +
    `pUp=${pUp.toFixed(3)} yesPrice=${yesPrice} score=${signalScore} ` +
    `session=${session.name} regime=${regime?.regime ?? 'none'} ` +
    `adx=${regime?.adx?.toFixed(1) ?? 'n/a'} ` +
    `htf=${htfBias?.direction ?? 'n/a'} ` +
    `bollinger_pctB=${bollingerData?.pctB?.toFixed(3) ?? 'n/a'}`,
  );

  // ── Signal score gate ──────────────────────────────────────────────────────
  // Early window + confident forecast = lower score requirement.
  // Rationale: the forecast has already done analysis before the window opened;
  // waiting for a full score in the first 90 seconds means missing the entry.
  // Floor is 3 to prevent any signal from firing without at least basic confluence.
  const effectiveScoreMin = (
    isEarlyWindow &&
    forecastBias &&
    forecastBias.direction !== 'NEUTRAL' &&
    forecastBias.confidence > 0.55
  ) ? Math.max(SIGNAL_SCORE_MIN - 2, 3) : SIGNAL_SCORE_MIN;

  if (compositeScore > threshold && directionalEdge > 0 && signalScore < effectiveScoreMin) {
    const earlyNote = effectiveScoreMin < SIGNAL_SCORE_MIN
      ? ` (early window — reduced from ${SIGNAL_SCORE_MIN})`
      : '';
    console.warn(
      `[score] Signal score gate blocked trade — score=${signalScore} < required=${effectiveScoreMin}${earlyNote}`,
    );
    return {
      shouldTrade: false,
      direction:   null,
      pUp,
      netEdge:     directionalEdge,
      confidence:  compositeScore,
      stake:       0,
      regime:      regime?.regime ?? 'UNKNOWN',
      signalScore,
      session:     session.name,
      reason:      `Signal score ${signalScore} below minimum ${effectiveScoreMin}${earlyNote} — not enough confirming factors`,
      delta5m,
    };
  }

  // ── Kelly stake sizing ─────────────────────────────────────────────────────
  const pricedSide = direction === 'YES' ? yesPrice : 1 - yesPrice;
  const kellyRaw   = pricedSide > 0 ? directionalEdge / pricedSide : 0;
  const kelly      = Math.min(kellyRaw, 1.5); // cap to prevent blow-up at extreme odds

  const confidenceMargin = Math.max(0, compositeScore - threshold);
  const confidenceScale  = Math.min(1, confidenceMargin / 0.08);
  const rawStake         = kelly * state.balance * KELLY_FRACTION * confidenceScale;

  const maxAffordableStake        = Math.min(MAX_STAKE_NGN, state.balance);
  const hasMinimumBalanceForStake = maxAffordableStake >= MIN_STAKE_NGN;
  const stake = hasMinimumBalanceForStake
    ? clamp(rawStake, MIN_STAKE_NGN, maxAffordableStake)
    : 0;

  const shouldTrade =
    compositeScore > threshold && directionalEdge > 0 && hasMinimumBalanceForStake;

  const baseSignal = {
    shouldTrade,
    direction:  shouldTrade ? direction : null,
    outcomeId:  shouldTrade ? outcomeId : null,
    pUp,
    netEdge:    directionalEdge,
    confidence: compositeScore,
    stake:      Number(stake.toFixed(2)),
    regime:     regime?.regime ?? 'UNKNOWN',
    signalScore,
    session:    session.name,
    adx:        regime?.adx ?? null,
    htfBias:    htfBias?.direction ?? null,
    bollingerPctB: bollingerData?.pctB ?? null,
    forecastDirection:  forecastBias?.direction  ?? null,
    forecastConfidence: forecastBias?.confidence ?? null,
    isEarlyWindow,
    reason: shouldTrade
      ? `Score ${signalScore}/10 — composite crossed dynamic threshold (${threshold.toFixed(3)})`
      : hasMinimumBalanceForStake
        ? `Composite ${compositeScore.toFixed(3)} did not beat threshold ${threshold.toFixed(3)} or edge <= 0`
        : `Insufficient balance for minimum stake (${MIN_STAKE_NGN} ${CURRENCY})`,
    delta5m,
  };

  // ── Alpha layer ────────────────────────────────────────────────────────────
  let alphaSignal = { active: false, direction: null, strength: 0, confidence: null };
  try {
    alphaSignal = generateAlphaSignal(state);
  } catch (err) {
    // alpha is fail-safe — ignore errors
  }

  console.log(
    `[alpha] active=${alphaSignal.active} dir=${alphaSignal.direction} ` +
    `strength=${alphaSignal.strength?.toFixed(4) ?? 'n/a'}`,
  );

  const finalSignal = combineSignals(baseSignal, alphaSignal, state);

  // Alpha hard gate: base-only marginal trades require alpha confirmation
  if (
    finalSignal.shouldTrade &&
    !alphaSignal.active &&
    finalSignal.decision?.source === 'base'
  ) {
    const marginAboveThreshold = compositeScore - threshold;
    if (marginAboveThreshold < 0.08) {
      console.warn(
        `[alpha] Hard gate blocked base-only trade — ` +
        `margin ${marginAboveThreshold.toFixed(3)} < 0.08 required without alpha confirmation`,
      );
      return {
        ...finalSignal,
        shouldTrade: false,
        stake:  0,
        reason: `Alpha inactive — base-only signal rejected (margin ${marginAboveThreshold.toFixed(3)} < 0.08 without alpha)`,
      };
    }
  }

  return finalSignal;
}
