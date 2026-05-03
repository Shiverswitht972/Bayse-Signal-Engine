import { BASE_URL, buildReadHeaders } from './auth.js';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function pickFirstOpenBTCEvent(events = []) {
  for (const event of events) {
    const title = String(event?.title ?? event?.name ?? '').toUpperCase();
    const category = String(event?.category ?? '').toLowerCase();
    const isBTC = title.includes('BTC') || title.includes('BITCOIN') || category === 'crypto';
    if (!isBTC) {
      continue;
    }
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const activeMarket = markets.find((market) => {
      const status = String(market?.status ?? 'active').toLowerCase();
      return status === 'active' || status === 'open';
    });
    if (!activeMarket) {
      continue;
    }
    const yesPrice = toNumber(
      activeMarket?.yesPrice ?? activeMarket?.oddsYes ?? activeMarket?.prices?.yes,
    );
    const noPrice = toNumber(
      activeMarket?.noPrice ?? activeMarket?.oddsNo ?? activeMarket?.prices?.no,
    );
    return {
      eventId: event?.id ?? event?.eventId ?? null,
      eventTitle: event?.title ?? event?.name ?? 'Untitled BTC Event',
      marketId: activeMarket?.id ?? activeMarket?.marketId ?? null,
      marketType: String(activeMarket?.engine ?? activeMarket?.marketType ?? 'amm').toLowerCase(),
      resolvesAt: event?.resolvesAt ?? event?.endTime ?? activeMarket?.resolvesAt ?? null,
      yesPrice,
      noPrice,
    };
  }
  return null;
}

export async function fetchCryptoMarket() {
  const path = '/v1/pm/events?category=crypto&status=open';
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: buildReadHeaders(),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fetchCryptoMarket failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  const events = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.events)
      ? data.events
      : Array.isArray(data)
        ? data
        : [];
  return pickFirstOpenBTCEvent(events);
}

export async function fetchBalance() {
  const path = '/v1/pm/portfolio';
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: buildReadHeaders(),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fetchBalance failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  return toNumber(data?.balances?.NGN ?? data?.wallet?.NGN ?? data?.balance ?? 0);
}

export async function fetchBTCPrice() {
  // ✅ Swapped to Binance market data mirror — same data, no geo-restriction
  const response = await fetch(
    'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fetchBTCPrice failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  return Number.parseFloat(data?.price);
}

export async function fetchBTCKlines(limit = 20) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
  // ✅ Swapped to Binance market data mirror — same data, no geo-restriction
  const response = await fetch(
    `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${safeLimit}`,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fetchBTCKlines failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((kline) => ({
    open:   Number.parseFloat(kline?.[1]),
    high:   Number.parseFloat(kline?.[2]),
    low:    Number.parseFloat(kline?.[3]),
    close:  Number.parseFloat(kline?.[4]),
    volume: Number.parseFloat(kline?.[5]),
  }));
}
