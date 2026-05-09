/**
 * Chainlink Onchain Price Feed
 *
 * Polls Chainlink AggregatorV3 contracts on Ethereum mainnet for ETH, SOL,
 * and BNB prices. These are the same feeds Bayse Markets uses for resolution
 * of ETH/SOL/BNB 15-min UP/DOWN markets.
 *
 * No credentials required — reads via public Ethereum JSON-RPC.
 * All USD feeds return answers with 8 decimal places.
 *
 * Polling interval: 2s per feed. On round change, fires onPrice callback.
 * Falls through a public RPC fallback chain on provider errors.
 */

import { ethers } from 'ethers';

// Minimal ABI — only what we need
const AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

// Public Ethereum mainnet RPCs — tried in order on failure
const RPC_FALLBACK_CHAIN = [
  'https://eth.llamarpc.com',
  'https://ethereum.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://1rpc.io/eth',
];

const POLL_INTERVAL_MS = 2_000;
const DECIMALS = 1e8; // All Chainlink USD feeds use 8 decimal places

/**
 * Start polling Chainlink price feeds.
 *
 * @param {Array<{ symbol: string, address: string }>} feeds
 *   Each entry maps a market symbol (e.g. 'ETH') to its aggregator address.
 *
 * @param {Function} onPrice
 *   Called on every new round: (symbol: string, price: number, timestamp: string) => void
 *
 * @returns {Function} stop — call to clear the polling interval
 */
export function startChainlinkFeed(feeds, onPrice) {
  let rpcIndex = 0;
  let provider  = new ethers.JsonRpcProvider(RPC_FALLBACK_CHAIN[0]);
  console.log(`[chainlink] Provider: ${RPC_FALLBACK_CHAIN[0]}`);

  // Build contract instances — keyed by symbol
  let contracts = feeds.map(({ symbol, address }) => ({
    symbol,
    address,
    contract: new ethers.Contract(address, AGGREGATOR_ABI, provider),
    lastRoundId: null,
  }));

  function rotateProvider(errMsg) {
    rpcIndex = (rpcIndex + 1) % RPC_FALLBACK_CHAIN.length;
    const url = RPC_FALLBACK_CHAIN[rpcIndex];
    console.warn(`[chainlink] RPC error (${errMsg}) — rotating to ${url}`);
    provider = new ethers.JsonRpcProvider(url);
    contracts = contracts.map(f => ({
      ...f,
      contract: new ethers.Contract(f.address, AGGREGATOR_ABI, provider),
    }));
  }

  async function poll() {
    for (const feed of contracts) {
      try {
        const [roundId, answer, , updatedAt] = await feed.contract.latestRoundData();

        const roundIdStr = roundId.toString();
        if (roundIdStr === feed.lastRoundId) continue; // no new round — skip

        feed.lastRoundId = roundIdStr;

        const price     = Number(answer) / DECIMALS;
        const timestamp = new Date(Number(updatedAt) * 1000).toISOString();

        if (!Number.isFinite(price) || price <= 0) {
          console.warn(`[chainlink:${feed.symbol}] Invalid price: ${price}`);
          continue;
        }

        console.log(`[chainlink:${feed.symbol}] $${price} (round ${roundIdStr})`);
        onPrice(feed.symbol, price, timestamp);

      } catch (err) {
        console.error(`[chainlink:${feed.symbol}] poll error: ${err.message}`);
        rotateProvider(err.message.slice(0, 60));
        break; // re-poll on next interval with fresh provider
      }
    }
  }

  // Fire immediately, then on interval
  poll().catch(err => console.error('[chainlink] initial poll error:', err.message));
  const interval = setInterval(
    () => poll().catch(err => console.error('[chainlink] poll error:', err.message)),
    POLL_INTERVAL_MS,
  );

  return () => clearInterval(interval);
}
