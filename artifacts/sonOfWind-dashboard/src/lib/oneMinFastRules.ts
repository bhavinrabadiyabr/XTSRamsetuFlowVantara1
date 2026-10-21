/**
 * 1 min Fast — the Nifty Wish short against the locked 09:20 one-minute spot open.
 * Live spot above that open sells PE. Live spot below it sells CE.
 * The 1-minute close is not the signal, and later candles do not move the open.
 */

import type { VwapDesk } from "@/lib/niftyVwapRules";

export const NIFTY_FAST1: VwapDesk = {
  underlying: "NIFTY",
  lotSize: 65,
  defaultQty: 780,
  storeKey: "sow_fast1_nifty_v1",
  spotSymbol: "NSE:NIFTY50-INDEX",
  onlyMessage: "1 min Fast trades Nifty or Sensex. Switch the top index to NIFTY or SENSEX.",
  spotLabel: "Nifty",
  apiPath: "/api/fast1/open?underlying=NIFTY",
  focusChannel: "fast1-nifty",
};

export const SENSEX_FAST1: VwapDesk = {
  underlying: "SENSEX",
  lotSize: 20,
  defaultQty: 20,
  storeKey: "sow_fast1_sensex_v1",
  spotSymbol: "BSE:SENSEX-INDEX",
  onlyMessage: "1 min Fast trades Nifty or Sensex. Switch the top index to NIFTY or SENSEX.",
  spotLabel: "Sensex",
  apiPath: "/api/fast1/open?underlying=SENSEX",
  focusChannel: "fast1-sensex",
};

export function fast1Desk(index: string | null | undefined): VwapDesk | null {
  const name = String(index || "").trim().toUpperCase();
  if (name === "NIFTY") return NIFTY_FAST1;
  if (name === "SENSEX") return SENSEX_FAST1;
  return null;
}

export const EMPTY_LOG =
  "Above the locked 09:20 open this desk sells the selected PE. Below it, the desk sells the selected CE. Wing 0 is ATM on both sides. Wing 1–5 shifts the CE up and the PE down by that many steps. The first sell is the SELL button. A cross books the open side and sells the new side. The 1-minute close is not required. CE and PE are never open together. Before 09:20 there is no line and no trade.";

export type Open0920Payload = {
  ok?: boolean;
  pending?: boolean;
  error?: string | null;
  spot?: number | null;
  source?: string | null;
  sessionDate?: string | null;
  minute?: string | null;
};

export function entryLog(opts: {
  spot: number;
  open: number;
  wing: number;
  side: "CE" | "PE";
  strike: number;
  qty: number;
  premium: number;
  target: number | null;
}): string {
  const label = opts.wing <= 0 ? `SELL ATM ${opts.side}` : `SELL ${opts.side}`;
  const target = opts.target != null && opts.target > 0 ? String(opts.target) : "off";
  return `spot ${opts.spot.toFixed(2)} vs 09:20 open ${opts.open.toFixed(2)}: ${label} ${opts.strike.toLocaleString("en-IN")} × ${opts.qty.toLocaleString("en-IN")} @ ${opts.premium.toFixed(2)} · target ${target}`;
}
