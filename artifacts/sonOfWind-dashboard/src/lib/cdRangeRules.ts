/**
 * CD — AutoTradeFlow XTS SENSEX Range Flow.
 * Answer only from these rules. Do not invent entries, exits, scores, or settings.
 *
 * Market: SENSEX weekly options, BSEFO. One short at a time, ATM CE or ATM PE.
 * Lot size 20. Strike step 100. Expiry is the nearest Thursday, never the same day.
 * Orders are XTS market orders, NRML, time-in-force EOS.
 *
 * Editable on the CD tab. Each box is a draft until SAVE.
 * Lots 1–50 default 2. TF 1–60 default 15. Candles 1–20 default 4.
 * Min gap 0–5000 default 50. SL % 0–100 default 12.
 * Trail arm % 0–100 default 5. Trail lock % 0–100 default 0, and below the arm when above 0.
 * Extra 0–5000 default 0. Target % 0–100 default 10. MID stop default off.
 *
 * Fixed: no new entry or flip at or after 14:30 IST. Square-off 15:14 IST.
 * Day stop at net 2. A failed sell waits 60 seconds.
 *
 * Bars start at 09:15 IST and are TF minutes long. HIGH / LOW come from the last
 * N fully closed bars. The forming bar is never in the range.
 * First entry is 09:15 + Candles × TF. Spot above HIGH + extra sells the ATM PE.
 * Spot below LOW − extra sells the ATM CE. After a target, stop-loss, trail, or
 * MID exit, wait for a print back inside HIGH and LOW, then a new break.
 *
 * Exit order: 15:14 square, opposite break, MID (only if on), stop-loss, target, trail.
 * Target wins when one print jumps through the trail.
 * A target scores +1 only when cover <= sold × (1 − target%/100) + 1. Otherwise 0.
 * A trail scores 0. A losing opposite break scores −0.5. Any other loss scores −1.
 */

export const CD = {
  name: "CD",
  underlying: "SENSEX",
  lotSize: 20,
  strikeStep: 100,
  entryCutoff: { hh: 14, mm: 30 },
  squareOff: { hh: 15, mm: 14 },
  dayStop: 2,
  sellRetryMs: 60_000,
  storeKey: "sow_cd_range_v2",
  legacyStoreKey: "sow_cd_range_v1",
  apiPath: "/api/cd/range",
  focusChannel: "cd-range",
  onlyMessage: "CD trades SENSEX options only. Switch the top index to SENSEX.",
} as const;

export type CdSettings = {
  lots: number;
  tfMin: number;
  candles: number;
  minGap: number;
  slPct: number;
  trailArmPct: number;
  trailLockPct: number;
  extra: number;
  targetPct: number;
  midStop: boolean;
};

export type CdDraft = {
  lots: string;
  tfMin: string;
  candles: string;
  minGap: string;
  slPct: string;
  trailArmPct: string;
  trailLockPct: string;
  extra: string;
  targetPct: string;
  midStop: boolean;
};

export const CD_DEFAULTS: CdSettings = {
  lots: 2,
  tfMin: 15,
  candles: 4,
  minGap: 50,
  slPct: 12,
  trailArmPct: 5,
  trailLockPct: 0,
  extra: 0,
  targetPct: 10,
  midStop: false,
};

export const EMPTY_LOG =
  "CD sells one SENSEX weekly ATM option on BSEFO. Lot size is 20 and the strike step is 100. Expiry is the nearest Thursday, never the same day. Orders are XTS market orders, NRML, EOS. Each box is a draft until SAVE. Defaults are lots 2, TF 15, candles 4, min gap 50, SL 12%, trail arm 5%, trail lock 0, extra 0, target 10%, and MID off. HIGH is the max high of the last N closed bars, LOW is the min low, and the forming bar stays out. The first entry is 09:15 plus candles times TF. Spot above HIGH plus extra sells the ATM PE. Spot below LOW minus extra sells the ATM CE. After a target, stop-loss, trail, or MID exit, spot has to print back inside HIGH and LOW before the next break. An opposite break covers and flips when the cutoff and the day stop allow it. No new entry or flip at or after 14:30. Square-off is 15:14, and after that this desk sends nothing else today. A failed sell waits 60 seconds. A target scores +1 only when the cover is within one point of the target percent. A trail scores 0. A losing opposite break scores −0.5. Any other loss scores −1. Net 2 stops new entries and flips.";

export type OptionSide = "CE" | "PE";
export type CloseLabel = "TARGET" | "TRAIL" | "OPPOSITE" | "SL" | "MID" | "SQUARE";

