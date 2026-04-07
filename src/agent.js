import WebSocket from 'ws';
import { BASE_URL, buildReadHeaders } from './auth.js';
import { generateSignal } from './signal.js';
import { executeOrder } from './executor.js';
import { sendNotification } from './notify.js';

export const MAX_STAKE_NGN = 6500;
export const DAILY_LOSS_FLOOR = 500;
export const KELLY_FRACTION = 0.5;
export const MIN_STAKE_NGN = 150;
export const CURRENCY = 'NGN';

const MIN_HISTORY_POINTS = 6;
const MINUTES_BETWEEN_TRADES = 15;
const MARKET_END_BUFFER_MINUTES = 3;
const BALANCE_REFRESH_MS = 5 * 60 * 1000;
const ODDS_REFRESH_MS = 30_000;
const WS_BACKOFF_START_MS = 2_000;
const WS_BACKOFF_MAX_MS = 30_000;

const state = {
  btcPrice: null,
  priceHistory: [],
  yesPrice: null,
  noPrice: null,
  eventId: null,
  marketId: null,
  eventTitle: null,
  resolvesAt: null,
  balance: null,
  lastTradeAt: null,
  dailyPnL: 0,
  dailyPnLResetDate: null,
};

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

function resetDailyPnlIfNeeded() {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (state.dailyPnLResetDate !== utcDate) {
    state.dailyPnL = 0;
    state.dailyPnLResetDate = utcDate;
    console.log(`[agent] Daily PnL reset for UTC date ${utcDate}`);
  }
}

function minutesUntilResolution() {
  if (!state.resolvesAt) return Number.POSITIVE_INFINITY;
  const msLeft = new Date(state.resolvesAt).getTime() - Date.now();
  return msLeft / 60000;
}

