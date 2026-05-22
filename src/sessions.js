/**
 * Trading Session Detector
 *
 * BTC volatility and trend reliability vary significantly by UTC session.
 * London and New York overlaps produce the most directional price action.
 * The Asian session is slower and choppier — signals are less reliable.
 *
 * Each session carries a threshold multiplier applied to the composite signal
 * threshold in signal.js. Multipliers > 1 raise the bar (harder to fire),
 * multipliers < 1 lower it (easier to fire).
 *
 * Sessions are intentionally overlapping (London and NY share 13:00–16:00 UTC).
 * In overlapping hours, the first match wins — London takes priority since it
 * is the higher-activity session for BTC crypto markets.
 *
 * Session windows (UTC):
 *   ASIAN:    00:00 – 09:00  → quieter, slightly tighter bar
 *   LONDON:   07:00 – 16:00  → highest BTC vol, most reliable trends
 *   NEW_YORK: 13:00 – 22:00  → strong vol, especially during 13–16 overlap
 *   OFF:      22:00 – 00:00  → minimal activity, hardest bar
 */

const SESSIONS = [
  { name: 'LONDON',   startHour: 7,  endHour: 16, multiplier: 0.90 },
  { name: 'NEW_YORK', startHour: 13, endHour: 22, multiplier: 0.95 },
  { name: 'ASIAN',    startHour: 0,  endHour: 9,  multiplier: 1.10 },
];

/**
 * Returns the current UTC trading session and its threshold multiplier.
 *
 * @returns {{ name: string, multiplier: number }}
 *   name       — 'LONDON' | 'NEW_YORK' | 'ASIAN' | 'OFF'
 *   multiplier — applied to composite threshold in signal.js
 */
export function getCurrentSession() {
  const utcHour = new Date().getUTCHours();

  for (const session of SESSIONS) {
    if (utcHour >= session.startHour && utcHour < session.endHour) {
      return { name: session.name, multiplier: session.multiplier };
    }
  }

  return { name: 'OFF', multiplier: 1.15 };
}
