import { BASE_URL, buildWriteHeaders } from './auth.js';
import { getCandles } from './candles.js';
import { generateAlphaSignal, combineSignals } from './alpha.js';
import { fetchBTCKlines } from './perception.js';
import { classifyRegime } from './regime.js';
import {
  CURRENCY,
  KELLY_FRACTION,
  MAX_STAKE_NGN,
  MIN_STAKE_NGN,
  REGIME_CANDLE_LIMIT,
} from './config.js';

const QUOTE_FEE_PROBE_AMOUNT = 100;

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

function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return null;

  const offset = 26 - 12;
  const macdLine = ema26.map((value, index) => ema12[index + offset] - value);
  const signalLine = ema(macdLine, 9);
  if (signalLine.length === 0) return null;

  return {
    macd: macdLine.at(-1),
    signal: signalLine.at(-1),
  };
}

function computeDelta5m(priceHistory) {
  if (priceHistory.length < 2) return 0;

  const latest = priceHistory.at(-1);
  const latestTs = new Date(latest.timestamp).getTime();
  if (!Number.isFinite(latestTs)) return 0;

  const targetTs = latestTs - 5 * 60 * 1000;
  let baseline = null;

  for (let i = priceHistory.length - 2; i >= 0; i -= 1) {
    const tick = priceHistory[i];
    const tickTs = new Date(tick.timestamp).getTime();
    if (!Number.isFinite(tickTs)) continue;
    if (tickTs <= targetTs) {
      baseline = tick;
      break;
    }
  }

  if (!baseline || !baseline.price) return 0;
  return ((latest.price - baseline.price) / baseline.price) * 100;
}

function computeMomentum(priceHistory, internalCandles, binanceCandles) {
  const candles = (binanceCandles && binanceCandles.length >= 35)
    ? binanceCandles
    : internalCandles;

  const closes = candles.map((c) => c.close);
  const rsi = rsiWilder(closes, 14);
  const macdValues = macd(closes);
  const delta5m = computeDelta5m(priceHistory);

  const rsiScore  = rsi == null ? 0 : rsi > 55 ? 1 : rsi < 45 ? -1 : 0;
  const macdScore = macdValues == null ? 0 : macdValues.macd > macdValues.signal ? 1 : -1;
  const deltaScore = clamp(delta5m / 1.0, -1, 1);

  console.log(
    `[signal:data] source=${candles === binanceCandles ? 'binance' : 'internal'} candles=${candles.length} rsi=${rsi?.toFixed(2) ?? 'null'} macd=${macdValues ? `${macdValues.macd.toFixed(4)}>${macdValues.signal.toFixed(4)}` : 'null'}`,
  );

  const momentumScore = clamp((rsiScore + macdScore + deltaScore) / 3, -1, 1);
  return { momentumScore, delta5m };
}

function computeVolumeScore(candles, momentumScore) {
  if (candles.length < 6) return 0;

  const last3 = candles.slice(-3);
  const prev3 = candles.slice(-6, -3);

  const avg = (arr) => arr.reduce((sum, c) => sum + Number(c.volume ?? 0), 0) / arr.length;
  const lastAvg = avg(last3);
  const prevAvg = avg(prev3);

  if (prevAvg <= 0) return 0;

  const trend = (lastAvg - prevAvg) / prevAvg;
  const directional = Math.sign(momentumScore) || 1;
  return clamp(trend * directional, -1, 1);
}