function shouldSkipEvaluation() {
  if (state.priceHistory.length < MIN_HISTORY_POINTS) {
    return 'Not enough price history yet';
  }

  if (state.balance == null || state.balance <= 0) {
    return 'Missing or non-positive balance';
  }

  if (state.dailyPnL <= -DAILY_LOSS_FLOOR) {
    return `Daily loss floor reached (<= -${DAILY_LOSS_FLOOR})`;
  }

  if (minutesUntilResolution() < MARKET_END_BUFFER_MINUTES) {
    return `Market resolves in less than ${MARKET_END_BUFFER_MINUTES} minutes`;
  }

  if (state.lastTradeAt) {
    const elapsedMs = Date.now() - new Date(state.lastTradeAt).getTime();
    if (elapsedMs < MINUTES_BETWEEN_TRADES * 60 * 1000) {
      return `Last trade was placed less than ${MINUTES_BETWEEN_TRADES} minutes ago`;
    }
  }

  return null;
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...buildReadHeaders(),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${path}: ${text}`);
  }

  return response.json();
}

function parseOpenBtcEvent(payload) {
  const events = payload?.data ?? payload?.events ?? payload ?? [];
  const list = Array.isArray(events) ? events : [];

  const btcEvent = list.find((event) => {
    const title = String(event.title ?? event.name ?? '').toUpperCase();
    const symbol = String(event.symbol ?? '').toUpperCase();
    return title.includes('BTC') || symbol.includes('BTC');
  });

  if (!btcEvent) {
    throw new Error('No open BTC event found');
  }

  const market = btcEvent.market ?? btcEvent.markets?.[0] ?? {};

  return {
    eventId: btcEvent.id ?? btcEvent.eventId,
    marketId: market.id ?? market.marketId,
    eventTitle: btcEvent.title ?? btcEvent.name ?? 'BTC market',
    resolvesAt: btcEvent.resolvesAt ?? btcEvent.endTime ?? btcEvent.closeTime ?? null,
  };
}

async function refreshEventContext() {
  const payload = await fetchJson('/v1/pm/events?category=crypto&status=open');
  const eventContext = parseOpenBtcEvent(payload);

  state.eventId = eventContext.eventId;
  state.marketId = eventContext.marketId;
  state.eventTitle = eventContext.eventTitle;
  state.resolvesAt = eventContext.resolvesAt;

  if (!state.eventId || !state.marketId) {
    throw new Error('Event context is missing eventId or marketId');
  }

  return eventContext;
}

async function refreshBalance() {
  try {
    if (state.balance === null) {
      state.balance = 1000;
      state.dayStartBalance = 1000;
    }
    resetDailyPnlIfNeeded();
    console.log(`[agent] Balance set: ${state.balance} ${CURRENCY}`);
  } catch (error) {
    console.error('[agent] Balance refresh failed:', error.message);
  }
}

async function refreshOdds() {
  try {
    const payload = await fetchJson(
      `/v1/pm/events/${state.eventId}?currency=NGN`
    );
    const markets = payload?.markets ?? payload?.data?.markets ?? [];
    const market = markets.find(m => m.id === state.marketId) ?? markets[0];
    if (!market) {
      console.log('[odds] No matching market found in event response');
      return;
    }

    const prices = market.prices ?? {};
    const yes = Number(prices.YES ?? prices.yes);
    const no = Number(prices.NO ?? prices.no);

    if (Number.isFinite(yes)) state.yesPrice = yes;
    if (Number.isFinite(no)) state.noPrice = no;

    console.log(`[odds] YES=${state.yesPrice} NO=${state.noPrice}`);
  } catch (err) {
    console.error('[odds] refresh failed:', err.message);
  }
}

async function evaluateAndMaybeTrade() {
  const skipReason = shouldSkipEvaluation();
  if (skipReason) {
    console.log(`[signal] skipped: ${skipReason}`);
    return;
  }

  const signal = await generateSignal(state);

  if (!signal.shouldTrade) {
    console.log(`[signal] no trade: ${signal.reason}`);
    return;
  }

  const result = await executeOrder(signal, state);
  await sendNotification(signal, result, state);
}

function addPriceTick(tick) {
  const price = Number(tick.price ?? tick.lastPrice ?? tick.value);
  if (!Number.isFinite(price)) return;

  const timestamp = tick.timestamp ?? tick.ts ?? new Date().toISOString();

  state.btcPrice = price;

  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  state.priceHistory = state.priceHistory.filter(
    t => new Date(t.timestamp).getTime() > cutoff
  );

  state.priceHistory.push({ price, timestamp, volume: Number(tick.volume ?? 1) });
}

function createReconnectableWs(name, url, handlers) {
  let socket = null;
  let attempts = 0;

  const connect = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    socket = new WebSocket(url);

    socket.on('open', async () => {
      attempts = 0;
      console.log(`[ws:${name}] connected`);
      try {
        await handlers.onOpen(socket);
      } catch (error) {
        console.error(`[ws:${name}] onOpen failed:`, error.message);
        socket.close();
      }
    });

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        await handlers.onMessage(message);
      } catch (error) {
        console.error(`[ws:${name}] message handling error:`, error.message);
      }
    });

    socket.on('error', (error) => {
      console.error(`[ws:${name}] error:`, error.message);
    });

    socket.on('close', () => {
      attempts += 1;
      const delay = Math.min(WS_BACKOFF_START_MS * 2 ** (attempts - 1), WS_BACKOFF_MAX_MS);
      console.log(`[ws:${name}] closed, reconnecting in ${delay}ms`);
      setTimeout(connect, delay);
    });
  };

  connect();
}

export async function startAgent() {
  console.log('[agent] Starting Bayse Signal Engine agent loop');

  await refreshEventContext();
  await refreshBalance();
  await refreshOdds();

  setInterval(refreshBalance, BALANCE_REFRESH_MS);
  setInterval(refreshOdds, ODDS_REFRESH_MS);

  createReconnectableWs('asset-prices', 'wss://socket.bayse.markets/ws/v1/realtime', {
    onOpen: async (socket) => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: 'asset_prices',
        symbols: ['BTCUSDT'],
      }));
    },
    onMessage: async (message) => {
      if (message.type !== 'asset_price') return;

      addPriceTick(message.data ?? message);

      if (state.yesPrice != null) {
        await evaluateAndMaybeTrade();
      }
    },
  });
}

export { state };
