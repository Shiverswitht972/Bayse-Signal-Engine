import { BASE_URL, buildWriteHeaders } from './auth.js';
import { CURRENCY } from './config.js';

async function postSigned(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
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
    const pathBase = `/v1/pm/events/${state.eventId}/markets/${state.marketId}`;
    const payload = {
      side: 'BUY',
      outcome: signal.direction,
      amount: signal.stake,
      currency: CURRENCY,
    };

    const quote = await postSigned(`${pathBase}/quote`, payload);

    if (!quote.completeFill) {
      const reason = 'Quote not fully fillable; skipping order';
      console.log(`[executor] ${reason}`);
      return { success: false, reason };
    }

    const order = await postSigned(`${pathBase}/orders`, payload);

    state.lastTradeAt = new Date().toISOString();

    return {
      success: true,
      orderId: order.id ?? order.orderId ?? null,
      fillPrice: order.fillPrice ?? quote.price ?? null,
      shares: order.shares ?? quote.shares ?? null,
      fee: order.fee ?? quote.fee ?? null,
      status: order.status ?? 'filled',
    };
  } catch (error) {
    console.error('[executor] Order execution failed:', error.message);
    return {
      success: false,
      reason: error.message,
    };
  }
}
