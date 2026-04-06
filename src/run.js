import './server.js';
import {
  CURRENCY,
  DAILY_LOSS_FLOOR,
  KELLY_FRACTION,
  MAX_STAKE_NGN,
  MIN_STAKE_NGN,
  startAgent,
} from './agent.js';

const ts = new Date().toISOString();
console.log('=====================================');
console.log(`[${ts}] Bayse Signal Engine booting`);
console.log(
  `[config] currency=${CURRENCY} minStake=${MIN_STAKE_NGN} maxStake=${MAX_STAKE_NGN} dailyLossFloor=${DAILY_LOSS_FLOOR} kellyFraction=${KELLY_FRACTION}`,
);
console.log('=====================================');

startAgent().catch((error) => {
  console.error('[fatal] agent failed during startup:', error);
  process.exit(1);
});
