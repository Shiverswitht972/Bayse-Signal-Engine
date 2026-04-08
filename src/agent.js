import WebSocket from 'ws';
import { BASE_URL, buildReadHeaders } from './auth.js';
import { generateSignal } from './signal.js';
import { executeOrder } from './executor.js';
import { sendNotification } from './notify.js';
import { combineSignals, generateAlphaSignal } from './alpha/alphaEngine.js';
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

const state = {
  btcPrice: null,
  priceHistory: [],
  yesPrice: null,
  noPrice: null,
  yesOutcomeId: null,
  noOutcomeId: null,
  eventId: null,
  marketId: null,
  eventTitle: null,
  resolvesAt: null,
  balance: null,
  lastTradeAt: null,
  dailyPnL: 0,
  dailyPnLResetDate: null,
  dayStartBalance: null,
};

export { getCandles } from './candles.js';

let isEvaluatingSignal = false;
let pendingEvaluation = false;

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
  if (state.priceHistory.length < MIN_HISTORY_POINTS) {
    return 'Not enough price history yet';
  }

  if (state.balance == null || state.balance <= 0) {
    return 'Missing or non-positive balance';
  }

  if (!state.yesOutcomeId || !state.noOutcomeId) {
    return 'Missing outcomeIds for market execution';
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
    throw new Error('No open BTC crypto event found');
  }

  const market = btcEvent.market ?? btcEvent.markets?.[0] ?? {};
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  const yesOutcome = outcomes.find((o) => String(o.name ?? o.label ?? o.outcome ?? '').toUpperCase() === 'YES');
  const noOutcome = outcomes.find((o) => String(o.name ?? o.label ?? o.outcome ?? '').toUpperCase() === 'NO');

  return {
    eventId: btcEvent.id ?? btcEvent.eventId,
    marketId: market.id ?? market.marketId,
    eventTitle: btcEvent.title ?? btcEvent.name ?? 'BTC market',
    resolvesAt: btcEvent.resolvesAt ?? btcEvent.endTime ?? btcEvent.closeTime ?? null,
    yesOutcomeId: yesOutcome?.id ?? yesOutcome?.outcomeId ?? null,
    noOutcomeId: noOutcome?.id ?? noOutcome?.outcomeId ?? null,
  };
}

async function refreshEventContext() {
  const payload = await fetchJson('/v1/pm/events?category=crypto&status=open');
  const eventContext = parseOpenBtcEvent(payload);

  state.eventId = eventContext.eventId;
  state.marketId = eventContext.marketId;
  state.eventTitle = eventContext.eventTitle;
  state.resolvesAt = eventContext.resolvesAt;
  state.yesOutcomeId = eventContext.yesOutcomeId;
  state.noOutcomeId = eventContext.noOutcomeId;

  if (!state.eventId || !state.marketId) {
    throw new Error('Event context is missing eventId or marketId');
  }

  return eventContext;
}


