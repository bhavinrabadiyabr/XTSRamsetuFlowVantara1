import { peekLiveLtp } from "@/context/LiveLtpContext";

/** Index spots and option premiums in this app stay under 10 lakh. Mis-decoded doubles are ~1e185. */
export function plausiblePx(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0.01 || n > 1_000_000) return null;
  return n;
}

/** XTS LastTradedPrice tape — peek is tick-to-tick; map is the last React flush. */
export function liveTapeLtp(
  iid: number | null | undefined,
  fallback?: Record<number, number> | number | null,
): number | null {
  if (typeof iid !== "number" || !Number.isFinite(iid) || iid <= 0) return null;
  const peek = plausiblePx(peekLiveLtp(iid));
  if (peek != null) return peek;
  if (typeof fallback === "number") return plausiblePx(fallback);
  if (fallback && typeof fallback === "object") return plausiblePx(fallback[iid]);
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
