import WebSocket from 'ws';
import { BASE_URL, buildReadHeaders } from './auth.js';
import { generateSignal } from './signal.js';
import { executeOrder, closePosition } from './executor.js';
import { sendNotification } from './notify.js';
import { isInExpiryDeadZone } from './utils/expiryDeadZone.js';
import { logTrade, updateOutcome, getPendingTrades } from './journal.js';
import { startForecaster, getLatestForecast, isForecastFresh, triggerImmediateForecast } from './forecaster.js';
import { evaluateExit } from './monitor.js';
import {
  BALANCE_REFRESH_MS,
  CURRENCY,
  DAILY_LOSS_FLOOR,
  MARKET_END_BUFFER_MINUTES,
  MIN_HISTORY_POINTS,
  MINUTES_BETWEEN_TRADES,
  TRADE_JOURNAL_ENABLED,
  WS_BACKOFF_MAX_MS,
  WS_BACKOFF_START_MS,
} from './config.js';

const ODDS_REFRESH_MS = 30_000;

const state = {
  btcPrice:            null,
  priceHistory:        [],
  yesPrice:            null,
  noPrice:             null,
  yesOutcomeId:        null,
  noOutcomeId:         null,
  outcome1Id:          null,
  outcome2Id:          null,
  eventId:             null,
  marketId:            null,
  eventTitle:          null,
  resolvesAt:          null,
  openingPrice:        null,
  balance:             null,
  lastTradeAt:         null,
  dailyPnL:            0,
  dailyPnLResetDate:   null,
  dayStartBalance:     null,
  // ── New fields ──────────────────────────────────────────────────────────────
  lastRegime:          null,   // last known regime string, used by journal
  lastTradeBalancePre: null,   // balance immediately before the last trade
  lastTradeId:         null,   // journal id of the last trade, for outcome tracking
  windowOpenTime:      null,   // ISO timestamp when the current market window opened
  openPosition:        null,   // { direction, outcomeId, entryYesPrice, entryNoPrice, entryTime, stake, shares }
};

export { getCandles } from './candles.js';

let isEvaluatingSignal  = false;
let pendingEvaluation   = false;
let previousEventId     = null;
let monitorTickCount    = 0;   // throttle: evaluate position every N ticks

function resetDailyPnlIfNeeded() {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (state.dailyPnLResetDate !== utcDate) {
    state.dailyPnL          = 0;
    state.dailyPnLResetDate = utcDate;
    state.dayStartBalance   = state.balance;
    console.log(`[agent] Daily PnL reset for UTC date ${utcDate}`);
  }
}

function minutesUntilResolution() {
  if (!state.resolvesAt) return Number.POSITIVE_INFINITY;
  const msLeft = new Date(state.resolvesAt).getTime() - Date.now();
  return msLeft / 60000;
}

function shouldSkipEvaluation() {
  if (state.yesPrice !== null && (state.yesPrice < 0.18 || state.yesPrice > 0.75)) {
    // Fire an immediate forecast using the one-sided yesPrice as crowd-signal context.
    // This runs async (fire-and-forget) so it's ready before the next window opens.
    // The crowd's over-commitment is the most useful input for next-window direction.
    triggerImmediateForecast(state.yesPrice).catch(() => {});

    // Allow evaluation if a fresh, confident forecast disagrees with the crowd pricing.
    // A market at 0.78 YES forecasted DOWN = contrarian edge on the NO side.
    // A market at 0.15 YES forecasted UP   = contrarian edge on the YES side.
    if (isForecastFresh(5 * 60_000)) {
      const forecast   = getLatestForecast();
      const marketBias = state.yesPrice > 0.75 ? 'UP' : 'DOWN';
      if (
        forecast.direction !== 'NEUTRAL' &&
        forecast.direction !== marketBias &&
        forecast.confidence > 0.55
      ) {
        console.log(
          `[agent] One-sided market (yesPrice=${state.yesPrice.toFixed(2)}) but ` +
          `forecast DISAGREES (${forecast.direction} conf=${forecast.confidence.toFixed(2)}) ` +
          `— allowing contrarian evaluation`,
        );
        // fall through — do not return a skip reason
      } else {
        return `Market too one-sided (yesPrice=${state.yesPrice?.toFixed(2)}) — skipping`;
      }
    } else {
      return `Market too one-sided (yesPrice=${state.yesPrice?.toFixed(2)}) — skipping`;
    }
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
      state.openingPrice,
    )) {
      const secsLeft   = Math.round((new Date(state.resolvesAt).getTime() - Date.now()) / 1000);
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
  const list   = Array.isArray(events) ? events : [];

  const btcEvent =
    list.find((event) => {
      const title = String(event.title ?? event.name ?? '').toUpperCase();
      return title.includes('UP') && title.includes('DOWN') && title.includes('BTC');
    }) ??
    list.find((event) => {
      const title = String(event.title ?? event.name ?? '').toUpperCase();
      return title.includes('BITCOIN') && (title.includes('UP') || title.includes('DOWN'));
    });

  if (!btcEvent) throw new Error('No open BTC UP/DOWN event found');

  const market = btcEvent.market ?? btcEvent.markets?.[0] ?? {};

  return {
    eventId:    btcEvent.id ?? btcEvent.eventId,
    marketId:   market.id ?? market.marketId,
    eventTitle: btcEvent.title ?? btcEvent.name ?? 'BTC market',
    resolvesAt: btcEvent.resolvesAt ?? btcEvent.endTime ?? btcEvent.closeTime ?? null,
  };
}

