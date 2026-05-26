/**
 * Position Monitor — Mid-Trade Exit Intelligence
 *
 * Called on every Nth price tick while an open position exists.
 * Answers one question: should we hold or exit right now?
 *
 * The distinction between a spike and a sustained move is the core logic here.
 * A spike (pump that's decelerating) should be held through — the original
 * thesis is still intact and exiting captures maximum loss at the worst moment.
 * A sustained reversal (accelerating momentum against position) should be cut.
 *
 * Decision framework:
 *
 *   adverseMove < 15%               → HOLD (within normal noise, no action)
 *   adverseMove ≥ 40%               → EXIT (hard stop, too far gone regardless)
 *   adverseMove 15–40% + accel      → EXIT (sustained move, thesis invalidated)
 *   adverseMove 15–40% + decel      → HOLD (spike, expect partial reversal)
 *   adverseMove 15–40% + near expiry → EXIT (< 3 min left, cut losses)
 *   position age < 2 min            → HOLD (too early, give it room to breathe)
 *
 * Read-only: takes state as input, never modifies it.
 */

const HARD_STOP_PCT        = 0.40;  // always exit if adverse move ≥ 40% of max space
const SMART_EXIT_PCT       = 0.25;  // exit if adverse ≥ 25% AND momentum accelerating against
const EVALUATION_MIN_PCT   = 0.15;  // don't bother evaluating below 15% adverse
const MIN_POSITION_AGE_MS  = 2 * 60_000;   // 2 minutes — don't exit immediately after entry
const NEAR_EXPIRY_MINUTES  = 3;            // exit if adverse + less than 3 min left
const NEAR_EXPIRY_MIN_PCT  = 0.20;         // threshold for near-expiry exit

/**
 * Computes how far the position has moved against us, normalised to 0–1.
 * 0 = no adverse move. 1 = maximum possible loss (token worth zero).
 *
 * For a NO position: we lose as yesPrice rises (toward 1.0)
 * For a YES position: we lose as yesPrice falls (toward 0.0)
 */
function computeAdverseMove(pos, currentYesPrice) {
  const isNo = pos.direction === 'NO';

  const rawAdverse = isNo
    ? currentYesPrice - pos.entryYesPrice      // YES rising hurts NO
    : pos.entryYesPrice - currentYesPrice;     // YES falling hurts YES

  const maxAdverse = isNo
    ? 1 - pos.entryYesPrice                   // worst case: yesPrice reaches 1.0
    : pos.entryYesPrice;                       // worst case: yesPrice reaches 0.0

  if (maxAdverse <= 0) return 0;
  return Math.max(rawAdverse / maxAdverse, 0);
}

/**
 * Checks whether BTC price momentum is accelerating or decelerating
 * in the direction that hurts the open position.
 *
 * Uses the last 12 ticks from priceHistory, split into two halves.
 * If the second half's rate-of-change exceeds the first → accelerating.
 * If the second half's rate-of-change is slower than the first → decelerating (spike).
 *
 * Returns: 'ACCELERATING' | 'DECELERATING' | 'FLAT'
 */
function checkMomentumDirection(pos, priceHistory) {
  if (priceHistory.length < 8) return 'FLAT';

  const ticks      = priceHistory.slice(-12);
  const half       = Math.floor(ticks.length / 2);
  const firstHalf  = ticks.slice(0, half);
  const secondHalf = ticks.slice(half);

  if (firstHalf.length < 2 || secondHalf.length < 2) return 'FLAT';

  const rocFirst  = firstHalf[0].price > 0
    ? (firstHalf.at(-1).price  - firstHalf[0].price)  / firstHalf[0].price
    : 0;
  const rocSecond = secondHalf[0].price > 0
    ? (secondHalf.at(-1).price - secondHalf[0].price) / secondHalf[0].price
    : 0;

  const isNo = pos.direction === 'NO';

  // For NO position: adverse move is BTC pumping (positive ROC hurts us)
  // Accelerating = second-half ROC more positive than first-half ROC
  // Decelerating = second-half ROC less positive (pump losing steam)
  const adverseRoc   = isNo ? rocSecond  : -rocSecond;
  const adverseRocP  = isNo ? rocFirst   : -rocFirst;

  const diff = adverseRoc - adverseRocP;

  if (diff >  0.0002) return 'ACCELERATING';
  if (diff < -0.0002) return 'DECELERATING';
  return 'FLAT';
}

