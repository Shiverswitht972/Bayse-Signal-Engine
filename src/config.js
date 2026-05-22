// ── Core trading parameters ───────────────────────────────────────────────────
export const MAX_STAKE_NGN = 6500;
export const DAILY_LOSS_FLOOR = 500;
export const KELLY_FRACTION = 0.5;
export const MIN_STAKE_NGN = 150;
export const CURRENCY = 'NGN';
export const MINUTES_BETWEEN_TRADES = 15;
export const MARKET_END_BUFFER_MINUTES = 3;
export const BALANCE_REFRESH_MS = 5 * 60 * 1000;
export const WS_BACKOFF_START_MS = 2_000;
export const WS_BACKOFF_MAX_MS = 30_000;

// ── Alpha module ──────────────────────────────────────────────────────────────
export const ALPHA_ENABLED = true;
export const MIN_VOL_THRESHOLD = 0.0005;       // shared by signal.js AND alpha.js
export const ALPHA_MIN_STRENGTH = 0.1;
export const ALPHA_EARLY_OVERRIDE_STRENGTH = 0.2;
export const ALPHA_EARLY_MINUTE = 5;
export const ALPHA_LATE_MINUTE = 12;

// ── Data requirements ─────────────────────────────────────────────────────────
// MIN_HISTORY_POINTS: 20 ticks (~several minutes of WebSocket data) before any
// evaluation runs. Binance candles are the primary source; this is a safety floor.
export const MIN_HISTORY_POINTS = 20;

// REGIME_CANDLE_LIMIT: 1m Binance candles for regime + indicator calculations.
// RSI needs 14+, MACD needs 35+, regime needs 30+, Bollinger needs 20+.
// 100 candles = ~1.5 hours of context, comfortable headroom for all three.
export const REGIME_CANDLE_LIMIT = 100;

// HTF_CANDLE_LIMIT: 15m Binance candles for higher-timeframe bias check.
// 50 candles = ~12.5 hours, enough to establish a reliable EMA trend.
export const HTF_CANDLE_LIMIT = 50;

// ── Signal scoring ────────────────────────────────────────────────────────────
// Signals are scored 0–10 based on how many independent factors confirm the trade.
// Trades scoring below SIGNAL_SCORE_MIN are blocked regardless of composite score.
// Raise this to require more confluence; lower it to allow more trades.
export const SIGNAL_SCORE_MIN = 6;

// ── Indicator parameters ──────────────────────────────────────────────────────
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STD_DEVS = 2;
export const ADX_PERIOD = 14;

// ── Session awareness ─────────────────────────────────────────────────────────
// When true, signal thresholds are multiplied by the session's risk multiplier.
// London/NY sessions → lower multiplier (easier to fire).
// Asian/Off sessions → higher multiplier (harder to fire).
export const SESSION_AWARENESS_ENABLED = true;

// ── Trade journal ─────────────────────────────────────────────────────────────
// When true, every executed trade is written to JOURNAL_PATH.
// The journal feeds the adaptive threshold system.
// Note: Render workers use ephemeral storage unless a Disk is mounted.
// Mount a Render Disk at /data and set JOURNAL_PATH=/data/trade_journal.json
// for persistence across deployments.
export const TRADE_JOURNAL_ENABLED = true;
