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
import { startChainlinkFeed } from './chainlink.js';

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
  if (!ms.eventId || !ms.marketId) {
    return 'No confirmed event/market ID — between windows or wrong market type';
  }

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
// Fetches all open crypto events and finds the one for this market by title.
// Same proven approach the original BTC engine used — category+title search.
async function refreshEventContext(ms) {
  const payload = await fetchJson('/v1/pm/events?category=crypto&status=open');

  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.events)
      ? payload.events
      : Array.isArray(payload)
        ? payload
        : [];

  const sym = ms.symbol.toUpperCase();

  // Strict match ONLY — must contain symbol AND both UP and DOWN.
  // No fallback: if the 15-min UP/DOWN window is not open, throw and retry.
  // A loose fallback previously caused the agent to trade "BTC to outperform
  // Gold" between windows, which is a completely different market type.
  const event = list.find(e => {
    const t = String(e.title ?? e.name ?? '').toUpperCase();
    return t.includes(sym) && t.includes('UP') && t.includes('DOWN');
  });

  if (!event) {
    // Clear stale IDs so no trade can fire against a previous window's event
    ms.eventId  = null;
    ms.marketId = null;
    ms.yesPrice = null;
    ms.noPrice  = null;
    throw new Error(`No open UP/DOWN event for ${ms.symbol} — between windows, will retry`);
  }

  const market  = event.market ?? event.markets?.[0] ?? {};
  const eventId = event.id ?? event.eventId;

  // Read the authoritative opening price (the "line") directly from the API.
  // For ETH/SOL/BNB this is the Chainlink price at window open — NOT our
  // Binance feed. Using our Binance current price as a proxy was wrong:
  // dead zone and direction tracking were both comparing against the wrong line.
  // eventThreshold (event level) and marketThreshold (market level) are the
  // canonical fields — confirmed in Bayse API docs response schema.
  const thresholdFromApi =
    Number(event.eventThreshold ?? market.marketThreshold ?? NaN);

  if (eventId !== ms.previousEventId) {
    ms.previousEventId = eventId;
    // Prefer the API threshold; fall back to current Binance price only if absent
    ms.openingPrice = Number.isFinite(thresholdFromApi)
      ? thresholdFromApi
      : ms.currentPrice;
    console.log(
      `[${ms.symbol}] New window — line: ${ms.openingPrice} ` +
      `(source: ${Number.isFinite(thresholdFromApi) ? 'eventThreshold' : 'binance-fallback'})`
    );
  }

  ms.eventId    = eventId;
  ms.marketId   = market.id ?? market.marketId;
  ms.eventTitle = event.title ?? event.name ?? `${ms.name} UP/DOWN`;
  ms.resolvesAt = event.resolvesAt ?? event.endTime ?? event.closeTime ?? null;

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

    // Sync marketId from live response — corrects any bad value from event init (fixes SOL 404)
    if (market.id) ms.marketId = market.id;

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
      // Bayse WS sends NDJSON (newline-delimited JSON) when multiple symbols
      // are subscribed — each symbol's update is a separate JSON object on its
      // own line within a single frame. Split and parse each line individually.
      const lines = String(raw).split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          await handlers.onMessage(message);
        } catch (err) {
          console.error(`[ws:${name}] message parse error:`, err.message);
        }
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

  // ── Bayse WS — BTC price feed only ──────────────────────────────────────
  // ETH, SOL, BNB have moved to Chainlink onchain feeds below.
  // BTC remains on the Bayse WS (sourced from Binance).
  createReconnectableWs(
    'bayse-prices',
    'wss://socket.bayse.markets/ws/v1/realtime',
    {
      onOpen: async (socket) => {
        socket.send(JSON.stringify({
          type: 'subscribe',
          channel: 'asset_prices',
          symbols: ['BTCUSDT'],
        }));
        console.log('[ws:bayse-prices] Subscribed: BTCUSDT');
      },
      onMessage: async (message) => {
        if (message.type !== 'asset_price') return;

        const sym = message.data?.symbol;
        if (sym !== 'BTCUSDT') return;

        const ms = marketStates.get('BTC');
        if (!ms) return;

        addPriceTick(ms, message.data ?? message);

        if (ms.yesPrice != null) {
          await evaluateAndMaybeTrade(ms);
        }
      },
    },
  );

  // ── Chainlink onchain feeds — ETH, SOL, BNB price feed ───────────────────
  // Polls Chainlink AggregatorV3 contracts on Ethereum mainnet every 2s.
  // Fires on new rounds only (round-ID change detection).
  // Falls through a public RPC fallback chain on provider errors.
  const chainlinkFeeds = MARKETS
    .filter(m => m.priceSource === 'chainlink' && m.chainlinkAddress)
    .map(m => ({ symbol: m.symbol, address: m.chainlinkAddress }));

  startChainlinkFeed(chainlinkFeeds, async (symbol, price, timestamp) => {
    const ms = marketStates.get(symbol);
    if (!ms) return;

    addPriceTick(ms, { price, timestamp });

    if (ms.yesPrice != null) {
      await evaluateAndMaybeTrade(ms);
    }
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────
export { walletState, marketStates };

// Legacy single-market state alias (BTC) — keeps any external consumers working
export const state = {
  get btcPrice() { return marketStates.get('BTC')?.currentPrice ?? null; },
  get balance()  { return walletState.balance; },
  get dailyPnL() { return walletState.dailyPnL; },
};