export type CdExit =
  | { kind: "SQUARE" }
  | { kind: "OPPOSITE"; next: OptionSide; flip: boolean }
  | { kind: "MID" }
  | { kind: "SL" }
  | { kind: "TRAIL" }
  | { kind: "TARGET" }
  | { kind: "NONE"; armTrail: boolean };

export type CdRangePayload = {
  ok?: boolean;
  error?: string | null;
  ready?: boolean;
  tradable?: boolean;
  high?: number | null;
  low?: number | null;
  mid?: number | null;
  gap?: number | null;
  closedCount?: number;
  candles?: number;
  tfMinutes?: number;
  minGap?: number;
  firstEntry?: string | null;
  sessionDate?: string | null;
  firstBar?: string | null;
  lastBar?: string | null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function istParts(now = new Date()): {
  year: number;
  month: number;
  day: number;
  hh: number;
  mm: number;
  ss: number;
  date: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  let hh = pick("hour");
  if (hh === 24) hh = 0;
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const mm = pick("minute");
  const ss = pick("second");
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, hh, mm, ss, date };
}

export function pastCutoff(hh: number, mm: number): boolean {
  return hh > CD.entryCutoff.hh || (hh === CD.entryCutoff.hh && mm >= CD.entryCutoff.mm);
}

export function squareTime(hh: number, mm: number): boolean {
  return hh > CD.squareOff.hh || (hh === CD.squareOff.hh && mm >= CD.squareOff.mm);
}

export function orderQty(lots: number, lotSize = CD.lotSize): number | null {
  if (!Number.isInteger(lots) || lots < 1 || lots > 50) return null;
  if (!Number.isInteger(lotSize) || lotSize <= 0) return null;
  return lots * lotSize;
}

export function atmStrike(spot: number, step = CD.strikeStep): number {
  const st = step > 0 ? step : CD.strikeStep;
  return Math.round(spot / st) * st;
}

