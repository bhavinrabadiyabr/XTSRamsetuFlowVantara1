/**
 * Nifty Wish — one short against the closed-bar Nifty spot session VWAP.
 * Live spot above VWAP sells PE. Live spot below VWAP sells CE.
 * The forming-minute liveVwap is display only.
 */

export const UNDERLYING = "NIFTY";
export const LOT_SIZE = 65;
export const DEFAULT_QTY = 780;
export const DEFAULT_TARGET = "10";
export const VWAP_STORE_KEY = "sow_nifty_vwap_v1";
export const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
export const WINGS = [0, 1, 2, 3, 4, 5] as const;
export const SIZES = [1, 2, 3] as const;
export const MAX_LOG = 80;
export const POLL_MS = 10_000;
export const GUARD_MS = 200;
export const FLIP_RETRY_MS = 3_000;
export const ONE_SHORT = "One short only. The open side books first when Nifty crosses VWAP.";
export const NIFTY_ONLY = "Nifty VWAP trades NIFTY options only. Switch the top index to NIFTY.";

export type VwapDesk = {
  underlying: string;
  lotSize: number;
  defaultQty: number;
  storeKey: string;
  spotSymbol: string;
  onlyMessage: string;
  spotLabel: string;
  apiPath: string;
  focusChannel: string;
};

export const NIFTY_DESK: VwapDesk = {
  underlying: UNDERLYING,
  lotSize: LOT_SIZE,
  defaultQty: DEFAULT_QTY,
  storeKey: VWAP_STORE_KEY,
  spotSymbol: SPOT_SYMBOL,
  onlyMessage: NIFTY_ONLY,
  spotLabel: "Nifty",
  apiPath: "/api/vwap/data",
  focusChannel: "vwap",
};

export const SENSEX_DESK: VwapDesk = {
  underlying: "SENSEX",
  lotSize: 20,
  defaultQty: 240,
  storeKey: "sow_sensex_vwap_v1",
  spotSymbol: "BSE:SENSEX-INDEX",
  onlyMessage: "Sensex VWAP trades SENSEX options only. Switch the top index to SENSEX.",
  spotLabel: "Sensex",
  apiPath: "/api/vwap/sensex",
  focusChannel: "sensex-vwap",
};
export const EMPTY_LOG =
  "Above the session VWAP this desk sells the selected PE. Below it, the desk sells the selected CE. Wing 0 is ATM on both sides. Wing 1–5 shifts the CE up and the PE down by that many steps. A cross books the open side and sells the new side. The 1-minute close is not required. CE and PE are never open together.";

export type VwapSignal = "SELL_PE" | "SELL_CE" | "NONE";
export type OptionSide = "CE" | "PE";
export type SizeMult = (typeof SIZES)[number];
export type LogKind = "info" | "entry" | "exit" | "error";

export type VwapPosition = {
  instrumentId: number;
  strike: number;
  optionType: OptionSide;
  qty: number;
  fillPx: number;
  segment: number;
};

export type VwapLog = {
  id: number;
  ts: number;
  text: string;
  kind: LogKind;
};

export type VwapAt0952 = {
  minute?: string;
  high?: number;
  low?: number;
  close?: number;
  vwap?: number;
  match?: boolean;
};

export type VwapPayload = {
  ok?: boolean;
  error?: string | null;
  stale?: boolean;
  vwap?: number;
  liveVwap?: number;
  lastClose?: number;
  lastMinute?: string | null;
  barsUsed?: number;
  formingMinute?: string | null;
  sessionDate?: string | null;
  futureSymbol?: string;
  at0952?: VwapAt0952 | null;
};

export type VwapSession = {
  v: 2;
  qty: string;
  size: SizeMult;
  wing: number;
  targetText: string;
  targetLocked: boolean;
  targetArmed: number | null;
  slText: string;
  slLocked: boolean;
  slArmed: number | null;
  position: VwapPosition | null;
  logs: VwapLog[];
  nextLogId: number;
};

export function round2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

export function tradeSignal(spot: number | null | undefined, vwap: number | null | undefined): VwapSignal {
  const s = typeof spot === "number" && Number.isFinite(spot) && spot > 0 ? round2(spot) : 0;
  const v = typeof vwap === "number" && Number.isFinite(vwap) && vwap > 0 ? round2(vwap) : 0;
  if (!(s > 0) || !(v > 0)) return "NONE";
  if (s > v) return "SELL_PE";
  if (s < v) return "SELL_CE";
  return "NONE";
}

export function signalSide(signal: VwapSignal): OptionSide | null {
  if (signal === "SELL_PE") return "PE";
  if (signal === "SELL_CE") return "CE";
  return null;
}

export function signalLabel(signal: VwapSignal): string {
  if (signal === "SELL_PE") return "Sell PE";
  if (signal === "SELL_CE") return "Sell CE";
  return "NO TRADE";
}

export function spotGap(spot: number, vwap: number): number {
  return round2(spot - vwap);
}

