/**
 * Chainlink Onchain Price Feed — raw JSON-RPC via fetch
 *
 * Calls latestRoundData() on Chainlink AggregatorV3 contracts on Ethereum
 * mainnet using plain fetch + JSON-RPC. No ethers.js, no network detection
 * step, no startup handshake — just direct HTTP calls to a public RPC node.
 *
 * Used for ETH, SOL, and BNB price feeds. BTC remains on the Bayse WS.
 *
 * Polling interval: 2s. Fires onPrice callback only on new rounds (round-ID
 * change detection). Falls through a public RPC fallback chain on errors.
 */

// Public Ethereum mainnet JSON-RPC endpoints — tried in order on failure
const RPC_FALLBACK_CHAIN = [
  'https://eth.llamarpc.com',
  'https://ethereum.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://1rpc.io/eth',
];

// keccak256("latestRoundData()") first 4 bytes — Chainlink official selector
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';

const POLL_INTERVAL_MS = 2_000;
const DECIMALS         = 1e8;  // All Chainlink USD feeds: 8 decimal places

// ── ABI decode latestRoundData() response ─────────────────────────────────────
// (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
// Each value ABI-encoded as a 32-byte (64 hex char) word.
function decodeLatestRoundData(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  if (hex.length < 320) throw new Error(`Unexpected response length: ${hex.length}`);

  const roundId   = BigInt('0x' + hex.slice(0,   64));
  const answer    = BigInt('0x' + hex.slice(64,  128));
  const updatedAt = BigInt('0x' + hex.slice(192, 256));

  return { roundId, answer, updatedAt };
}

// ── Single eth_call via fetch ─────────────────────────────────────────────────
async function ethCall(rpcUrl, contractAddress) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method:  'eth_call',
    params:  [{ to: contractAddress, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'],
    id:      1,
  });

  const response = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(5_000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${rpcUrl}`);

  const data = await response.json();

  if (data.error)                        throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  if (!data.result || data.result === '0x') throw new Error(`Empty result from ${rpcUrl}`);

  return data.result;
}

// ── Start polling all Chainlink feeds ─────────────────────────────────────────
/**
 * @param {Array<{ symbol: string, address: string }>} feeds
 * @param {Function} onPrice — (symbol, price, timestamp) => void
 * @returns {Function} stop  — clears the polling interval
 */
export function startChainlinkFeed(feeds, onPrice) {
  let rpcIndex = 0;

  const feedState = feeds.map(({ symbol, address }) => ({
    symbol,
    address,
    lastRoundId: null,
  }));

  async function poll() {
    const rpcUrl = RPC_FALLBACK_CHAIN[rpcIndex];

    for (const feed of feedState) {
      try {
        const raw = await ethCall(rpcUrl, feed.address);
        const { roundId, answer, updatedAt } = decodeLatestRoundData(raw);

        const roundIdStr = roundId.toString();
        if (roundIdStr === feed.lastRoundId) continue;

        feed.lastRoundId = roundIdStr;

        const price     = Number(answer) / DECIMALS;
        const timestamp = new Date(Number(updatedAt) * 1000).toISOString();

        if (!Number.isFinite(price) || price <= 0) {
          console.warn(`[chainlink:${feed.symbol}] invalid price ${price} — skipping`);
          continue;
        }

        console.log(`[chainlink:${feed.symbol}] $${price} (round ${roundIdStr})`);
        onPrice(feed.symbol, price, timestamp);

      } catch (err) {
        console.error(`[chainlink:${feed.symbol}] error on ${rpcUrl}: ${err.message}`);
        rpcIndex = (rpcIndex + 1) % RPC_FALLBACK_CHAIN.length;
        console.warn(`[chainlink] rotating to ${RPC_FALLBACK_CHAIN[rpcIndex]}`);
        break;
      }
    }
  }

  poll().catch(err => console.error('[chainlink] initial poll failed:', err.message));

  const interval = setInterval(
    () => poll().catch(err => console.error('[chainlink] poll failed:', err.message)),
    POLL_INTERVAL_MS,
  );

  console.log(`[chainlink] Started: ${feeds.map(f => f.symbol).join(', ')} via ${RPC_FALLBACK_CHAIN[0]}`);

  return () => clearInterval(interval);
}
