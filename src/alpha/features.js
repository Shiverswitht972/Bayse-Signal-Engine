function toTs(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function findPriceAtOrBefore(priceHistory, targetTs) {
  for (let i = priceHistory.length - 1; i >= 0; i -= 1) {
    const tick = priceHistory[i];
    const tickTs = toTs(tick.timestamp);
    if (tickTs == null) continue;
    if (tickTs <= targetTs && Number.isFinite(Number(tick.price))) {
      return Number(tick.price);
    }
  }
  return null;
}

export function computeReturns(priceHistory) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 2) {
    return { r1m: 0, r3m: 0, r5m: 0, hasData: false };
  }

  const latest = priceHistory.at(-1);
  const nowPrice = Number(latest?.price);
  const nowTs = toTs(latest?.timestamp);
  if (!Number.isFinite(nowPrice) || nowTs == null) {
    return { r1m: 0, r3m: 0, r5m: 0, hasData: false };
  }

  const p1 = findPriceAtOrBefore(priceHistory, nowTs - 60_000);
  const p3 = findPriceAtOrBefore(priceHistory, nowTs - 3 * 60_000);
  const p5 = findPriceAtOrBefore(priceHistory, nowTs - 5 * 60_000);

  const ratio = (p) => (p && p !== 0 ? (nowPrice - p) / p : 0);
  return {
    r1m: ratio(p1),
    r3m: ratio(p3),
    r5m: ratio(p5),
    hasData: Boolean(p1 && p3 && p5),
  };
}

export function computeVolumeScore(priceHistory) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 6) {
    return { v: 1, vScore: 0 };
  }

  const recent = priceHistory.at(-1);
  const volCurrent = Number(recent?.volume ?? 1);
  const past5 = priceHistory.slice(-6, -1).map((t) => Number(t.volume ?? 1));
  const avgVol5 = past5.reduce((a, b) => a + b, 0) / past5.length;

  if (!Number.isFinite(volCurrent) || !Number.isFinite(avgVol5) || avgVol5 <= 0) {
    return { v: 1, vScore: 0 };
  }

  const v = volCurrent / avgVol5;
  return {
    v,
    vScore: Math.log(Math.max(v, 1e-6)),
  };
}

export function computeSigma(priceHistory) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 4) return 0;

  const window = priceHistory.slice(-11);
  const returns = [];
  for (let i = 1; i < window.length; i += 1) {
    const prev = Number(window[i - 1].price);
    const curr = Number(window[i].price);
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) continue;
    returns.push((curr - prev) / prev);
  }

  if (returns.length < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}
