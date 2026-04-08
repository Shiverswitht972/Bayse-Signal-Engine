diff --git a/src/run.js b/src/run.js
index f99f88cca00947ebdf9ab8007c572cba11e4704d..7352518b530cef8afd6f4c39099b54cc98968c1e 100644
--- a/src/run.js
+++ b/src/run.js
@@ -1,51 +1,31 @@
+import './server.js';
 import {
-  fetchBTCPrice,
-  fetchBTCKlines,
-  fetchBalance,
-  fetchCryptoMarket,
-} from './perception.js';
-import { normalizeState } from './normalize.js';
-import { generateSignal } from './signal.js';
-
-async function main() {
+  CURRENCY,
+  DAILY_LOSS_FLOOR,
+  KELLY_FRACTION,
+  MAX_STAKE_NGN,
+  MIN_STAKE_NGN,
+} from './config.js';
+import { startAgent } from './agent.js';
+
+const START_RETRY_MS = 30_000;
+
+const ts = new Date().toISOString();
+console.log('=====================================');
+console.log(`[${ts}] Bayse Signal Engine booting`);
+console.log(
+  `[config] currency=${CURRENCY} minStake=${MIN_STAKE_NGN} maxStake=${MAX_STAKE_NGN} dailyLossFloor=${DAILY_LOSS_FLOOR} kellyFraction=${KELLY_FRACTION}`,
+);
+console.log('=====================================');
+
+async function bootAgentWithRetry() {
   try {
-    console.log('📡 Fetching market, portfolio, and BTC inputs...');
-
-    const [market, balance, btcPrice, klines] = await Promise.all([
-      fetchCryptoMarket(),
-      fetchBalance(),
-      fetchBTCPrice(),
-      fetchBTCKlines(),
-    ]);
-
-    const state = normalizeState({ market, balance, btcPrice, klines });
-
-    if (!state.valid) {
-      console.log(`❌ Invalid state: ${state.reason}`);
-      console.log('✅ Cycle complete (clean exit).');
-      process.exit(0);
-    }
-
-    const signal = generateSignal(state);
-
-    console.log('📊 Signal Summary');
-    console.log('------------------------------');
-    console.log(`Market: ${state.market.eventTitle}`);
-    console.log(`Balance (NGN): ₦${state.balance.toLocaleString('en-NG')}`);
-    console.log(`BTC Price (USDT): ${state.btcPrice}`);
-    console.log(`YES Odds: ${state.market.yesPrice}`);
-    console.log(`NO Odds: ${state.market.noPrice}`);
-    console.log(`Δ 5m (%): ${state.delta5m}`);
-    console.log(`Minutes Remaining: ${state.minutesLeft}`);
-    console.log('Signal Output:', signal);
-
-    console.log('✅ Cycle complete.');
-    process.exit(0);
+    await startAgent();
   } catch (error) {
-    console.error('❌ Signal engine run failed.');
-    console.error(error);
-    process.exit(1);
+    console.error('[fatal] agent startup failed:', error.message);
+    console.error(`[fatal] retrying agent startup in ${START_RETRY_MS / 1000}s`);
+    setTimeout(bootAgentWithRetry, START_RETRY_MS);
   }
 }
 
-main();
+bootAgentWithRetry();
 
EOF
)
