export async function sendNotification(signal, result, state) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[notify] Telegram credentials not configured; skipping message.');
    return;
  }

  const status = result.success ? 'filled' : 'failed';
  const orderId = result.orderId ?? 'n/a';

  const text = [
    'Bayse Signal Engine',
    '───────────────────',
    `Market : ${state.eventTitle ?? 'BTC 15-min UP/DOWN'}`,
    `YES    : ${state.yesPrice ?? 'n/a'}  NO: ${state.noPrice ?? 'n/a'}`,
    `BTC    : $${state.btcPrice ?? 'n/a'}`,
    `D5m    : ${(signal.delta5m ?? 0).toFixed(3)}%`,
    '',
    'Analysis',
    `P(up)  : ${Number(signal.pUp ?? 0).toFixed(4)}`,
    `Edge   : ${Number(signal.netEdge ?? 0).toFixed(4)}`,
    `Conf   : ${Number(signal.confidence ?? 0).toFixed(4)}`,
    `Signal : BUY ${signal.direction ?? 'NONE'}`,
    `Source : ${signal.decision?.source ?? 'base'}`,
    '',
    'Execution',
    `Stake  : N${Number(signal.stake ?? 0).toFixed(2)}`,
    `Status : ${status}`,
    `Order  : ${orderId}`,
    '',
    `Daily PnL : N${Number(state.dailyPnL ?? 0).toFixed(2)}`,
    `Balance   : N${Number(state.balance ?? 0).toFixed(2)}`,
  ].join('\n');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[notify] Telegram send failed (${response.status}): ${errText}`);
  }
}
