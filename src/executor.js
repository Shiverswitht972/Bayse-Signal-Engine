import { BASE_URL, buildWriteHeaders } from './auth.js';
import { CURRENCY } from './config.js';

function resolveOutcomeId(signal, state) {
  if (signal.direction === 'YES') return state.yesOutcomeId;
  if (signal.direction === 'NO') return state.noOutcomeId;
  return null;
}

async function postSigned(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const response = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: buildWriteHeaders('POST', path, body),
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

export async function executeOrder(signal, state) {
  try {
    const pathBase  = `/v1/pm/events/${state.eventId}/markets/${state.marketId}`;
    const outcomeId = resolveOutcomeId(signal, state);

    if (!outcomeId) {
      return { success: false, reason: `Missing outcomeId for direction ${signal.direction}` };
    }

    const payload = {
      type:      'MARKET',
      side:      'BUY',
      outcomeId,
      amount:    signal.stake,
      currency:  CURRENCY,
    };

    const quote = await postSigned(`${pathBase}/quote`, payload);

    if (!quote.completeFill) {
      const reason = 'Quote not fully fillable; skipping order';
      console.log(`[executor] ${reason}`);
      return { success: false, reason };
    }

    const order = await postSigned(`${pathBase}/orders`, payload);

    state.lastTradeAt = new Date().toISOString();

    const orderId = order.id ?? order.orderId ?? order.data?.id ?? null;
    const shares  = order.shares ?? order.data?.shares ?? quote.shares ?? null;

    console.log(
      `[executor] BUY placed — id=${orderId} direction=${signal.direction} ` +
      `stake=${signal.stake} shares=${shares} status=${order.status ?? 'filled'}`,
    );

    return {
      success:   true,
      orderId,
      shares,
      fillPrice: order.fillPrice ?? order.data?.fillPrice ?? quote.price ?? null,
      fee:       order.fee       ?? order.data?.fee       ?? quote.fee   ?? null,
      status:    order.status    ?? order.data?.status    ?? 'filled',
    };
  } catch (error) {
    console.error('[executor] Order execution failed:', error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * Closes an open position by selling tokens back to the AMM.
 *
 * Uses side: 'SELL' on the same orders endpoint as BUY.
 * Amount is in shares (tokens held), not NGN — sourced from the original buy fill.
 *
 * If Bayse does not support SELL orders, this will return success: false with
 * the API error reason. The caller should degrade gracefully to Telegram alert only.
 *
 * @param {object} pos   — state.openPosition
 * @param {object} state — full agent state
 */
export async function closePosition(pos, state) {
  try {
    if (!pos) throw new Error('No open position provided');
    if (!pos.shares || pos.shares <= 0) {
      throw new Error(
        `Cannot sell — shares from original fill unknown (shares=${pos.shares}). ` +
        `Bayse may not have returned share count on the original order.`,
      );
    }

    const pathBase = `/v1/pm/events/${state.eventId}/markets/${state.marketId}`;

    const payload = {
      type:      'MARKET',
      side:      'SELL',
      outcomeId: pos.outcomeId,
      amount:    pos.shares,   // selling in share units, not NGN
      currency:  CURRENCY,
    };

    // Get a sell quote first to confirm liquidity exists
    const quote = await postSigned(`${pathBase}/quote`, payload);
    if (!quote.completeFill) {
      console.warn('[executor] Sell quote not fully fillable — partial close or illiquid market');
    }

    const order    = await postSigned(`${pathBase}/orders`, payload);
    const orderId  = order.id ?? order.orderId ?? order.data?.id ?? null;
    const proceeds = order.proceeds ?? order.data?.proceeds ?? order.fillAmount ?? null;

    console.log(
      `[executor] SELL placed — id=${orderId} direction=${pos.direction} ` +
      `shares=${pos.shares} proceeds=${proceeds} status=${order.status ?? 'filled'}`,
    );

    return {
      success:      true,
      orderId,
      proceeds,
      exitYesPrice: state.yesPrice,
      status:       order.status ?? order.data?.status ?? 'filled',
    };
  } catch (error) {
    console.error('[executor] closePosition failed:', error.message);
    return {
      success: false,
      reason:  error.message,
    };
  }
}
