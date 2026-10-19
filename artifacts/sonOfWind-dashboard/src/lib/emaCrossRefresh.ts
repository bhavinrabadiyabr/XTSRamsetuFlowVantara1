/** Checks 2s and 4s after each minute, once the 1-minute candle has closed. */
const REFRESH_SLOTS_MS = [2_000, 4_000];

export function nextEmaCrossRefreshMs(now = Date.now()): number {
  const intoMinute = now % 60_000;
  let best = 60_000;
  for (const slot of REFRESH_SLOTS_MS) {
    let wait = slot - intoMinute;
    if (wait <= 150) wait += 60_000;
    if (wait < best) best = wait;
  }
  return best;
}
