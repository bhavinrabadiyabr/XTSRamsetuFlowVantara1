import { peekLiveLtp } from "@/context/LiveLtpContext";

/** XTS LastTradedPrice tape — peek is tick-to-tick; map is the last React flush. */
export function liveTapeLtp(
  iid: number | null | undefined,
  fallback?: Record<number, number> | number | null,
): number | null {
  if (typeof iid !== "number" || !Number.isFinite(iid) || iid <= 0) return null;
  const peek = peekLiveLtp(iid);
  if (peek != null) return peek;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  if (fallback && typeof fallback === "object") {
    const v = fallback[iid];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Read LTP / ATP (Mace) from SSE maps; LTP prefers the live tape peek. */
export function readLiveQuote(
  iid: number,
  ltps: Record<number, number>,
  atps: Record<number, number>,
): { ltp: number | null; atp: number | null } {
  const ltp = liveTapeLtp(iid, ltps);
  const a = atps[iid];
  const atp = typeof a === "number" && Number.isFinite(a) && a > 0 ? a : null;
  return { ltp, atp };
}