export function lotQty(text: string, lotSize = LOT_SIZE): number | null {
  const lot = Number.isInteger(lotSize) && lotSize > 0 ? lotSize : LOT_SIZE;
  const raw = String(text ?? "").replace(/,/g, "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n % lot !== 0) return null;
  return n;
}

export function sizedQty(qtyText: string, size: number, lotSize = LOT_SIZE): number | null {
  const qty = lotQty(qtyText, lotSize);
  if (qty == null || !Number.isInteger(size) || size <= 0) return null;
  const order = qty * size;
  if (order <= 0 || order % (Number.isInteger(lotSize) && lotSize > 0 ? lotSize : LOT_SIZE) !== 0) return null;
  return order;
}

export function wingStrikes(atm: number, wing: number, step: number): { ce: number; pe: number } {
  const w = Math.max(0, Math.floor(wing));
  const st = step > 0 ? step : 50;
  return { ce: atm + w * st, pe: atm - w * st };
}

export function sellStrike(atm: number, wing: number, step: number, side: OptionSide): number {
  const legs = wingStrikes(atm, wing, step);
  return side === "CE" ? legs.ce : legs.pe;
}

export function orderButtonText(opts: {
  signal: VwapSignal;
  wing: number;
  strike: number | null;
  premium: number | null;
  openSide: OptionSide | null;
}): string {
  if (opts.signal === "NONE") return "NO TRADE";
  const side = signalSide(opts.signal);
  if (!side) return "NO TRADE";
  const strike = opts.strike != null ? String(Math.round(opts.strike)) : "";
  if (opts.openSide) return `${opts.openSide} OPEN`;
  const wingBit = opts.wing <= 0 ? `ATM ${side}` : side;
  const px = opts.premium != null && opts.premium > 0 ? ` @ ${opts.premium.toFixed(2)}` : "";
  return `SELL ${wingBit} ${strike}${px}`.replace(/\s+/g, " ").trim();
}

export function entryLog(opts: {
  spot: number;
  vwap: number;
  wing: number;
  side: OptionSide;
  strike: number;
  qty: number;
  premium: number;
  target: number | null;
}): string {
  const label = opts.wing <= 0 ? `SELL ATM ${opts.side}` : `SELL ${opts.side}`;
  const target = opts.target != null && opts.target > 0 ? String(opts.target) : "off";
  return `spot ${opts.spot.toFixed(2)} vs VWAP ${opts.vwap.toFixed(2)}: ${label} ${opts.strike.toLocaleString("en-IN")} × ${opts.qty.toLocaleString("en-IN")} @ ${opts.premium.toFixed(2)} · target ${target}`;
}

export function parsePoints(text: string): { ok: true; points: number | null } | { ok: false } {
  const raw = String(text ?? "").trim();
  if (!raw || /^0+(\.0+)?$/.test(raw)) return { ok: true, points: null };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  if (n === 0) return { ok: true, points: null };
  return { ok: true, points: round2(n) };
}

export function badPremiumTick(fill: number, premium: number): boolean {
  return fill >= 5 && premium < 0.5;
}

export function profitPoints(fill: number, premium: number): number {
  return round2(fill - premium);
}

export function targetHit(fill: number, premium: number, target: number | null): boolean {
  if (target == null || !(target > 0)) return false;
  return profitPoints(fill, premium) >= target;
}

export function slPriceHit(premium: number, sl: number | null): boolean {
  if (sl == null || !(sl > 0) || !(premium > 0)) return false;
  return premium + 1e-9 >= sl;
}

export function averageFill(oldFill: number, oldQty: number, addFill: number, addQty: number): number {
  return round2((oldFill * oldQty + addFill * addQty) / (oldQty + addQty));
}

export function bookPx(fill: number, points: number): number {
  return round2(fill - points);
}

export function flipAttemptKey(sessionDate: string, instrumentId: number, newSide: OptionSide): string {
  return `${sessionDate}|${instrumentId}|${newSide}`;
}

export function shortMtm(fill: number, premium: number, qty: number): number {
  return round2((fill - premium) * qty);
}

export function signedPts(points: number): string {
  const body = Math.abs(points).toFixed(2);
  if (points > 0) return `+${body}`;
  if (points < 0) return `-${body}`;
  return body;
}

export function istClock(now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
}

export function loadVwapSession(desk: VwapDesk = NIFTY_DESK): VwapSession | null {
  try {
    const raw = sessionStorage.getItem(desk.storeKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VwapSession>;
    if (!parsed || (parsed.v !== 1 && parsed.v !== 2)) return null;
    const size = parsed.size === 2 || parsed.size === 3 ? parsed.size : 1;
    const wing = typeof parsed.wing === "number" && parsed.wing >= 0 && parsed.wing <= 5 ? Math.floor(parsed.wing) : 0;
    const slIsPrice = parsed.v === 2;
    return {
      v: 2,
      qty: typeof parsed.qty === "string" && lotQty(parsed.qty, desk.lotSize) != null ? parsed.qty : String(desk.defaultQty),
      size,
      wing,
      targetText: typeof parsed.targetText === "string" ? parsed.targetText : DEFAULT_TARGET,
      targetLocked: Boolean(parsed.targetLocked),
      targetArmed: typeof parsed.targetArmed === "number" && parsed.targetArmed > 0 ? parsed.targetArmed : null,
      slText: slIsPrice && typeof parsed.slText === "string" ? parsed.slText : "",
      slLocked: slIsPrice && Boolean(parsed.slLocked),
      slArmed: slIsPrice && typeof parsed.slArmed === "number" && parsed.slArmed > 0 ? parsed.slArmed : null,
      position:
        parsed.position && parsed.position.instrumentId > 0 && parsed.position.qty > 0 && parsed.position.fillPx > 0
          ? {
              instrumentId: parsed.position.instrumentId,
              strike: parsed.position.strike,
              optionType: parsed.position.optionType === "PE" ? "PE" : "CE",
              qty: parsed.position.qty,
              fillPx: parsed.position.fillPx,
              segment: typeof parsed.position.segment === "number" ? parsed.position.segment : 0,
            }
          : null,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, MAX_LOG) : [],
      nextLogId: typeof parsed.nextLogId === "number" ? parsed.nextLogId : 1,
    };
  } catch {
    return null;
  }
}

export function saveVwapSession(session: VwapSession, storeKey = VWAP_STORE_KEY): void {
  try {
    const next: VwapSession = { ...session, v: 2, logs: session.logs.slice(0, MAX_LOG) };
    sessionStorage.setItem(storeKey, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