/**
 * Main evaluation function.
 * Call this on a throttled basis (every 15 price ticks recommended).
 *
 * @param {object} state — full agent state
 * @returns {{ action: 'HOLD'|'EXIT', reason: string, adversePct: number, urgency: number }}
 */
export function evaluateExit(state) {
  const pos = state.openPosition;

  if (!pos) {
    return { action: 'HOLD', reason: 'No open position', adversePct: 0, urgency: 0 };
  }

  const currentYesPrice = state.yesPrice;
  if (currentYesPrice == null) {
    return { action: 'HOLD', reason: 'yesPrice unavailable', adversePct: 0, urgency: 0 };
  }

  // Guard: don't exit in the first 2 minutes — give the trade room to breathe
  const posAgeMs = Date.now() - new Date(pos.entryTime).getTime();
  if (posAgeMs < MIN_POSITION_AGE_MS) {
    return {
      action:     'HOLD',
      reason:     `Position too young (${(posAgeMs / 1000).toFixed(0)}s) — waiting ${(MIN_POSITION_AGE_MS / 1000)}s before monitoring`,
      adversePct: 0,
      urgency:    0,
    };
  }

  const adverseNorm = computeAdverseMove(pos, currentYesPrice);
  const adversePct  = adverseNorm * 100;

  // ── Hard stop ──────────────────────────────────────────────────────────────
  if (adverseNorm >= HARD_STOP_PCT) {
    return {
      action:     'EXIT',
      reason:     `Hard stop — position ${adversePct.toFixed(1)}% adverse (≥ ${HARD_STOP_PCT * 100}% threshold). Thesis invalidated.`,
      adversePct,
      urgency:    1.0,
    };
  }

  // ── Below evaluation threshold — hold without checking momentum ────────────
  if (adverseNorm < EVALUATION_MIN_PCT) {
    return {
      action:     'HOLD',
      reason:     `Within tolerance — ${adversePct.toFixed(1)}% adverse (< ${EVALUATION_MIN_PCT * 100}% threshold)`,
      adversePct,
      urgency:    0,
    };
  }

  // ── Near-expiry exit — cut losses if running out of time ──────────────────
  const msLeft      = state.resolvesAt
    ? new Date(state.resolvesAt).getTime() - Date.now()
    : Number.POSITIVE_INFINITY;
  const minutesLeft = msLeft / 60_000;

  if (adverseNorm >= NEAR_EXPIRY_MIN_PCT && minutesLeft < NEAR_EXPIRY_MINUTES) {
    return {
      action:     'EXIT',
      reason:     `Near-expiry cut — ${adversePct.toFixed(1)}% adverse with only ${minutesLeft.toFixed(1)} min remaining`,
      adversePct,
      urgency:    0.85,
    };
  }

  // ── Momentum check ─────────────────────────────────────────────────────────
  const momentum = checkMomentumDirection(pos, state.priceHistory);

  if (adverseNorm >= SMART_EXIT_PCT && momentum === 'ACCELERATING') {
    return {
      action:     'EXIT',
      reason:     `Smart exit — ${adversePct.toFixed(1)}% adverse with accelerating momentum against position. Not a spike.`,
      adversePct,
      urgency:    adverseNorm,
    };
  }

  if (momentum === 'DECELERATING') {
    return {
      action:     'HOLD',
      reason:     `Holding spike — ${adversePct.toFixed(1)}% adverse but momentum decelerating. Likely temporary, thesis intact.`,
      adversePct,
      urgency:    0,
    };
  }

  // ── Default: monitor but hold ──────────────────────────────────────────────
  return {
    action:     'HOLD',
    reason:     `Monitoring — ${adversePct.toFixed(1)}% adverse, momentum ${momentum}. Watching.`,
    adversePct,
    urgency:    adverseNorm * 0.5,
  };
}
