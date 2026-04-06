import {
  fetchBTCPrice,
  fetchBTCKlines,
  fetchBalance,
  fetchCryptoMarket,
} from './perception.js';
import { normalizeState } from './normalize.js';
import { generateSignal } from './signal.js';

async function main() {
  try {
    console.log('📡 Fetching market, portfolio, and BTC inputs...');

    const [market, balance, btcPrice, klines] = await Promise.all([
      fetchCryptoMarket(),
      fetchBalance(),
      fetchBTCPrice(),
      fetchBTCKlines(),
    ]);

    const state = normalizeState({ market, balance, btcPrice, klines });

    if (!state.valid) {
      console.log(`❌ Invalid state: ${state.reason}`);
      console.log('✅ Cycle complete (clean exit).');
      process.exit(0);
    }

    const signal = generateSignal(state);

    console.log('📊 Signal Summary');
    console.log('------------------------------');
    console.log(`Market: ${state.market.eventTitle}`);
    console.log(`Balance (NGN): ₦${state.balance.toLocaleString('en-NG')}`);
    console.log(`BTC Price (USDT): ${state.btcPrice}`);
    console.log(`YES Odds: ${state.market.yesPrice}`);
    console.log(`NO Odds: ${state.market.noPrice}`);
    console.log(`Δ 5m (%): ${state.delta5m}`);
    console.log(`Minutes Remaining: ${state.minutesLeft}`);
    console.log('Signal Output:', signal);

    console.log('✅ Cycle complete.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Signal engine run failed.');
    console.error(error);
    process.exit(1);
  }
}

main();
