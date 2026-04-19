import WebSocket from 'ws';
import { BASE_URL, buildReadHeaders } from './auth.js';
import { generateSignal } from './signal.js';
import { executeOrder } from './executor.js';
import { sendNotification } from './notify.js';
import { isInExpiryDeadZone } from './utils/expiryDeadZone.js';
import {
  BALANCE_REFRESH_MS,
  CURRENCY,
  DAILY_LOSS_FLOOR,
  MARKET_END_BUFFER_MINUTES,
  MIN_HISTORY_POINTS,
  MINUTES_BETWEEN_TRADES,
  WS_BACKOFF_MAX_MS,
  WS_BACKOFF_START_MS,
} from './config.js';

const ODDS_REFRESH_MS = 30_000;

const state = {
  btcPrice: null,
  priceHistory: [],
  yesPrice: null,
  noPrice: null,
  yesOutcomeId: null,
  noOutcomeId: null,
  outcome1Id: null,
  outcome2Id: null,
  eventId: null,
  marketId: null,
  eventTitle: null,
  resolvesAt: null,
  openingPrice: null,
  balance: null,
  lastTradeAt: null,
  dailyPnL: 0,
  dailyPnLResetDate: null,
  dayStartBalance: null,
};

export { getCandles } from './candles.js';

let isEvaluatingSignal = false;
let pendingEvaluation = false;
let previousEventId = null;

function resetDailyPnlIfNeeded() {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (state.dailyPnLResetDate !== utcDate) {
    state.dailyPnL = 0;
    state.dailyPnLResetDate = utcDate;
    state.dayStartBalance = state.balance;
    console.log(`[agent] Daily PnL reset for UTC date ${utcDate}`);
  }
}

function minutesUntilResolution() {
  if (!state.resolvesAt) return Number.POSITIVE_INFINITY;
  const msLeft = new Date(state.resolvesAt).getTime() - Date.now();
  return msLeft / 60000;
}

function shouldSkipEvaluation() {
  // Never trade when market is too one-sided — no real liquidity and model has no edge
if (state.yesPrice !== null && (state.yesPrice < 0.10 || state.yesPrice > 0.90)) {
  return 'Market too one-sided — skipping';
}
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

  if (state.btcPrice && state.resolvesAt && state.openingPrice) {
    if (isInExpiryDeadZone(
      new Date(state.resolvesAt).getTime(),
      state.btcPrice,
      state.openingPrice
    )) {
      const secsLeft = Math.round((new Date(state.resolvesAt).getTime() - Date.now()) / 1000);
      const priceDelta = Math.abs(state.btcPrice - state.openingPrice).toFixed(2);
      console.warn(`[DEAD ZONE] Skipped — ${secsLeft}s to expiry, price $${priceDelta} from line`);
      return 'Expiry dead zone — too close to line near resolution';
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

  const btcEvent =
    list.find((event) => {
      const title = String(event.title ?? event.name ?? '').toUpperCase();
      return title.includes('UP') && title.includes('DOWN') && title.includes('BTC');
    }) ??
    list.find((event) => {
      const title = String(event.title ?? event.name ?? '').toUpperCase();
      return title.includes('BITCOIN') && (title.includes('UP') || title.includes('DOWN'));
    });

  if (!btcEvent) {
    throw new Error('No open BTC UP/DOWN event found');
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

  if (eventContext.eventId !== previousEventId) {
    state.openingPrice = state.btcPrice;
    previousEventId = eventContext.eventId;
    console.log(`[agent] New market window detected — opening price: $${state.openingPrice}`);
  }

  state.eventId = eventContext.eventId;
  state.marketId = eventContext.marketId;
  state.eventTitle = eventContext.eventTitle;
  state.resolvesAt = eventContext.resolvesAt;

  if (!state.eventId || !state.marketId) {
    throw new Error('Event context is missing eventId or marketId');
  }

  console.log(`[agent] Event context: ${state.eventTitle} (${state.eventId})`);
  return eventContext;
}

async function refreshBalance() {
  try {
    const data = await fetchJson('/v1/wallet/assets');
    const assets = data?.assets ?? [];
    const ngnAsset = assets.find(a => a.symbol === 'NGN');
    const balance = ngnAsset ? Number(ngnAsset.availableBalance) : null;

    if (Number.isFinite(balance)) {
      state.balance = balance;
    }

    resetDailyPnlIfNeeded();

    if (state.dayStartBalance == null && state.balance != null) {
      state.dayStartBalance = state.balance;
    }

    if (state.dayStartBalance != null && state.balance != null) {
      state.dailyPnL = Number((state.balance - state.dayStartBalance).toFixed(2));
    }

    console.log(`[agent] Balance: ${state.balance ?? 'unavailable'} ${CURRENCY} | dailyPnL=${state.dailyPnL}`);
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

    const yes = Number(market.outcome1Price ?? market.prices?.YES ?? market.prices?.yes);
    const no = Number(market.outcome2Price ?? market.prices?.NO ?? market.prices?.no);

    if (Number.isFinite(yes) && yes > 0) state.yesPrice = yes;
    if (Number.isFinite(no) && no > 0) state.noPrice = no;

    if (yes === 0 && no === 0) {
      console.log('[odds] Market window closed, refreshing event context...');
      state.yesPrice = null;
      state.noPrice = null;
      try {
        await refreshEventContext();
      } catch (err) {
        console.log('[odds] No new market window open yet, will retry in 30s');
      }
      return;
    }

    if (market.outcome1Id) {
      state.outcome1Id = market.outcome1Id;
      state.yesOutcomeId = market.outcome1Id;
    }
    if (market.outcome2Id) {
      state.outcome2Id = market.outcome2Id;
      state.noOutcomeId = market.outcome2Id;
    }

    console.log(`[odds] YES=${state.yesPrice} NO=${state.noPrice} | yesOutcomeId=${state.yesOutcomeId}`);
  } catch (err) {
    console.error('[odds] refresh failed:', err.message);
  }
}

async function evaluateAndMaybeTrade() {
  if (isEvaluatingSignal) {
    pendingEvaluation = true;
    return;
  }

  isEvaluatingSignal = true;

  try {
    do {
      pendingEvaluation = false;

      const skipReason = shouldSkipEvaluation();
      if (skipReason) {
        console.log(`[signal] skipped: ${skipReason}`);
        continue;
      }

      const signal = await generateSignal(state);

      if (!signal.shouldTrade) {
        console.log(`[signal] no trade: ${signal.reason}`);
        continue;
      }

      // Lock out further attempts for this market window immediately
      // regardless of whether execution succeeds or fails
      state.lastTradeAt = new Date().toISOString();

      const result = await executeOrder(signal, state);

      if (!result.success && result.reason?.includes('no liquidity')) {
        console.log('[executor] No liquidity — skipping notification');
        continue;
      }

      await sendNotification(signal, result, state);
    } while (pendingEvaluation);
  } finally {
    isEvaluatingSignal = false;
  }
}
function addPriceTick(tick) {
  const price = Number(tick.price ?? tick.lastPrice ?? tick.value);
  if (!Number.isFinite(price)) return;

  const timestamp = tick.timestamp ?? tick.ts ?? new Date().toISOString();

  state.btcPrice = price;

  const cutoff = Date.now() - 60 * 60 * 1000;
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

  setInterval(async () => {
    try {
      await refreshEventContext();
      await refreshOdds();
    } catch (err) {
      console.error('[agent] Event context refresh failed:', err.message);
    }
  }, MINUTES_BETWEEN_TRADES * 60 * 1000);

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
