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
  MARKETS,
  MIN_HISTORY_POINTS,
  MINUTES_BETWEEN_TRADES,
  WS_BACKOFF_MAX_MS,
  WS_BACKOFF_START_MS,
} from './config.js';

export { getCandles } from './candles.js';

const ODDS_REFRESH_MS = 30_000;

// ── Wallet state — shared across all markets (single NGN balance) ─────────────
const walletState = {
  balance: null,
  dailyPnL: 0,
  dailyPnLResetDate: null,
  dayStartBalance: null,
};

// ── Per-market state factory ──────────────────────────────────────────────────
function createMarketState(cfg) {
  return {
    // Identity
    symbol: cfg.symbol,
    name: cfg.name,
    priceSymbol: cfg.priceSymbol,   // Symbol on Bayse WS (null = use Binance WS)
    klineSymbol: cfg.klineSymbol,   // Symbol for Binance klines API
    seriesSlug: cfg.seriesSlug,     // Bayse event series slug

    // Price feed
    currentPrice: null,
    priceHistory: [],

    // Market / event context
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
    previousEventId: null,

    // Trade cooldown (per-market — each market can trade independently)
    lastTradeAt: null,

    // Evaluation concurrency lock (per-market)
    isEvaluatingSignal: false,
    pendingEvaluation: false,
  };
}

// Build the Map of all market states keyed by symbol
const marketStates = new Map(MARKETS.map(cfg => [cfg.symbol, createMarketState(cfg)]));

// ── Merged state view ─────────────────────────────────────────────────────────
// Signal, executor, and skip-checks receive this object.
// Merges per-market state with wallet-level fields.
// btcPrice alias ensures expiryDeadZone + legacy compatibility.
function getEffectiveState(ms) {
  return {
    ...ms,
    btcPrice: ms.currentPrice,          // legacy alias used by expiryDeadZone
    balance: walletState.balance,
    dailyPnL: walletState.dailyPnL,
  };
}

// ── Daily PnL reset ───────────────────────────────────────────────────────────
function resetDailyPnlIfNeeded() {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (walletState.dailyPnLResetDate !== utcDate) {
    walletState.dailyPnL = 0;
    walletState.dailyPnLResetDate = utcDate;
    walletState.dayStartBalance = walletState.balance;
    console.log(`[wallet] Daily PnL reset for ${utcDate}`);
  }
}

// ── Skip evaluation checks (per-market) ──────────────────────────────────────
function minutesUntilResolution(ms) {
  if (!ms.resolvesAt) return Number.POSITIVE_INFINITY;
  return (new Date(ms.resolvesAt).getTime() - Date.now()) / 60_000;
}

