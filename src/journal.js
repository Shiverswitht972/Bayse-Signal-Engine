/**
 * Trade Journal — Adaptive Learning Foundation
 *
 * Logs every executed trade with its full signal conditions, then tracks
 * win rates segmented by regime, session, and signal score. These win rates
 * feed back into signal.js to tighten or relax thresholds dynamically.
 *
 * Storage:
 *   Default: /tmp/trade_journal.json (ephemeral, resets on each deployment)
 *   Persistent: mount a Render Disk and set env JOURNAL_PATH=/data/trade_journal.json
 *
 * Outcome detection:
 *   Call logTrade() immediately after execution → returns a tradeId.
 *   Call updateOutcome(tradeId, { outcome, pnl }) when the market resolves.
 *   agent.js detects resolution via balance change on refreshEventContext().
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const JOURNAL_PATH = process.env.JOURNAL_PATH ?? '/tmp/trade_journal.json';

// ── In-memory index ───────────────────────────────────────────────────────────
const memory = {
  entries:       [],   // all logged entries (this session + loaded from disk)
  byRegime:      {},   // { TRENDING: { wins, total }, CHOPPY: ..., ... }
  bySession:     {},   // { LONDON: { wins, total }, NEW_YORK: ..., ... }
  byScoreBucket: {},   // { '8-9': { wins, total }, '6-7': ..., ... }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getScoreBucket(score) {
  if (score == null || score === undefined) return 'unknown';
  if (score >= 9) return '9+';
  if (score >= 8) return '8-9';
  if (score >= 7) return '7-8';
  if (score >= 6) return '6-7';
  return '<6';
}

function incrementBucket(store, key, won) {
  if (!store[key]) store[key] = { wins: 0, total: 0 };
  store[key].total += 1;
  if (won) store[key].wins += 1;
}

function indexEntry(entry) {
  if (!entry.outcome || entry.outcome === 'PENDING') return;
  const won = entry.outcome === 'WIN';
  incrementBucket(memory.byRegime,      entry.regime      ?? 'UNKNOWN', won);
  incrementBucket(memory.bySession,     entry.session     ?? 'UNKNOWN', won);
  incrementBucket(memory.byScoreBucket, getScoreBucket(entry.signalScore), won);
}

// ── Persistence ───────────────────────────────────────────────────────────────
function saveJournal() {
  try {
    writeFileSync(JOURNAL_PATH, JSON.stringify(memory.entries, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[journal] Save failed: ${err.message}`);
  }
}

function loadJournal() {
  if (!existsSync(JOURNAL_PATH)) {
    console.log(`[journal] No existing journal at ${JOURNAL_PATH} — starting fresh`);
    return;
  }
  try {
    const raw = readFileSync(JOURNAL_PATH, 'utf8');
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      memory.entries = entries;
      for (const entry of entries) {
        indexEntry(entry);
      }
      const resolved = entries.filter(e => e.outcome && e.outcome !== 'PENDING').length;
      console.log(`[journal] Loaded ${entries.length} entries (${resolved} resolved) from ${JOURNAL_PATH}`);
    }
  } catch (err) {
    console.warn(`[journal] Load failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log a new trade entry immediately after execution.
 *
 * @param {object} params
 * @param {object} params.signal    — the final signal object from generateSignal()
 * @param {object} params.state     — agent state at time of trade
 * @param {object} params.result    — executor result { success, orderId, ... }
 * @param {string} params.session   — session name (e.g. 'LONDON')
 * @param {number} params.signalScore — integer 0–10
 * @returns {string} tradeId — pass this to updateOutcome() when market resolves
 */
export function logTrade({ signal, state, result, session, signalScore }) {
  const tradeId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const entry = {
    id:            tradeId,
    timestamp:     new Date().toISOString(),
    eventId:       state.eventId ?? null,
    direction:     signal.direction,
    stake:         signal.stake,
    confidence:    Number((signal.confidence ?? 0).toFixed(4)),
    netEdge:       Number((signal.netEdge ?? 0).toFixed(4)),
    pUp:           Number((signal.pUp ?? 0).toFixed(4)),
    delta5m:       Number((signal.delta5m ?? 0).toFixed(4)),
    yesPrice:      state.yesPrice,
    regime:        signal.regime ?? state.lastRegime ?? 'UNKNOWN',
    session,
    signalScore,
    signalSource:  signal.decision?.source ?? 'base',
    balanceBefore: state.balance,
    orderId:       result.orderId ?? null,
    outcome:       'PENDING',
    pnl:           null,
  };

  memory.entries.push(entry);
  saveJournal();

  console.log(
    `[journal] Trade logged — id=${tradeId} dir=${entry.direction} ` +
    `score=${signalScore} session=${session} regime=${entry.regime} ` +
    `confidence=${entry.confidence}`,
  );

  return tradeId;
}

/**
 * Record the outcome of a previously logged trade.
 * Call this when the market resolves (detected via balance change on event refresh).
 *
 * @param {string} tradeId       — id returned by logTrade()
 * @param {object} params
 * @param {'WIN'|'LOSS'|'PUSH'} params.outcome
 * @param {number} params.pnl    — realised PnL in NGN (positive = profit)
 */
export function updateOutcome(tradeId, { outcome, pnl }) {
  const entry = memory.entries.find(e => e.id === tradeId);
  if (!entry) {
    console.warn(`[journal] updateOutcome: tradeId ${tradeId} not found`);
    return;
  }

  entry.outcome = outcome;
  entry.pnl     = pnl;

  indexEntry(entry);
  saveJournal();

  console.log(`[journal] Outcome recorded — id=${tradeId} outcome=${outcome} pnl=${pnl >= 0 ? '+' : ''}${pnl}`);
}

/**
 * Returns aggregated win-rate statistics for adaptive threshold adjustments.
 * signal.js calls this before finalising the threshold.
 *
 * @returns {object} stats
 */
export function getWinRates() {
  const resolved = memory.entries.filter(
    e => e.outcome === 'WIN' || e.outcome === 'LOSS',
  );

  const overallWinRate = resolved.length === 0
    ? null
    : resolved.filter(e => e.outcome === 'WIN').length / resolved.length;

  return {
    byRegime:      memory.byRegime,
    bySession:     memory.bySession,
    byScoreBucket: memory.byScoreBucket,
    totalResolved: resolved.length,
    overallWinRate,
  };
}

/**
 * Returns the last N pending trade IDs (awaiting outcome resolution).
 * agent.js uses this to call updateOutcome() when a new event is detected.
 */
export function getPendingTrades() {
  return memory.entries.filter(e => e.outcome === 'PENDING');
}

// Load on module initialisation
loadJournal();