function extractNgnBalance(payload) {
  const direct = payload?.balances?.NGN ?? payload?.wallet?.NGN ?? payload?.balance;
  const directNumber = Number(direct);
  if (Number.isFinite(directNumber)) {
    return directNumber;
  }

  const wallets = payload?.wallets ?? payload?.balances ?? payload?.accounts;
  const entries = Array.isArray(wallets)
    ? wallets
    : wallets && typeof wallets === 'object'
      ? Object.values(wallets)
      : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const currency = String(entry.currency ?? entry.asset ?? entry.code ?? '').toUpperCase();
    if (currency !== 'NGN') continue;

    const value = Number(entry.available ?? entry.balance ?? entry.amount ?? entry.free);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

async function refreshBalance() {
  try {
    const data = await fetchJson('/v1/pm/portfolio');
    state.balance = extractNgnBalance(data);
    resetDailyPnlIfNeeded();

    if (state.dayStartBalance == null && state.balance != null) {
      state.dayStartBalance = state.balance;
    }

    if (state.dayStartBalance != null && state.balance != null) {
      state.dailyPnL = Number((state.balance - state.dayStartBalance).toFixed(2));
    }

    console.log(`[agent] Balance refreshed: ${state.balance ?? 'unavailable'} ${CURRENCY} | dailyPnL=${state.dailyPnL}`);
  } catch (error) {
    console.error('[agent] Balance refresh failed:', error.message);
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

      const baseSignal = await generateSignal(state);

      let alphaSignal = { active: false, direction: null, strength: 0, confidence: null };
      try {
        alphaSignal = generateAlphaSignal(state);
      } catch (error) {
        console.error('[alpha] failed; falling back to base signal:', error.message);
      }

      const signal = combineSignals(baseSignal, alphaSignal, state);

      if (!signal.shouldTrade) {
        console.log(`[signal] no trade: ${signal.reason}`);
        continue;
      }

      const result = await executeOrder(signal, state);
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
  state.priceHistory.push({
    price,
    timestamp,
    volume: Number(tick.volume ?? 1),
  });

  const latestTs = new Date(timestamp).getTime();
  if (Number.isFinite(latestTs)) {
    const cutoffTs = latestTs - 60 * 60 * 1000;
    state.priceHistory = state.priceHistory.filter((entry) => {
      const entryTs = new Date(entry.timestamp).getTime();
      return Number.isFinite(entryTs) && entryTs >= cutoffTs;
    });
  }
}

function updateOdds(payload) {
  const raw = payload?.data ?? payload?.payload ?? payload;
  const entries = Array.isArray(raw) ? raw : [raw];

  for (const data of entries) {
    if (!data || typeof data !== "object") continue;
    const incomingEventId = data.eventId ?? null;
    const incomingMarketId = data.marketId ?? null;

    if (incomingEventId && state.eventId && incomingEventId !== state.eventId) {
      continue;
    }

    if (incomingMarketId && state.marketId && incomingMarketId !== state.marketId) {
      continue;
    }

    const yes = Number(data.yesPrice ?? data.yes ?? data.prices?.yes);
    const no = Number(data.noPrice ?? data.no ?? data.prices?.no);

    if (Number.isFinite(yes)) state.yesPrice = yes;
    if (Number.isFinite(no)) state.noPrice = no;

    if (incomingEventId && !state.eventId) state.eventId = incomingEventId;
    if (incomingMarketId && !state.marketId) state.marketId = incomingMarketId;
    if (data.resolvesAt) state.resolvesAt = data.resolvesAt;

    const outcomeName = String(data.outcome ?? data.name ?? '').toUpperCase();
    if (outcomeName === 'YES' && data.outcomeId) state.yesOutcomeId = data.outcomeId;
    if (outcomeName === 'NO' && data.outcomeId) state.noOutcomeId = data.outcomeId;

    if (data.yesOutcomeId) state.yesOutcomeId = data.yesOutcomeId;
    if (data.noOutcomeId) state.noOutcomeId = data.noOutcomeId;
  }
}


function parseAssetTick(message) {
  const payload = message?.data ?? message?.payload ?? message;
  const candidates = Array.isArray(payload) ? payload : [payload];

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;

    const symbol = String(item.symbol ?? item.asset ?? item.ticker ?? '').toUpperCase();
    const type = String(message?.type ?? message?.event ?? '').toLowerCase();
    const channel = String(message?.channel ?? item?.channel ?? '').toLowerCase();

    const symbolMatches = !symbol || symbol.includes('BTC');
    const streamTagged = Boolean(type || channel);
    const streamMatches =
      !streamTagged ||
      type.includes('asset_price') ||
      type.includes('price') ||
      channel.includes('asset_prices') ||
      channel.includes('prices');

    const rawPrice = item.price ?? item.lastPrice ?? item.value ?? item.markPrice;
    const parsed = Number(rawPrice);
    if (!Number.isFinite(parsed) || !symbolMatches || !streamMatches) {
      continue;
    }

    return {
      price: parsed,
      timestamp: item.timestamp ?? item.ts ?? item.time ?? new Date().toISOString(),
      volume: Number(item.volume ?? item.qty ?? 1),
    };
  }

  return null;
}

function messageHasOdds(message) {
  const payload = message?.data ?? message?.payload ?? message;
  const entries = Array.isArray(payload) ? payload : [payload];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const yes = Number(entry.yesPrice ?? entry.yes ?? entry.prices?.yes);
    const no = Number(entry.noPrice ?? entry.no ?? entry.prices?.no);
    if (Number.isFinite(yes) || Number.isFinite(no)) {
      return true;
    }
  }
  return false;
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
  setInterval(refreshBalance, BALANCE_REFRESH_MS);

  createReconnectableWs('asset-prices', 'wss://socket.bayse.markets/ws/v1/realtime', {
    onOpen: async (socket) => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: 'asset_prices',
        symbols: ['BTCUSDT'],
      }));
    },
    onMessage: async (message) => {
      const tick = parseAssetTick(message);
      if (!tick) {
        return;
      }

      addPriceTick(tick);

      if (state.yesPrice == null) {
        console.log('[signal] waiting for odds update before evaluation');
        return;
      }

      await evaluateAndMaybeTrade();
    },
  });

  createReconnectableWs('market-prices', 'wss://socket.bayse.markets/ws/v1/markets', {
    onOpen: async (socket) => {
      const event = await refreshEventContext();
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: 'prices',
        eventId: event.eventId,
      }));
    },
    onMessage: async (message) => {
      if (!messageHasOdds(message)) {
        return;
      }

      updateOdds(message);
      if (state.yesPrice != null || state.noPrice != null) {
        console.log(`[ws:market-prices] odds updated yes=${state.yesPrice} no=${state.noPrice}`);
      }
    },
  });
}

export { state };
