const EXPIRY_WINDOW_MS = 120_000;   // 2 minutes
const PRICE_BAND_USD   = 150;       // $150 either side of the line

export function isInExpiryDeadZone(marketExpiryTime, currentPrice, bayseLinePrice) {
  const timeToExpiry  = marketExpiryTime - Date.now();
  const priceDistance = Math.abs(currentPrice - bayseLinePrice);

  return timeToExpiry <= EXPIRY_WINDOW_MS && priceDistance <= PRICE_BAND_USD;
}
