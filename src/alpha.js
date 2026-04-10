/**
 * Alpha Module — Independent momentum-based signal layer.
 * Read-only: never writes to state.
 * Fail-safe: errors must be caught by the caller.
 */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeReturns(priceHistory) {
  if (priceHistory.length < 2) return null;

  const now = priceHistory.at(-1);
  const nowTs = new Date(now.timestamp).getTime();
  const nowPrice = now.price;

  const find = (msAgo) => {
    const target = nowTs - msAgo;
    let closest = null;
    for (let i = priceHistory.length - 2; i >= 0; i--) {
      const ts = new Date(priceHistory[i].timestamp).getTime();
      if (ts <= target) { closest = priceHistory[i]; break; }
    }
    return closest;
  };

  const p1m = find(60_000);
  const p3m = find(3 * 60_000);
  const p5m = find(5 * 60_000);

  if (!p1m || !p3m || !p5m) return null;

  return {
    r1m: (nowPrice - p1m.price) / p1m.price,
    r3m: (nowPrice - p3m.price) / p3m.price,
    r5m: (nowPrice - p5m.price) / p5m.price,
  };
}

function computeVolumeScore(priceHistory) {
  if (priceHistory.length < 6) return 0;

  const recent = priceHistory.slice(-5);
  const current = recent.at(-1).volume ?? 1;
  const avg5m = recent.reduce((s, t) => s + (t.volume ?? 1), 0) / recent.length;

  if (avg5m <= 0) return 0;
  const ratio = current / avg5m;
  return Math.log(Math.max(ratio, 0.01));
}

function computeVolatility(priceHistory) {
  if (priceHistory.length < 5) return 0;

  const recent = priceHistory.slice(-10);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].price;
    const curr = recent[i].price;
    if (prev > 0) returns.push((curr - prev) / prev);
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function minutesSinceMarketStart(resolvesAt) {
  if (!resolvesAt) return null;
  const resolveTs = new Date(resolvesAt).getTime();
  const marketDurationMs = 15 * 60_000;
  const startTs = resolveTs - marketDurationMs;
  return (Date.now() - startTs) / 60_000;
}

export function generateAlphaSignal(state) {
  const MIN_VOL_THRESHOLD = 0.0001;

  const returns = computeReturns(state.priceHistory);
  if (!returns) {
    return { active: false, direction: null, strength: 0, confidence: null, reason: 'Insufficient price history' };
  }

  const { r1m, r3m, r5m } = returns;
  const M = 0.5 * r1m + 0.3 * r3m + 0.2 * r5m;
  const A = r1m - r3m;
  const vScore = computeVolumeScore(state.priceHistory);
  const sigma = computeVolatility(state.priceHistory);

  const rawScore = M + 1.2 * A + 0.5 * vScore;
  let adjScore = rawScore * (1 + sigma);

  // Time-sensitivity adjustment
  const t = minutesSinceMarketStart(state.resolvesAt);
  if (t !== null) {
    if (t <= 5) adjScore *= 1.2;
    else if (t >= 12) adjScore *= 0.7;
  }

  // Guardrails
  const strength = Math.abs(adjScore);
  const valid =
    strength > 0.1 &&
    sigma > MIN_VOL_THRESHOLD &&
    !(vScore < 0 && Math.abs(M) < 0.02);

  if (!valid) {
    return { active: false, direction: null, strength, confidence: null, reason: 'Alpha guardrails not met' };
  }

  const direction = adjScore > 0 ? 'YES' : 'NO';
  const pUpAlpha = clamp(1 / (1 + Math.exp(-5 * adjScore)), 0.05, 0.95);

  return {
    active: true,
    direction,
    strength,
    confidence: pUpAlpha,
    reason: 'Alpha signal valid',
  };
}

export function combineSignals(baseSignal, alphaSignal, state) {
  const t = minutesSinceMarketStart(state.resolvesAt);

  // Rule 4 — both weak
  if (!baseSignal.shouldTrade && !alphaSignal.active) {
    return { ...baseSignal, decision: { final_signal: 'NONE', source: 'none' } };
  }

  // Rule 2 — early alpha override
  if (t !== null && t <= 5 && alphaSignal.active && alphaSignal.strength > 0.2 && !baseSignal.shouldTrade) {
    return {
      ...baseSignal,
      shouldTrade: true,
      direction: alphaSignal.direction,
      outcomeId: alphaSignal.direction === 'YES'
        ? (state.outcome1Id ?? state.yesOutcomeId)
        : (state.outcome2Id ?? state.noOutcomeId),
      confidence: alphaSignal.confidence,
      reason: 'Alpha early override',
      decision: { final_signal: alphaSignal.direction, source: 'alpha_override' },
    };
  }

  // Rule 1 — agreement boost
  if (baseSignal.shouldTrade && alphaSignal.active && baseSignal.direction === alphaSignal.direction) {
    return {
      ...baseSignal,
      confidence: clamp((baseSignal.confidence + alphaSignal.confidence) / 2, 0, 1),
      reason: 'Base + alpha agreement',
      decision: { final_signal: baseSignal.direction, source: 'agreement_boost' },
    };
  }

  // Rule 3 — conflict, alpha weak
  if (baseSignal.shouldTrade && alphaSignal.active && baseSignal.direction !== alphaSignal.direction) {
    if (alphaSignal.strength < 0.2) {
      return { ...baseSignal, decision: { final_signal: baseSignal.direction, source: 'base' } };
    }
    // Both strong but disagree — no trade
    return {
      ...baseSignal,
      shouldTrade: false,
      reason: 'Base and alpha conflict — no trade',
      decision: { final_signal: 'NONE', source: 'conflict' },
    };
  }

  return { ...baseSignal, decision: { final_signal: baseSignal.shouldTrade ? baseSignal.direction : 'NONE', source: 'base' } };
}
