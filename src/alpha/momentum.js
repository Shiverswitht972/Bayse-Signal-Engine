import { computeReturns, computeSigma, computeVolumeScore } from './features.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

export function computeMomentumAlpha(priceHistory) {
  const { r1m, r3m, r5m, hasData } = computeReturns(priceHistory);
  const { vScore } = computeVolumeScore(priceHistory);
  const sigma = computeSigma(priceHistory);

  const m = 0.5 * r1m + 0.3 * r3m + 0.2 * r5m;
  const a = r1m - r3m;
  const score = m + 1.2 * a + 0.5 * vScore;
  const scoreAdjBase = score * (1 + sigma);

  return {
    hasData,
    r1m,
    r3m,
    r5m,
    momentum: m,
    acceleration: a,
    vScore,
    sigma,
    score,
    scoreAdjBase,
    pUpAlpha: clamp(logistic(5 * scoreAdjBase), 0.05, 0.95),
  };
}
