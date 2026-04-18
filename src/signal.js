import { BASE_URL, buildWriteHeaders } from './auth.js';
import { getCandles } from './candles.js';
import { generateAlphaSignal, combineSignals } from './alpha.js';
import {
  CURRENCY,
  KELLY_FRACTION,
  MAX_STAKE_NGN,
  MIN_STAKE_NGN,
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

function computeMomentum(priceHistory, candles) {
  const closes = candles.map((c) => c.close);
  const rsi = rsiWilder(closes, 14);
  const macdValues = macd(closes);
  const delta5m = computeDelta5m(priceHistory);

  const rsiScore = rsi == null ? 0 : rsi > 55 ? 1 : rsi < 45 ? -1 : 0;
  const macdScore =
    macdValues == null ? 0 : macdValues.macd > macdValues.signal ? 1 : -1;
  const deltaScore = clamp(delta5m / 1.0, -1, 1);

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
  const feeRate = Number(data.feeRate ?? data.quote?.feeRate ?? data.fees?.rate ?? Number.NaN);

  if (Number.isFinite(feeRate) && feeRate >= 0) {
    return feeRate > 1 ? feeRate / 100 : feeRate;
  }

  if (feeAmount <= 0) return 0;

  return feeAmount / QUOTE_FEE_PROBE_AMOUNT;
}

export async function generateSignal(state) {
  const yesPrice = Number(state.yesPrice);
  const marketImpliedP = clamp(yesPrice, 0, 1);

  const candles = getCandles(state.priceHistory);
  const { momentumScore, delta5m } = computeMomentum(state.priceHistory, candles);
  const volumeScore = computeVolumeScore(candles, momentumScore);

  const modelP = clamp(0.5 + momentumScore * 0.3 + volumeScore * 0.2, 0, 1);
  const pUp = clamp(modelP * 0.7 + marketImpliedP * 0.3, 0, 1);

  const rawEdge = pUp - yesPrice;

  const direction = pUp >= 0.5 ? 'YES' : 'NO';
  const outcomeId = direction === 'YES'
    ? (state.outcome1Id ?? state.yesOutcomeId)
    : (state.outcome2Id ?? state.noOutcomeId);

  let feeRatio;
  try {
    if (!outcomeId) {
      feeRatio = 0.05;
    } else {
      feeRatio = await fetchQuoteFeeRatio(state.eventId, state.marketId, outcomeId);
    }
  } catch (error) {
    if (error.message.includes('no liquidity')) {
      feeRatio = 0.05;
    } else {
      return {
        shouldTrade: false,
        direction: null,
        pUp,
        netEdge: 0,
        confidence: 0,
        stake: 0,
        reason: `Could not fetch quote fee: ${error.message}`,
        delta5m,
      };
    }
  }

  const netEdge = rawEdge - feeRatio;
  const oddsDivergence = clamp(netEdge, -1, 1);

  const compositeScore =
    oddsDivergence * 0.4 + momentumScore * 0.35 + volumeScore * 0.25;

  let threshold = yesPrice >= 0.4 && yesPrice <= 0.6 ? 0.65 : 0.55;
  if (Math.abs(delta5m) > 0.5) {
    threshold -= 0.05;
  }

  // Detail log — shows exactly what each layer is contributing
  console.log(
    `[signal:detail] odds=${oddsDivergence.toFixed(3)} momentum=${momentumScore.toFixed(3)} volume=${volumeScore.toFixed(3)} composite=${compositeScore.toFixed(3)} threshold=${threshold.toFixed(3)} pUp=${pUp.toFixed(3)} yesPrice=${yesPrice}`
  );

  const pricedSide = direction === 'YES' ? yesPrice : 1 - yesPrice;
  const directionalEdge =
    direction === 'YES' ? netEdge : -(pUp - yesPrice) - feeRatio;

  const kelly = pricedSide > 0 ? directionalEdge / pricedSide : 0;
  const rawStake = kelly * state.balance * KELLY_FRACTION;
  const maxAffordableStake = Math.min(MAX_STAKE_NGN, state.balance);
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

  return combineSignals(baseSignal, alphaSignal, state);
}
