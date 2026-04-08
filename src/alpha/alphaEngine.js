import {
  ALPHA_ENABLED,
  ALPHA_EARLY_MINUTE,
  ALPHA_EARLY_OVERRIDE_STRENGTH,
  ALPHA_LATE_MINUTE,
  ALPHA_MIN_STRENGTH,
  MIN_STAKE_NGN,
  MIN_VOL_THRESHOLD,
} from '../config.js';
import { computeMomentumAlpha } from './momentum.js';

function minutesSinceMarketStart(state) {
  if (!state?.resolvesAt) return null;
  const minsToEnd = (new Date(state.resolvesAt).getTime() - Date.now()) / 60000;
  return 15 - minsToEnd;
}

export function generateAlphaSignal(state) {
  if (!ALPHA_ENABLED) {
    return { active: false, direction: null, strength: 0, confidence: null, reason: 'alpha_disabled' };
  }

  const features = computeMomentumAlpha(state.priceHistory);
  let scoreAdj = features.scoreAdjBase;
  const t = minutesSinceMarketStart(state);

  if (t != null && t <= ALPHA_EARLY_MINUTE) scoreAdj *= 1.2;
  if (t != null && t >= ALPHA_LATE_MINUTE) scoreAdj *= 0.7;

  const direction = scoreAdj > 0 ? 'YES' : scoreAdj < 0 ? 'NO' : null;
  const strength = Math.abs(scoreAdj);
  const confidence = Math.min(Math.max(1 / (1 + Math.exp(-5 * scoreAdj)), 0.05), 0.95);

  const invalidByLowSignal = strength <= ALPHA_MIN_STRENGTH;
  const invalidByVolatility = features.sigma <= MIN_VOL_THRESHOLD;
  const invalidByVolumeMomentum = features.vScore < 0 && Math.abs(features.momentum) < 0.02;
  const active = features.hasData && !invalidByLowSignal && !invalidByVolatility && !invalidByVolumeMomentum;

  return {
    active,
    direction,
    strength,
    confidence,
    pUpAlpha: confidence,
    features,
    t,
    reason: active ? 'alpha_active' : 'alpha_guardrail',
  };
}

export function combineSignals(baseSignal, alphaSignal, state) {
  const t = minutesSinceMarketStart(state);
  const result = {
    ...baseSignal,
    alpha: {
      direction: alphaSignal?.direction ?? null,
      strength: alphaSignal?.strength ?? 0,
      confidence: alphaSignal?.confidence ?? null,
      active: Boolean(alphaSignal?.active),
    },
    decision: {
      final_signal: baseSignal.direction,
      source: 'base',
    },
  };

  const alphaStrong = Boolean(alphaSignal?.active) && (alphaSignal.strength ?? 0) >= ALPHA_EARLY_OVERRIDE_STRENGTH;

  if (baseSignal.shouldTrade && alphaSignal?.active && baseSignal.direction === alphaSignal.direction) {
    result.confidence = Math.min((result.confidence ?? 0) + 0.05, 1);
    result.decision = { final_signal: result.direction, source: 'agreement_boost' };
    return result;
  }

  if (
    t != null &&
    t <= ALPHA_EARLY_MINUTE &&
    alphaStrong &&
    (!baseSignal.shouldTrade || baseSignal.direction == null)
  ) {
    const alphaStake = Number(baseSignal.stake ?? 0) > 0
      ? Number(baseSignal.stake)
      : Math.min(Number(state.balance ?? 0), MIN_STAKE_NGN);

    return {
      ...result,
      shouldTrade: alphaStake >= MIN_STAKE_NGN,
      direction: alphaSignal.direction,
      pUp: alphaSignal.pUpAlpha,
      confidence: alphaSignal.confidence,
      stake: alphaStake,
      reason: 'alpha early override',
      decision: {
        final_signal: alphaSignal.direction,
        source: 'alpha_override',
      },
    };
  }

  if (
    baseSignal.shouldTrade &&
    alphaSignal?.active &&
    baseSignal.direction !== alphaSignal.direction &&
    !alphaStrong
  ) {
    result.decision = { final_signal: baseSignal.direction, source: 'base' };
    return result;
  }

  if (!baseSignal.shouldTrade && !alphaSignal?.active) {
    return {
      ...result,
      shouldTrade: false,
      direction: null,
      decision: { final_signal: null, source: 'base' },
      reason: 'base_and_alpha_weak',
    };
  }

  return result;
}
