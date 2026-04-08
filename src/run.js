import './server.js';
import {
  CURRENCY,
  DAILY_LOSS_FLOOR,
  KELLY_FRACTION,
  MAX_STAKE_NGN,
  MIN_STAKE_NGN,
} from './config.js';
import { startAgent } from './agent.js';

const START_RETRY_MS = 30_000;

const ts = new Date().toISOString();
console.log('=====================================');
console.log(`[${ts}] Bayse Signal Engine booting`);
console.log(
  `[config] currency=${CURRENCY} minStake=${MIN_STAKE_NGN} maxStake=${MAX_STAKE_NGN} dailyLossFloor=${DAILY_LOSS_FLOOR} kellyFraction=${KELLY_FRACTION}`,
);
console.log('=====================================');

async function bootAgentWithRetry() {
  try {
    await startAgent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[fatal] agent startup failed:', message);
    console.error(`[fatal] retrying agent startup in ${START_RETRY_MS / 1000}s`);
    setTimeout(bootAgentWithRetry, START_RETRY_MS);
  }
}

bootAgentWithRetry().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[fatal] bootstrap failed:', message);
  setTimeout(() => {
    void bootAgentWithRetry();
  }, START_RETRY_MS);
});
