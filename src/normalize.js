const jsconfig = {
  maxStakeNGN: 6500,
  dailyLossFloor: 500,
  kellyFraction: 0.5,
  minEdge: null,
  minConfidence: null,
  currency: 'NGN',
  marketEngine: 'amm',
};

function round4(value) {
  return Number.parseFloat(Number(value).toFixed(4));
}

export function normalizeState({ market, balance, btcPrice, klines }) {
  if (!market) {
    return { valid: false, reason: 'No open BTC market with active markets found.' };
  }

  if (!Number.isFinite(balance) || balance <= 0) {
    return { valid: false, reason: 'NGN balance is zero or unavailable.' };
  }

  if (!Array.isArray(klines) || klines.length < 6) {
    return { valid: false, reason: 'Insufficient BTC kline history for 5m delta.' };
  }

  const closes = klines.map((candle) => candle.close).filter((close) => Number.isFinite(close));
  if (closes.length < 6 || closes.at(-6) === 0) {
    return { valid: false, reason: 'Invalid BTC close data for delta calculation.' };
  }

  const latestClose = closes.at(-1);
  const close5mAgo = closes.at(-6);
  const delta5m = round4(((latestClose - close5mAgo) / close5mAgo) * 100);

  const resolvesAtMs = new Date(market.resolvesAt).getTime();
  const minutesLeft = Number.isFinite(resolvesAtMs)
    ? round4((resolvesAtMs - Date.now()) / (1000 * 60))
    : null;

  return {
    valid: true,
    market,
    balance,
    btcPrice,
    klines,
    delta5m,
    minutesLeft,
    jsconfig,
  };
}
