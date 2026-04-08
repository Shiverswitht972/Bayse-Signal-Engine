export function getCandles(priceHistory, intervalMinutes = 1) {
  const bucketMs = intervalMinutes * 60 * 1000;
  const byBucket = new Map();

  for (const tick of priceHistory) {
    const ts = new Date(tick.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;

    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const candle = byBucket.get(bucket);

    if (!candle) {
      byBucket.set(bucket, {
        timestamp: new Date(bucket).toISOString(),
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volume ?? 1,
      });
      continue;
    }

    candle.high = Math.max(candle.high, tick.price);
    candle.low = Math.min(candle.low, tick.price);
    candle.close = tick.price;
    candle.volume += tick.volume ?? 1;
  }

  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candle]) => candle);
}