function parseWhole(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

function parseDecimal(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function inRange(n: number, lo: number, hi: number): boolean {
  return n + 1e-9 >= lo && n <= hi + 1e-9;
}

export function draftFromSettings(settings: CdSettings): CdDraft {
  return {
    lots: String(settings.lots),
    tfMin: String(settings.tfMin),
    candles: String(settings.candles),
    minGap: String(settings.minGap),
    slPct: String(settings.slPct),
    trailArmPct: String(settings.trailArmPct),
    trailLockPct: String(settings.trailLockPct),
    extra: String(settings.extra),
    targetPct: String(settings.targetPct),
    midStop: settings.midStop,
  };
}

export function validateCdDraft(draft: CdDraft): { ok: true; settings: CdSettings } | { ok: false; reason: string } {
  const lots = parseWhole(draft.lots);
  if (lots == null || lots < 1 || lots > 50) return { ok: false, reason: "Lots must be a whole number from 1 to 50." };
  const tfMin = parseWhole(draft.tfMin);
  if (tfMin == null || tfMin < 1 || tfMin > 60) return { ok: false, reason: "TF min must be a whole number from 1 to 60." };
  const candles = parseWhole(draft.candles);
  if (candles == null || candles < 1 || candles > 20) {
    return { ok: false, reason: "Candles must be a whole number from 1 to 20." };
  }
  const minGap = parseDecimal(draft.minGap);
  if (minGap == null || !inRange(minGap, 0, 5000)) return { ok: false, reason: "Min gap must be from 0 to 5000." };
  const slPct = parseDecimal(draft.slPct);
  if (slPct == null || !inRange(slPct, 0, 100)) return { ok: false, reason: "SL % must be from 0 to 100." };
  const trailArmPct = parseDecimal(draft.trailArmPct);
  if (trailArmPct == null || !inRange(trailArmPct, 0, 100)) {
    return { ok: false, reason: "Trail arm % must be from 0 to 100." };
  }
  const trailLockPct = parseDecimal(draft.trailLockPct);
  if (trailLockPct == null || !inRange(trailLockPct, 0, 100)) {
    return { ok: false, reason: "Trail lock % must be from 0 to 100." };
  }
  if (trailLockPct > 0 && !(trailLockPct < trailArmPct)) {
    return { ok: false, reason: "Trail lock % must be below Trail arm %." };
  }
  const extra = parseDecimal(draft.extra);
  if (extra == null || !inRange(extra, 0, 5000)) return { ok: false, reason: "Extra must be from 0 to 5000." };
  const targetPct = parseDecimal(draft.targetPct);
  if (targetPct == null || !inRange(targetPct, 0, 100)) return { ok: false, reason: "Target % must be from 0 to 100." };
  return {
    ok: true,
    settings: { lots, tfMin, candles, minGap, slPct, trailArmPct, trailLockPct, extra, targetPct, midStop: draft.midStop === true },
  };
}

export function sameSettings(a: CdSettings, b: CdSettings): boolean {
  return (
    a.lots === b.lots &&
    a.tfMin === b.tfMin &&
    a.candles === b.candles &&
    a.minGap === b.minGap &&
    a.slPct === b.slPct &&
    a.trailArmPct === b.trailArmPct &&
    a.trailLockPct === b.trailLockPct &&
    a.extra === b.extra &&
    a.targetPct === b.targetPct &&
    a.midStop === b.midStop
  );
}

export function isUnsaved(draft: CdDraft, live: CdSettings): boolean {
  const parsed = validateCdDraft(draft);
  if (!parsed.ok) return true;
  return !sameSettings(parsed.settings, live);
}

export function formatSaved(settings: CdSettings): string {
  const qty = orderQty(settings.lots) ?? 0;
  const mid = settings.midStop ? "on" : "off";
  return `Saved. Lots ${settings.lots} · TF ${settings.tfMin} · Candles ${settings.candles} · Min gap ${settings.minGap} · SL ${settings.slPct}% · Trail arm ${settings.trailArmPct}% · Trail lock ${settings.trailLockPct}% · Extra ${settings.extra} · Target ${settings.targetPct}% · MID ${mid} · Qty ${qty}`;
}

export function coerceSettings(value: Partial<CdSettings> | null | undefined): CdSettings {
  const merged = { ...CD_DEFAULTS, ...(value || {}) };
  const parsed = validateCdDraft(draftFromSettings(merged));
  return parsed.ok ? parsed.settings : CD_DEFAULTS;
}

export function firstEntryLabel(candles: number, tfMin: number): string {
  const total = 9 * 60 + 15 + candles * tfMin;
  const days = Math.floor(total / (24 * 60));
  const mins = total % (24 * 60);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return days > 0 ? `${clock} +${days}d` : clock;
}

export function parseExpiryLabel(label: string): { year: number; month: number; day: number } | null {
  const match = String(label).trim().match(/^(\d{1,2})([A-Za-z]{3})(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31 || year < 2000) return null;
  return { year, month, day };
}

function dateKey(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

export function isThursday(year: number, month: number, day: number): boolean {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 4;
}

export function nearestThursdayExpiry<T extends { label: string; api: string }>(rows: readonly T[], now = new Date()): T | null {
  const today = istParts(now);
  const todayKey = dateKey(today.year, today.month, today.day);
  let best: { key: number; row: T } | null = null;
  for (const row of rows) {
    const parsed = parseExpiryLabel(row.label);
    if (!parsed || !isThursday(parsed.year, parsed.month, parsed.day)) continue;
    const key = dateKey(parsed.year, parsed.month, parsed.day);
    if (key <= todayKey) continue;
    if (!best || key < best.key) best = { key, row };
  }
  return best?.row ?? null;
}

export function breakout(
  spot: number | null | undefined,
  high: number | null | undefined,
  low: number | null | undefined,
  extra = CD_DEFAULTS.extra,
): OptionSide | null {
  if (typeof spot !== "number" || typeof high !== "number" || typeof low !== "number") return null;
  if (!(spot > 0) || !(high > 0) || !(low > 0) || !(high > low)) return null;
  const pad = Number.isFinite(extra) ? extra : 0;
  if (spot > high + pad) return "PE";
  if (spot < low - pad) return "CE";
  return null;
}

export function insideRange(
  spot: number | null | undefined,
  high: number | null | undefined,
  low: number | null | undefined,
): boolean {
  if (typeof spot !== "number" || typeof high !== "number" || typeof low !== "number") return false;
  return spot > low && spot < high;
}

export function entrySide(opts: {
  hh: number;
  mm: number;
  spot: number | null;
  high: number | null;
  low: number | null;
  tradable: boolean;
  hunting: boolean;
  needInside: boolean;
  seenInside: boolean;
  extra?: number;
}): OptionSide | null {
  if (!opts.hunting || !opts.tradable) return null;
  if (pastCutoff(opts.hh, opts.mm) || squareTime(opts.hh, opts.mm)) return null;
  if (opts.needInside && !opts.seenInside) return null;
  return breakout(opts.spot, opts.high, opts.low, opts.extra ?? CD_DEFAULTS.extra);
}

export function oppositeSide(
  open: OptionSide,
  spot: number | null | undefined,
  high: number | null | undefined,
  low: number | null | undefined,
  extra = CD_DEFAULTS.extra,
): OptionSide | null {
  const next = breakout(spot, high, low, extra);
  if (!next || next === open) return null;
  return next;
}

export function targetPx(sold: number, targetPct = CD_DEFAULTS.targetPct): number {
  return (sold * (100 - targetPct)) / 100;
}

export function trailArmPx(sold: number, trailArmPct = CD_DEFAULTS.trailArmPct): number {
  return (sold * (100 - trailArmPct)) / 100;
}

export function trailStopPx(sold: number, trailLockPct = CD_DEFAULTS.trailLockPct): number {
  return (sold * (100 - trailLockPct)) / 100;
}

export function stopPx(sold: number, slPct = CD_DEFAULTS.slPct): number {
  return (sold * (100 + slPct)) / 100;
}

export function targetReached(sold: number, cover: number, percent = CD_DEFAULTS.targetPct): boolean {
  if (!(sold > 0) || !(cover > 0)) return false;
  const line = (sold * (100 - percent)) / 100 + 1;
  return cover <= line + 1e-9;
}

export function closeScore(label: CloseLabel, sold: number, cover: number, targetPct = CD_DEFAULTS.targetPct): number {
  if (!(sold > 0) || !(cover > 0)) return 0;
  if (label === "TARGET") return targetReached(sold, cover, targetPct) ? 1 : 0;
  if (label === "TRAIL") return 0;
  const loss = cover > sold + 1e-9;
  if (!loss) return 0;
  if (label === "OPPOSITE") return -0.5;
  return -1;
}

export function dayStopHit(net: number, stop = CD.dayStop): boolean {
  if (!(stop > 0)) return false;
  return net + 1e-9 >= stop;
}

export function roundScore(net: number): number {
  return Math.round((net + 1e-9) * 10) / 10;
}

export function fmtScore(net: number): string {
  const v = roundScore(net);
  const text = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return v > 0 ? `+${text}` : text;
}

export function waitInsideAfter(label: CloseLabel): boolean {
  return label === "TARGET" || label === "SL" || label === "TRAIL" || label === "MID";
}

export function decideExit(opts: {
  hh: number;
  mm: number;
  spot: number | null;
  high: number | null;
  low: number | null;
  mid: number | null;
  tradable: boolean;
  side: OptionSide;
  sold: number;
  ltp: number | null;
  trailArmed: boolean;
  canFlip: boolean;
  midOn?: boolean;
  extra?: number;
  slPct?: number;
  trailArmPct?: number;
  trailLockPct?: number;
  targetPct?: number;
}): CdExit {
  const slPct = opts.slPct ?? CD_DEFAULTS.slPct;
  const trailArmPct = opts.trailArmPct ?? CD_DEFAULTS.trailArmPct;
  const trailLockPct = opts.trailLockPct ?? CD_DEFAULTS.trailLockPct;
  const targetPct = opts.targetPct ?? CD_DEFAULTS.targetPct;
  const extra = opts.extra ?? CD_DEFAULTS.extra;
  if (squareTime(opts.hh, opts.mm)) return { kind: "SQUARE" };
  const next = oppositeSide(opts.side, opts.spot, opts.high, opts.low, extra);
  if (next) return { kind: "OPPOSITE", next, flip: opts.canFlip && opts.tradable && !pastCutoff(opts.hh, opts.mm) };
  const midOn = opts.midOn ?? CD_DEFAULTS.midStop;
  if (
    midOn &&
    typeof opts.spot === "number" &&
    typeof opts.mid === "number" &&
    opts.mid > 0 &&
    ((opts.side === "CE" && opts.spot >= opts.mid) || (opts.side === "PE" && opts.spot <= opts.mid))
  ) {
    return { kind: "MID" };
  }
  const ltp = opts.ltp;
  const sold = opts.sold;
  if (!(typeof ltp === "number" && ltp > 0) || !(sold > 0)) {
    return { kind: "NONE", armTrail: opts.trailArmed };
  }
  if (ltp + 1e-9 >= stopPx(sold, slPct)) return { kind: "SL" };
  if (ltp <= targetPx(sold, targetPct) + 1e-9) return { kind: "TARGET" };
  if (opts.trailArmed && ltp + 1e-9 >= trailStopPx(sold, trailLockPct)) return { kind: "TRAIL" };
  if (ltp <= trailArmPx(sold, trailArmPct) + 1e-9) return { kind: "NONE", armTrail: true };
  return { kind: "NONE", armTrail: opts.trailArmed };
}

export type LogKind = "info" | "entry" | "exit" | "error";

export function badPremiumTick(fill: number, premium: number): boolean {
  return fill >= 5 && premium < 0.5;
}

function roundMoney(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

export function shortMtm(fill: number, premium: number, qty: number): number {
  return roundMoney((fill - premium) * qty);
}

export function signedPts(points: number): string {
  const body = Math.abs(points).toFixed(2);
  if (points > 0) return `+${body}`;
  if (points < 0) return `-${body}`;
  return body;
}