function shouldSkipEvaluation(ms) {
  if (ms.yesPrice !== null && (ms.yesPrice < 0.15 || ms.yesPrice > 0.80)) {
    return `Market too one-sided (yesPrice=${ms.yesPrice?.toFixed(2)})`;
  }

  if (ms.priceHistory.length < MIN_HISTORY_POINTS) {
    return 'Not enough price history yet';
  }

  if (walletState.balance == null || walletState.balance <= 0) {
    return 'Missing or non-positive balance';
  }

  if (walletState.dailyPnL <= -DAILY_LOSS_FLOOR) {
    return `Daily loss floor reached (<= -${DAILY_LOSS_FLOOR})`;
  }

  if (minutesUntilResolution(ms) < MARKET_END_BUFFER_MINUTES) {
    return `Market resolves in less than ${MARKET_END_BUFFER_MINUTES} minutes`;
  }

  if (ms.lastTradeAt) {
    const elapsedMs = Date.now() - new Date(ms.lastTradeAt).getTime();
    if (elapsedMs < MINUTES_BETWEEN_TRADES * 60 * 1000) {
      return `Last trade was less than ${MINUTES_BETWEEN_TRADES} minutes ago`;
    }
  }

  if (ms.currentPrice && ms.resolvesAt && ms.openingPrice) {
    if (isInExpiryDeadZone(
      new Date(ms.resolvesAt).getTime(),
      ms.currentPrice,
      ms.openingPrice,
    )) {
      const secsLeft = Math.round((new Date(ms.resolvesAt).getTime() - Date.now()) / 1000);
      const priceDelta = Math.abs(ms.currentPrice - ms.openingPrice).toFixed(2);
      console.warn(`[DEAD ZONE:${ms.symbol}] ${secsLeft}s to expiry, $${priceDelta} from line`);
      return 'Expiry dead zone — too close to line near resolution';
    }
  }

  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchJson(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...buildReadHeaders() },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${path}: ${text}`);
  }

  return response.json();
}

// ── Event context (per-market) ────────────────────────────────────────────────
// Uses seriesSlug to always fetch the current open window for this market.
function parseOpenEventFromSeries(payload, ms) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.events)
      ? payload.events
      : Array.isArray(payload)
        ? payload
        : [];

  // seriesSlug filter returns only this series' events — first open one is the live window
  const event = list[0];
  if (!event) {
    throw new Error(`No open event found for ${ms.symbol} (seriesSlug=${ms.seriesSlug})`);
  }

  const market = event.market ?? event.markets?.[0] ?? {};

  return {
    eventId:    event.id ?? event.eventId,
    marketId:   market.id ?? market.marketId,
    eventTitle: event.title ?? event.name ?? `${ms.name} UP/DOWN`,
    resolvesAt: event.resolvesAt ?? event.endTime ?? event.closeTime ?? null,
  };
}

async function refreshEventContext(ms) {
  const payload = await fetchJson(
    `/v1/pm/events?seriesSlug=${ms.seriesSlug}&status=open`,
  );
  const ctx = parseOpenEventFromSeries(payload, ms);

  if (ctx.eventId !== ms.previousEventId) {
    ms.openingPrice = ms.currentPrice;
    ms.previousEventId = ctx.eventId;
    console.log(`[${ms.symbol}] New window — opening price: ${ms.openingPrice}`);
  }

  ms.eventId    = ctx.eventId;
  ms.marketId   = ctx.marketId;
  ms.eventTitle = ctx.eventTitle;
  ms.resolvesAt = ctx.resolvesAt;

  if (!ms.eventId || !ms.marketId) {
    throw new Error(`[${ms.symbol}] Event context missing eventId or marketId`);
  }

  console.log(`[${ms.symbol}] Event: ${ms.eventTitle} (${ms.eventId})`);
}

// ── Balance refresh (wallet-level — one NGN wallet across all markets) ─────────
async function refreshBalance() {
  try {
    const data = await fetchJson('/v1/wallet/assets');
    const ngnAsset = (data?.assets ?? []).find(a => a.symbol === 'NGN');
    const balance = ngnAsset ? Number(ngnAsset.availableBalance) : null;

    if (Number.isFinite(balance)) walletState.balance = balance;

    resetDailyPnlIfNeeded();

    if (walletState.dayStartBalance == null && walletState.balance != null) {
      walletState.dayStartBalance = walletState.balance;
    }

    if (walletState.dayStartBalance != null && walletState.balance != null) {
      walletState.dailyPnL = Number(
        (walletState.balance - walletState.dayStartBalance).toFixed(2),
      );
    }

    console.log(
      `[wallet] Balance: ${walletState.balance ?? 'unavailable'} ${CURRENCY} | dailyPnL=${walletState.dailyPnL}`,
    );
  } catch (err) {
    console.error('[wallet] Balance refresh failed:', err.message);
  }
}

// ── Odds refresh (per-market) ─────────────────────────────────────────────────
async function refreshOdds(ms) {
  if (!ms.eventId) return;

  try {
    const payload = await fetchJson(`/v1/pm/events/${ms.eventId}?currency=NGN`);
    const markets = payload?.markets ?? payload?.data?.markets ?? [];
    const market  = markets.find(m => m.id === ms.marketId) ?? markets[0];

    if (!market) {
      console.log(`[${ms.symbol}:odds] No matching market in response`);
      return;
    }

    const yes = Number(market.outcome1Price ?? market.prices?.YES ?? market.prices?.yes);
    const no  = Number(market.outcome2Price ?? market.prices?.NO  ?? market.prices?.no);

    if (Number.isFinite(yes) && yes > 0) ms.yesPrice = yes;
    if (Number.isFinite(no)  && no  > 0) ms.noPrice  = no;

    if (yes === 0 && no === 0) {
      console.log(`[${ms.symbol}:odds] Window closed — refreshing event context`);
      ms.yesPrice = null;
      ms.noPrice  = null;
      try { await refreshEventContext(ms); } catch (_) {
        console.log(`[${ms.symbol}:odds] No new window open yet, will retry`);
      }
      return;
    }

    if (market.outcome1Id) { ms.outcome1Id = market.outcome1Id; ms.yesOutcomeId = market.outcome1Id; }
    if (market.outcome2Id) { ms.outcome2Id = market.outcome2Id; ms.noOutcomeId  = market.outcome2Id; }

    console.log(`[${ms.symbol}:odds] YES=${ms.yesPrice} NO=${ms.noPrice}`);
  } catch (err) {
    console.error(`[${ms.symbol}:odds] refresh failed:`, err.message);
  }
}

// ── Evaluate and maybe trade (per-market, with concurrency lock) ──────────────
async function evaluateAndMaybeTrade(ms) {
  if (ms.isEvaluatingSignal) {
    ms.pendingEvaluation = true;
    return;
  }

  ms.isEvaluatingSignal = true;

  try {
    do {
      ms.pendingEvaluation = false;

      const skipReason = shouldSkipEvaluation(ms);
      if (skipReason) {
        console.log(`[${ms.symbol}:signal] skipped: ${skipReason}`);
        continue;
      }

      const effective = getEffectiveState(ms);
      const signal = await generateSignal(effective);

      if (!signal.shouldTrade) {
        console.log(`[${ms.symbol}:signal] no trade: ${signal.reason}`);
        continue;
      }

      // Lock out further attempts for this window before async execution
      ms.lastTradeAt = new Date().toISOString();

      const result = await executeOrder(signal, effective);

      if (!result.success && result.reason?.includes('no liquidity')) {
        console.log(`[${ms.symbol}:executor] No liquidity — skipping notification`);
        continue;
      }

      await sendNotification(signal, result, effective);
    } while (ms.pendingEvaluation);
  } finally {
    ms.isEvaluatingSignal = false;
  }
}

// ── Price tick ingestion ──────────────────────────────────────────────────────
function addPriceTick(ms, tick) {
  // Support Bayse WS format ({ price, timestamp }) and Binance miniTicker ({ c })
  const price = Number(tick.price ?? tick.c ?? tick.lastPrice ?? tick.value);
  if (!Number.isFinite(price)) return;

  const timestamp = tick.timestamp ?? new Date().toISOString();

  ms.currentPrice = price;

  // Keep 1 hour of history
  const cutoff = Date.now() - 60 * 60 * 1000;
  ms.priceHistory = ms.priceHistory.filter(
    t => new Date(t.timestamp).getTime() > cutoff,
  );

  ms.priceHistory.push({ price, timestamp, volume: Number(tick.volume ?? 1) });
}

// ── Reconnectable WebSocket factory ──────────────────────────────────────────
function createReconnectableWs(name, url, handlers) {
  let socket = null;
  let attempts = 0;

  const connect = async () => {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    socket = new WebSocket(url);

    socket.on('open', async () => {
      attempts = 0;
      console.log(`[ws:${name}] connected`);
      try { await handlers.onOpen(socket); } catch (err) {
        console.error(`[ws:${name}] onOpen failed:`, err.message);
        socket.close();
      }
    });

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        await handlers.onMessage(message);
      } catch (err) {
        console.error(`[ws:${name}] message error:`, err.message);
      }
    });

    socket.on('error', (err) => console.error(`[ws:${name}] error:`, err.message));

    socket.on('close', () => {
      attempts += 1;
      const delay = Math.min(WS_BACKOFF_START_MS * 2 ** (attempts - 1), WS_BACKOFF_MAX_MS);
      console.log(`[ws:${name}] closed — reconnecting in ${delay}ms`);
      setTimeout(connect, delay);
    });
  };

  connect();
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function initAllMarkets() {
  const results = await Promise.allSettled(
    [...marketStates.values()].map(async (ms) => {
      await refreshEventContext(ms);
      await refreshOdds(ms);
      console.log(`[${ms.symbol}] Initialized ✓`);
    }),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const sym = MARKETS[i]?.symbol ?? i;
      console.error(`[${sym}] Init failed — will retry on next context refresh:`, result.reason?.message);
    }
  }
}

export async function startAgent() {
  console.log('[agent] Starting multi-market engine — BTC / ETH / SOL / BNB (15min UP/DOWN)');

  await refreshBalance();
  await initAllMarkets();

  // ── Wallet-level intervals ────────────────────────────────────────────────
  setInterval(refreshBalance, BALANCE_REFRESH_MS);

  // ── Per-market intervals ──────────────────────────────────────────────────
  for (const ms of marketStates.values()) {
    // Odds polling every 30s
    setInterval(() => refreshOdds(ms).catch(err =>
      console.error(`[${ms.symbol}:odds] interval error:`, err.message)
    ), ODDS_REFRESH_MS);

    // Event context refresh every 15 minutes (aligns with window duration)
    setInterval(async () => {
      try {
        await refreshEventContext(ms);
        await refreshOdds(ms);
      } catch (err) {
        console.error(`[${ms.symbol}] Context refresh failed:`, err.message);
      }
    }, MINUTES_BETWEEN_TRADES * 60 * 1000);
  }

  // ── Bayse WS — BTC, ETH, SOL price feed ──────────────────────────────────
  // BNBUSDT is not available on the Bayse asset_prices channel.
  const bayseSymbols = MARKETS
    .filter(m => m.priceSymbol !== null)
    .map(m => m.priceSymbol);  // ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

  createReconnectableWs(
    'bayse-prices',
    'wss://socket.bayse.markets/ws/v1/realtime',
    {
      onOpen: async (socket) => {
        socket.send(JSON.stringify({
          type: 'subscribe',
          channel: 'asset_prices',
          symbols: bayseSymbols,
        }));
        console.log(`[ws:bayse-prices] Subscribed: ${bayseSymbols.join(', ')}`);
      },
      onMessage: async (message) => {
        if (message.type !== 'asset_price') return;

        const sym = message.data?.symbol;
        if (!sym) return;

        // Map priceSymbol (e.g. 'ETHUSDT') → marketState
        const ms = [...marketStates.values()].find(m => m.priceSymbol === sym);
        if (!ms) return;

        addPriceTick(ms, message.data ?? message);

        if (ms.yesPrice != null) {
          await evaluateAndMaybeTrade(ms);
        }
      },
    },
  );

  // ── Binance WS — BNB price feed ───────────────────────────────────────────
  // BNBUSDT is not on the Bayse WS, so we connect to Binance's miniTicker
  // stream directly. miniTicker fires every second with the last traded price.
  // Uses data-stream.binance.vision (official Binance market data mirror,
  // no geo restrictions) as the primary endpoint.
  // If the stream is unreachable from your Render region, consider switching
  // to the REST polling fallback: poll fetchKlines('BNBUSDT', 1) every 2s.
  const bnbState = marketStates.get('BNB');
  if (bnbState) {
    createReconnectableWs(
      'binance-bnb',
      'wss://data-stream.binance.vision/ws/bnbusdt@miniTicker',
      {
        onOpen: async () => {
          console.log('[ws:binance-bnb] BNBUSDT miniTicker connected');
        },
        onMessage: async (message) => {
          // Binance miniTicker payload: { e:'24hrMiniTicker', c:'<last price>', ... }
          if (!message.c) return;
          addPriceTick(bnbState, {
            price: Number(message.c),
            timestamp: new Date().toISOString(),
          });
          if (bnbState.yesPrice != null) {
            await evaluateAndMaybeTrade(bnbState);
          }
        },
      },
    );
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
export { walletState, marketStates };

// Legacy single-market state alias (BTC) — keeps any external consumers working
export const state = {
  get btcPrice() { return marketStates.get('BTC')?.currentPrice ?? null; },
  get balance()  { return walletState.balance; },
  get dailyPnL() { return walletState.dailyPnL; },
};