/**
 * When a new market window is detected, attempt to resolve outcomes for any
 * trades that were placed in the previous window.
 *
 * Resolution logic: compare current balance against the pre-trade balance.
 * If balance is higher → WIN; lower → LOSS. This is approximate but correct
 * in the vast majority of cases where only one trade fired per window.
 */
function resolveOutcomesFromBalanceChange() {
  if (!TRADE_JOURNAL_ENABLED) return;

  const pending = getPendingTrades();
  if (pending.length === 0) return;

  const currentBalance = state.balance;
  if (currentBalance == null) return;

  for (const trade of pending) {
    const balanceBefore = trade.balanceBefore;
    if (balanceBefore == null) continue;

    const diff = currentBalance - balanceBefore;
    let outcome;

    if (Math.abs(diff) < 10) {
      outcome = 'PUSH'; // tiny difference, likely timing artefact
    } else {
      outcome = diff > 0 ? 'WIN' : 'LOSS';
    }

    updateOutcome(trade.id, { outcome, pnl: Number(diff.toFixed(2)) });
  }
}

async function refreshEventContext() {
  const payload      = await fetchJson('/v1/pm/events?category=crypto&status=open');
  const eventContext = parseOpenBtcEvent(payload);

  if (eventContext.eventId !== previousEventId) {
    state.openingPrice   = state.btcPrice;
    state.windowOpenTime = new Date().toISOString();
    previousEventId      = eventContext.eventId;

    // Previous window has resolved — clear the position tracker
    if (state.openPosition) {
      console.log(
        `[agent] Window resolved — clearing open position ` +
        `(direction=${state.openPosition.direction}, was monitoring)`,
      );
      state.openPosition = null;
      monitorTickCount   = 0;
    }

    console.log(
      `[agent] New market window detected — opening price: $${state.openingPrice} ` +
      `windowOpenTime: ${state.windowOpenTime}`,
    );

    // Resolve outcomes from the previous window
    resolveOutcomesFromBalanceChange();
  }

  state.eventId    = eventContext.eventId;
  state.marketId   = eventContext.marketId;
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
    const data     = await fetchJson('/v1/wallet/assets');
    const assets   = data?.assets ?? [];
    const ngnAsset = assets.find(a => a.symbol === 'NGN');
    const balance  = ngnAsset ? Number(ngnAsset.availableBalance) : null;

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

    console.log(
      `[agent] Balance: ${state.balance ?? 'unavailable'} ${CURRENCY} | dailyPnL=${state.dailyPnL}`,
    );
  } catch (error) {
    console.error('[agent] Balance refresh failed:', error.message);
  }
}