async function fetchQuoteFeeRatio(eventId, marketId, outcomeId) {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/quote`;
  const bodyObj = {
    type: 'MARKET',
    side: 'BUY',
    outcomeId,
    amount: QUOTE_FEE_PROBE_AMOUNT,
    currency: CURRENCY,
  };
  const body = JSON.stringify(bodyObj);

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: buildWriteHeaders('POST', path, body),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Quote request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const feeAmount = Number(data.fee ?? data.quote?.fee ?? data.fees?.total ?? 0);
  const feeRate   = Number(data.feeRate ?? data.quote?.feeRate ?? data.fees?.rate ?? Number.NaN);

  if (Number.isFinite(feeRate) && feeRate >= 0) {
    return feeRate > 1 ? feeRate / 100 : feeRate;
  }
  if (feeAmount <= 0) return 0;
  return feeAmount / QUOTE_FEE_PROBE_AMOUNT;
}

export async function generateSignal(state) {
  const yesPrice = Number(state.yesPrice);

  // ── Fetch Binance candles ──────────────────────────────────────────────────
  let binanceCandles = null;
  try {
    binanceCandles = await fetchBTCKlines(REGIME_CANDLE_LIMIT);
    console.log(`[signal] Binance candles fetched: ${binanceCandles.length}`);
  } catch (err) {
    console.warn(`[signal] Binance fetch failed, falling back to internal candles: ${err.message}`);
  }

  // ── Regime filter ──────────────────────────────────────────────────────────
  if (binanceCandles && binanceCandles.length >= 30) {
    let regime;
    try {
      regime = classifyRegime(binanceCandles);
    } catch (err) {
      console.warn(`[regime] Classification error — proceeding without filter: ${err.message}`);
      regime = { regime: 'UNKNOWN', reason: err.message };
    }

    console.log(`[regime] ${regime.regime} — ${regime.reason}`);

    // Block flat or choppy markets
    if (regime.regime === 'CHOPPY' || regime.regime === 'FLAT') {
      return {
        shouldTrade: false,
        direction: null,
        pUp: 0.5,
        netEdge: 0,
        confidence: 0,
        stake: 0,
        reason: `Regime filter blocked: ${regime.regime} — ${regime.reason}`,
        delta5m: 0,
        regime: regime.regime,
      };
    }

    // Block when MACD contradicts the EMA trend direction
    if (regime.regime === 'TRENDING' && regime.contradicted) {
      console.warn(`[regime] TRENDING ${regime.direction} blocked — MACD contradicts (${regime.macdDirection})`);
      return {
        shouldTrade: false,
        direction: null,
        pUp: 0.5,
        netEdge: 0,
        confidence: 0,
        stake: 0,
        reason: `Regime contradiction blocked: EMA says ${regime.direction} but MACD says ${regime.macdDirection}`,
        delta5m: 0,
        regime: 'CONTRADICTED',
      };
    }
  }

  // ── Indicator calculations ─────────────────────────────────────────────────
  const internalCandles = getCandles(state.priceHistory);
  const { momentumScore, delta5m } = computeMomentum(
    state.priceHistory,
    internalCandles,
    binanceCandles,
  );

  const candlesForVolume = (binanceCandles && binanceCandles.length >= 6)
    ? binanceCandles
    : internalCandles;
  const volumeScore = computeVolumeScore(candlesForVolume, momentumScore);

  // ── Clean model probability — no circular yesPrice anchor ─────────────────
  const modelP   = clamp(0.5 + momentumScore * 0.3 + volumeScore * 0.2, 0, 1);
  const hasSignal = Math.abs(momentumScore) > 0.1 || Math.abs(volumeScore) > 0.1;
  const pUp       = hasSignal ? modelP : 0.5;

  const yesEdgeRaw = pUp - yesPrice;
  const noEdgeRaw  = (1 - pUp) - (1 - yesPrice);

  const yesOutcomeId = state.outcome1Id ?? state.yesOutcomeId;
  const noOutcomeId  = state.outcome2Id ?? state.noOutcomeId;

  let yesFeeRatio = null;
  let noFeeRatio  = null;

  try {
    if (yesOutcomeId) {
      yesFeeRatio = await fetchQuoteFeeRatio(state.eventId, state.marketId, yesOutcomeId);
    }
  } catch (e) {
    if (!e.message.includes('no liquidity')) {
      return {
        shouldTrade: false, direction: null, pUp,
        netEdge: 0, confidence: 0, stake: 0,
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
        shouldTrade: false, direction: null, pUp,
        netEdge: 0, confidence: 0, stake: 0,
        reason: `Quote fee error NO: ${e.message}`, delta5m,
      };
    }
  }

  if (yesFeeRatio === null && noFeeRatio === null) {
    return {
      shouldTrade: false, direction: null, pUp,
      netEdge: 0, confidence: 0, stake: 0,
      reason: 'No liquidity on either side', delta5m,
    };
  }

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

  let threshold = yesPrice >= 0.4 && yesPrice <= 0.6 ? 0.65 : 0.55;
  if (Math.abs(delta5m) > 0.5) threshold -= 0.05;

  // ✅ FIX: Threshold direction fix for extreme markets.
  // Previously, a large edge (absEdge >= 0.25) would DROP threshold to 0.35
  // regardless of market conditions. When yesPrice=0.79 and the model has
  // high "edge" on NO, that edge is our model being strongly contrarian
  // against 79% crowd consensus — a reason to RAISE the bar, not lower it.
  // Threshold reduction only applies when the market is balanced (35-65%).
  // Outside that range, we raise threshold to require stronger conviction.
  const marketIsExtreme = yesPrice > 0.65 || yesPrice < 0.35;
  if (!marketIsExtreme) {
    const absEdge = Math.abs(directionalEdge);
    if (absEdge >= 0.25) threshold = Math.min(threshold, 0.35);
    else if (absEdge >= 0.15) threshold = Math.min(threshold, 0.45);
    else if (absEdge >= 0.10) threshold -= 0.05;
  } else {
    // Extreme market: require meaningfully higher conviction to bet against the crowd.
    // Cap at 0.80 so it doesn't become unreachable in all cases.
    threshold = Math.min(threshold + 0.10, 0.80);
  }

  console.log(
    `[signal:detail] yes_edge=${netYesEdge === -Infinity ? 'no-liq' : netYesEdge.toFixed(3)} no_edge=${netNoEdge === -Infinity ? 'no-liq' : netNoEdge.toFixed(3)} direction=${direction} odds=${oddsDivergence.toFixed(3)} momentum=${momentumScore.toFixed(3)} volume=${volumeScore.toFixed(3)} composite=${compositeScore.toFixed(3)} threshold=${threshold.toFixed(3)} pUp=${pUp.toFixed(3)} yesPrice=${yesPrice}`,
  );

  // ✅ FIX: Kelly multiplier cap + confidence-margin stake scaling.
  //
  // Kelly blow-up: when betting the low-probability side (e.g. NO at pricedSide=0.21),
  // the Kelly formula produces multipliers near 2x. At KELLY_FRACTION=0.5 that is
  // effectively full-porting the balance. Cap at 1.5 to prevent this.
  //
  // Confidence scaling: barely-over-threshold trades should never get full Kelly.
  // Scale stake linearly from 0 at threshold to full Kelly at threshold + 0.08.
  // This means a composite of 0.375 vs threshold 0.65 would get near-zero stake
  // even if Kelly is large — protecting capital on marginal signals.
  const pricedSide = direction === 'YES' ? yesPrice : 1 - yesPrice;
  const kellyRaw   = pricedSide > 0 ? directionalEdge / pricedSide : 0;
  const kelly      = Math.min(kellyRaw, 1.5);

  const confidenceMargin = Math.max(0, compositeScore - threshold);
  const confidenceScale  = Math.min(1, confidenceMargin / 0.08);
  const rawStake         = kelly * state.balance * KELLY_FRACTION * confidenceScale;

  const maxAffordableStake     = Math.min(MAX_STAKE_NGN, state.balance);
  const hasMinimumBalanceForStake = maxAffordableStake >= MIN_STAKE_NGN;
  const stake = hasMinimumBalanceForStake
    ? clamp(rawStake, MIN_STAKE_NGN, maxAffordableStake)
    : 0;

  const shouldTrade =
    compositeScore > threshold && directionalEdge > 0 && hasMinimumBalanceForStake;

  const baseSignal = {
    shouldTrade,
    direction: shouldTrade ? direction : null,
    outcomeId: shouldTrade ? outcomeId : null,
    pUp,
    netEdge: directionalEdge,
    confidence: compositeScore,
    stake: Number(stake.toFixed(2)),
    reason: shouldTrade
      ? 'Composite signal crossed dynamic threshold'
      : hasMinimumBalanceForStake
        ? `Composite score ${compositeScore.toFixed(3)} did not beat threshold ${threshold.toFixed(3)} or edge <= 0`
        : `Insufficient balance for minimum stake (${MIN_STAKE_NGN} ${CURRENCY})`,
    delta5m,
  };

  let alphaSignal = { active: false, direction: null, strength: 0, confidence: null };
  try {
    alphaSignal = generateAlphaSignal(state);
  } catch (err) {
    // alpha is fail-safe — ignore errors
  }

  console.log(`[alpha] active=${alphaSignal.active} dir=${alphaSignal.direction} strength=${alphaSignal.strength?.toFixed(4) ?? 'n/a'}`);

  const finalSignal = combineSignals(baseSignal, alphaSignal, state);

  // ✅ FIX: Alpha hard gate on base-only marginal trades.
  // combineSignals passes base signals through unchecked when alpha is inactive —
  // alpha can boost or agree but it currently cannot veto. This gate closes that gap.
  // If alpha didn't fire AND the trade is purely base-driven AND the composite is
  // within 0.08 of threshold, block the trade. Alpha inactivity + thin margin is
  // the exact combination that produced the full-port loss in the logged trade.
  if (
    finalSignal.shouldTrade &&
    !alphaSignal.active &&
    finalSignal.decision?.source === 'base'
  ) {
    const marginAboveThreshold = compositeScore - threshold;
    if (marginAboveThreshold < 0.08) {
      console.warn(
        `[alpha] Hard gate blocked base-only trade — margin ${marginAboveThreshold.toFixed(3)} < 0.08 required without alpha confirmation`,
      );
      return {
        ...finalSignal,
        shouldTrade: false,
        stake: 0,
        reason: `Alpha inactive — base-only signal rejected (margin ${marginAboveThreshold.toFixed(3)} < 0.08 required without alpha confirmation)`,
      };
    }
  }

  return finalSignal;
}
