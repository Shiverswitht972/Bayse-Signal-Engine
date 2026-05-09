export const MAX_STAKE_NGN = 6500;
export const DAILY_LOSS_FLOOR = 500;
export const KELLY_FRACTION = 0.5;
export const MIN_STAKE_NGN = 150;
export const CURRENCY = 'NGN';
export const MINUTES_BETWEEN_TRADES = 15;
export const MARKET_END_BUFFER_MINUTES = 3;
export const BALANCE_REFRESH_MS = 5 * 60 * 1000;
export const WS_BACKOFF_START_MS = 2_000;
export const WS_BACKOFF_MAX_MS = 30_000;
export const ALPHA_ENABLED = true;
export const MIN_VOL_THRESHOLD = 0.0005;
export const ALPHA_MIN_STRENGTH = 0.1;
export const ALPHA_EARLY_OVERRIDE_STRENGTH = 0.2;
export const ALPHA_EARLY_MINUTE = 5;
export const ALPHA_LATE_MINUTE = 12;
export const MIN_HISTORY_POINTS = 20;
export const REGIME_CANDLE_LIMIT = 100;

/**
 * Active markets — all 15-min UP/DOWN on Bayse Markets.
 *
 * priceSymbol — symbol on Bayse WS /ws/v1/realtime (asset_prices channel).
 *               null = not available on Bayse WS; price fed via Binance WS instead.
 * klineSymbol — Binance symbol for klines (regime + indicator candles).
 * seriesSlug  — Bayse event series slug for fetching the current open event window.
 *               BTC slug is confirmed. ETH/SOL/BNB slugs are inferred from the same
 *               pattern — verify all four via GET /v1/pm/events/series on first boot
 *               and update any that differ.
 */
export const MARKETS = [
  {
    name: 'BTC 15min',
    symbol: 'BTC',
    priceSource: 'binance-ws',     // Live price feed: Bayse WS (sourced from Binance)
    priceSymbol: 'BTCUSDT',        // Symbol subscribed to on Bayse WS
    klineSymbol: 'BTCUSDT',        // Binance klines for regime + indicators
    chainlinkAddress: null,        // BTC does not use Chainlink feed
    seriesSlug: 'crypto-btc-15m',
  },
  {
    name: 'ETH 15min',
    symbol: 'ETH',
    priceSource: 'chainlink',      // Live price feed: Chainlink onchain aggregator
    priceSymbol: null,             // Not using Bayse WS for price
    klineSymbol: 'ETHUSDT',        // Binance klines still used for regime + indicators
    chainlinkAddress: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH/USD mainnet
    seriesSlug: 'crypto-eth-15m',
  },
  {
    name: 'SOL 15min',
    symbol: 'SOL',
    priceSource: 'chainlink',      // Live price feed: Chainlink onchain aggregator
    priceSymbol: null,             // Not using Bayse WS for price
    klineSymbol: 'SOLUSDT',        // Binance klines still used for regime + indicators
    chainlinkAddress: '0x4ffC43a60e009B551865A93d232E33Fce9f01507', // SOL/USD mainnet
    seriesSlug: 'crypto-sol-15m',
  },
  {
    name: 'BNB 15min',
    symbol: 'BNB',
    priceSource: 'chainlink',      // Live price feed: Chainlink onchain aggregator
    priceSymbol: null,             // Not using Bayse WS or Binance WS for price
    klineSymbol: 'BNBUSDT',        // Binance klines still used for regime + indicators
    chainlinkAddress: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', // BNB/USD mainnet
    seriesSlug: 'crypto-bnb-15m',
  },
];