async function refreshOdds() {
  try {
    const payload = await fetchJson(`/v1/pm/events/${state.eventId}?currency=NGN`);
    const markets = payload?.markets ?? payload?.data?.markets ?? [];
    const market  = markets.find(m => m.id === state.marketId) ?? markets[0];

    if (!market) {
      console.log('[odds] No matching market found in event response');
      return;
    }

    const yes = Number(market.outcome1Price ?? market.prices?.YES ?? market.prices?.yes);
    const no  = Number(market.outcome2Price ?? market.prices?.NO  ?? market.prices?.no);

    if (Number.isFinite(yes) && yes > 0) state.yesPrice = yes;
    if (Number.isFinite(no)  && no  > 0) state.noPrice  = no;

    if (yes === 0 && no === 0) {
      console.log('[odds] Market window closed, refreshing event context...');
      state.yesPrice = null;
      state.noPrice  = null;
      try {
        await refreshEventContext();
      } catch (err) {
        console.log('[odds] No new market window open yet, will retry in 30s');
      }
      return;
    }

    if (market.outcome1Id) {
      state.outcome1Id  = market.outcome1Id;
      state.yesOutcomeId = market.outcome1Id;
    }
    if (market.outcome2Id) {
      state.outcome2Id  = market.outcome2Id;
      state.noOutcomeId  = market.outcome2Id;
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

      const forecastBias = isForecastFresh(5 * 60_000) ? getLatestForecast() : null;
      const signal = await generateSignal(state, forecastBias);

      // Track last known regime for journal fallback
      if (signal.regime) {
        state.lastRegime = signal.regime;
      }

      if (!signal.shouldTrade) {
        console.log(`[signal] no trade: ${signal.reason}`);
        continue;
      }

      // Lock out further attempts immediately, before execution
      state.lastTradeAt         = new Date().toISOString();
      state.lastTradeBalancePre = state.balance;

      const result = await executeOrder(signal, state);

      if (!result.success && result.reason?.includes('no liquidity')) {
        console.log('[executor] No liquidity — skipping notification');
        continue;
      }

      // Track the open position for mid-trade monitoring
      if (result.success) {
        state.openPosition = {
          direction:     signal.direction,
          outcomeId:     signal.outcomeId,
          entryYesPrice: state.yesPrice,
          entryNoPrice:  state.noPrice,
          entryTime:     new Date().toISOString(),
          stake:         signal.stake,
          shares:        result.shares ?? null,
        };
        monitorTickCount = 0;
        console.log(
          `[monitor] Position opened — direction=${signal.direction} ` +
          `entryYesPrice=${state.yesPrice} shares=${result.shares ?? 'unknown'}`,
        );
      }

      // Log to journal
      if (TRADE_JOURNAL_ENABLED && result.success) {
        state.lastTradeId = logTrade({
          signal,
          state,
          result,
          session:     signal.session,
          signalScore: signal.signalScore,
        });
      }

      await sendNotification(signal, result, state);
    } while (pendingEvaluation);
  } finally {
    isEvaluatingSignal = false;
  }
}

/**
 * Evaluates the open position and exits if monitor says so.
 * Called on every 15th price tick while a position is open.
 * Fire-and-forget from addPriceTick — errors are caught internally.
 */
async function evaluateOpenPosition() {
  if (!state.openPosition) return;

  const assessment = evaluateExit(state);

  console.log(
    `[monitor] ${assessment.action} — ${assessment.reason} ` +
    `(adverse=${assessment.adversePct.toFixed(1)}%)`,
  );

  if (assessment.action !== 'EXIT') return;

  // ── Attempt to close position via SELL order ────────────────────────────────
  const pos    = state.openPosition;
  const result = await closePosition(pos, state);

  if (result.success) {
    console.log(
      `[monitor] Position CLOSED — orderId=${result.orderId} ` +
      `exitYesPrice=${result.exitYesPrice} proceeds=${result.proceeds}`,
    );
    state.openPosition = null;
    monitorTickCount   = 0;
  } else {
    // SELL not supported or failed — log and alert via Telegram, don't crash
    console.warn(`[monitor] SELL failed (${result.reason}) — sending alert, holding position`);
  }

  // Send Telegram alert regardless of whether the SELL succeeded
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const exitStatus = result.success ? '✅ Position SOLD' : `⚠️ EXIT SIGNAL — SELL failed (${result.reason})`;
    const text = [
      `🔴 Monitor Exit — ${pos.direction} position`,
      `───────────────────────`,
      `Reason   : ${assessment.reason}`,
      `Adverse  : ${assessment.adversePct.toFixed(1)}%`,
      `Entry    : yesPrice=${pos.entryYesPrice?.toFixed(3)}`,
      `Current  : yesPrice=${state.yesPrice?.toFixed(3)}`,
      `BTC      : $${state.btcPrice}`,
      `Status   : ${exitStatus}`,
      result.success ? `Proceeds : ${result.proceeds ?? 'n/a'}` : `Manual action may be required`,
    ].join('\n');

    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {});
  }
}

function addPriceTick(tick) {
  const price = Number(tick.price ?? tick.lastPrice ?? tick.value);
  if (!Number.isFinite(price)) return;

  const timestamp = tick.timestamp ?? tick.ts ?? new Date().toISOString();

  state.btcPrice = price;

  const cutoff = Date.now() - 60 * 60 * 1000;
  state.priceHistory = state.priceHistory.filter(
    t => new Date(t.timestamp).getTime() > cutoff,
  );

  state.priceHistory.push({ price, timestamp, volume: Number(tick.volume ?? 1) });

  // Throttled position monitoring — evaluate every 15 ticks (~15–30 seconds)
  if (state.openPosition) {
    monitorTickCount++;
    if (monitorTickCount % 15 === 0) {
      evaluateOpenPosition().catch(err =>
        console.error('[monitor] Evaluation error:', err.message),
      );
    }
  }
}

function createReconnectableWs(name, url, handlers) {
  let socket   = null;
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

  await startForecaster();
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
        type:    'subscribe',
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
