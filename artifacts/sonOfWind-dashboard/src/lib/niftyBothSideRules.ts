/**
 * NIFTY Ladder Both Side (profile id: bothside).
 * Short-premium grid on ONE CE/PE — scale BOTH ways (T-A up, T-B down).
 * Independent of Nifty Ladder and Nifty Snake. Do not import those files.
 */

export const PROFILE_ID = "bothside";
export const UNDERLYING = "NIFTY";
export const BAND_LOW = 98;
export const BAND_HIGH = 105;
export const BAND_TARGET = 100;
export const STEP_PTS = 3;
export const T1_COVER_PCT = 0.3;
export const HARD_SL_PCT = 0.3;
export const ENTRY_MINUTE = 9 * 60 + 16;
export const EOD_MINUTE = 15 * 60 + 15;
export const LOT_SIZE = 65;
export const T1_LOTS = 8;
/** Extra lots by index 1..8; past 8 repeats last (4). */
export const EXTRA_LOTS = [2, 2, 2, 2, 3, 3, 4, 4] as const;
export const UI_EXTRA_COUNT = 4;
export const CAP_LOTS_1X = 30;
export const SIZE_MULTS = [1, 2, 3] as const;
export const MANUAL_STRIKE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
export const MAX_PLAN_TICKS = 48;
export const BOTHSIDE_CLOCK_MS = 25;
export const ROUND_TRIP_COST_PER_LOT = 25;
export const HEDGE_LOW = 3;
export const HEDGE_HIGH = 4;
export const HEDGE_TARGET = 3.5;
/** Auto long-hedge BUY. false = shorts only, no hedge legs. */
export const ENABLE_HEDGES = false;
export const MAX_EXTRA_INDEX = 64;

export const BOTHSIDE_STORE_KEY = "sow_nifty_bothside_v1";
export const BOTHSIDE_SIZE_STORE_KEY = "sow_nifty_bothside_size_v1";
export const EV_NIFTY_BOTHSIDE_FLAT = "sow:nifty_bothside_flat";

export type OptionType = "CE" | "PE";
export type EntryMode = "auto" | "manual";
export type ManualStrikeOffset = (typeof MANUAL_STRIKE_OFFSETS)[number];
export type SizeMult = (typeof SIZE_MULTS)[number];
export type SlotArm = "T1" | "A" | "B";
export type OpenDriveBias = "UP" | "DOWN" | "FLAT";
export type HedgeWindowId = "T1" | "A4" | "A7" | "B4" | "B7" | string;

export type BothSideSlot = {
  key: string;
  arm: SlotArm;
  /** 0 for T1; 1+ for T-A / T-B */
  index: number;
  lots: number;
  open: boolean;
  fill: number | null;
};

export type BothSideHedge = {
  window: HedgeWindowId;
  covers: string;
  lots: number;
  strike: number | null;
  iid: number | null;
  open: boolean;
  fill: number | null;
};

export type ChainPremiumRow = {
  strike: number;
  call_ltp: number | null;
  put_ltp: number | null;
};

export type HuntPick = {
  strike: number;
  ltp: number;
  optionType: OptionType;
};

export type BothSideEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  entryMode: EntryMode;
  manualStrikeOffset: ManualStrikeOffset;
  armed: boolean;
  awaitRestart: boolean;
  awaitResell: boolean;
  /** Slot keys open when hard SL flattened. */
  resellLegs: string[];
  slFlattening: boolean;
  /** Hard SL price used for flatten / re-SELL gate. */
  hardSlPx: number | null;
  slots: BothSideSlot[];
  /** Grid origin F. Updated when T1 is (re)filled. */
  t1Fill: number | null;
  strike: number | null;
  hedges: BothSideHedge[];
  gross: number;
  expense: number;
  roundTrips: number;
  peakLots: number;
  peakA: number;
  peakB: number;
};

export type BothSideAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; key: string; arm: "A" | "B"; index: number; lots: number }
  | { kind: "resell"; key: string; lots: number }
  | { kind: "book"; key: string; lots: number; reason: string }
  | { kind: "stop"; reason: string };

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitResell: boolean;
  resellLegs: string[];
  hardSlPx: number | null;
  t1Fill: number | null;
  slots: BothSideSlot[];
  ltp: number | null;
  huntPick: HuntPick | null;
  sizeMult: SizeMult;
  entryMode?: EntryMode;
  /** Same-cycle hard-SL flatten: do not add legs until this burst ends. */
  suppressAdds?: boolean;
};

function istParts(nowMs: number): { hh: number; mm: number; y: number; mo: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const num = (t: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === t)?.value ?? "0");
    return { y: num("year"), mo: num("month"), d: num("day"), hh: num("hour"), mm: num("minute") };
  } catch {
    const d = new Date(nowMs);
    return {
      y: d.getFullYear(),
      mo: d.getMonth() + 1,
      d: d.getDate(),
      hh: d.getHours(),
      mm: d.getMinutes(),
    };
  }
}

export function istMinuteOfDay(nowMs: number = Date.now()): number {
  const { hh, mm } = istParts(nowMs);
  return hh * 60 + mm;
}

export function istCalendarDay(nowMs: number = Date.now()): string {
  const { y, mo, d } = istParts(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export function formatIstTime(nowMs: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toLocaleTimeString("en-IN", { hour12: false });
  }
}

export function isEntryWindow(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= ENTRY_MINUTE;
}

export function isEod(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= EOD_MINUTE;
}

export function qtyForLots(lots: number): number {
  return Math.max(1, Math.floor(lots) * LOT_SIZE);
}

export function asSizeMult(raw: unknown): SizeMult {
  const n = Number(raw);
  return n === 2 || n === 3 ? n : 1;
}

export function capLots(mult: SizeMult = 1): number {
  return CAP_LOTS_1X * asSizeMult(mult);
}

export function slotKey(arm: SlotArm, index: number): string {
  if (arm === "T1") return "T1";
  return `${arm}${index}`;
}

export function labelForKey(key: string): string {
  if (key === "T1") return "T1";
  if (key.startsWith("A")) return `T-A${key.slice(1)}`;
  if (key.startsWith("B")) return `T-B${key.slice(1)}`;
  return key;
}

export function baseLotsForExtra(index: number): number {
  if (index < 1) return 0;
  if (index <= EXTRA_LOTS.length) return EXTRA_LOTS[index - 1] ?? 4;
  return EXTRA_LOTS[EXTRA_LOTS.length - 1] ?? 4;
}

export function lotsForExtra(index: number, mult: SizeMult = 1): number {
  return baseLotsForExtra(index) * asSizeMult(mult);
}

export function lotsForT1(mult: SizeMult = 1): number {
  return T1_LOTS * asSizeMult(mult);
}

export function sellLevelA(t1Fill: number, index: number, gap: number = STEP_PTS): number {
  return t1Fill + gap * index;
}

export function sellLevelB(t1Fill: number, index: number, gap: number = STEP_PTS): number {
  return t1Fill - gap * index;
}

export function bookLevelA(entry: number, gap: number = STEP_PTS): number {
  return entry - gap;
}

/** T-B books at entry − (G+1). Gap 3 → −4. */
export function bookLevelB(entry: number, gap: number = STEP_PTS): number {
  return entry - (gap + 1);
}

export function plannedEntry(t1Fill: number, arm: "A" | "B", index: number, gap: number = STEP_PTS): number {
  return arm === "A" ? sellLevelA(t1Fill, index, gap) : sellLevelB(t1Fill, index, gap);
}

export function plannedBook(t1Fill: number, arm: "A" | "B", index: number, gap: number = STEP_PTS): number {
  const entry = plannedEntry(t1Fill, arm, index, gap);
  return arm === "A" ? bookLevelA(entry, gap) : bookLevelB(entry, gap);
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * (1 - T1_COVER_PCT);
}

export function hardSlFromBase(base: number): number {
  return base * (1 + HARD_SL_PCT);
}

/** Cheapest OPEN fill (T-B can undercut T1). */
export function cheapestOpenFill(slots: BothSideSlot[]): number | null {
  let best: number | null = null;
  for (const s of slots) {
    if (!s.open || s.fill == null || !(s.fill > 0)) continue;
    if (best == null || s.fill < best) best = s.fill;
  }
  return best;
}

export function hardSlPrice(slots: BothSideSlot[], fallbackT1: number | null = null): number | null {
  const base = cheapestOpenFill(slots) ?? (fallbackT1 != null && fallbackT1 > 0 ? fallbackT1 : null);
  if (base == null || !(base > 0)) return null;
  return hardSlFromBase(base);
}

export function inPremiumBand(ltp: number | null | undefined): boolean {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp >= BAND_LOW && ltp <= BAND_HIGH;
}

export function netRealized(state: Pick<BothSideEngineState, "gross" | "expense">): number {
  return roundMoney(state.gross - state.expense);
}

export function openDriveFromBar(
  open: number,
  close: number,
): { bias: OpenDriveBias; suggest: OptionType | null } {
  if (!(Number.isFinite(open) && Number.isFinite(close))) {
    return { bias: "FLAT", suggest: null };
  }
  if (close > open) return { bias: "UP", suggest: "PE" };
  if (close < open) return { bias: "DOWN", suggest: "CE" };
  return { bias: "FLAT", suggest: null };
}

/** Hedge windows: T1 covers T1+A1+A2; A4/A7/… and B4/B7/… cover self + next 2. */
export function hedgeWindowForLeg(arm: SlotArm, index: number): HedgeWindowId | null {
  if (arm === "T1") return "T1";
  if (arm === "A" && index >= 4 && (index - 4) % 3 === 0) return `A${index}`;
  if (arm === "B" && index >= 4 && (index - 4) % 3 === 0) return `B${index}`;
  return null;
}

export function hedgeLotsForWindow(window: HedgeWindowId, mult: SizeMult = 1): number {
  const m = asSizeMult(mult);
  if (window === "T1") {
    return (T1_LOTS + baseLotsForExtra(1) + baseLotsForExtra(2)) * m;
  }
  const arm = window.startsWith("A") ? "A" : window.startsWith("B") ? "B" : null;
  const start = Number(window.slice(1));
  if (!arm || !Number.isFinite(start) || start < 1) return 0;
  return (baseLotsForExtra(start) + baseLotsForExtra(start + 1) + baseLotsForExtra(start + 2)) * m;
}

export function hedgeCoverLabel(window: HedgeWindowId): string {
  if (window === "T1") return "T1 + T-A1 + T-A2";
  const arm = window.startsWith("A") ? "A" : window.startsWith("B") ? "B" : null;
  const start = Number(window.slice(1));
  if (!arm || !Number.isFinite(start)) return window;
  const prefix = arm === "A" ? "T-A" : "T-B";
  return `${prefix}${start}–${prefix}${start + 2}`;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeSlot(arm: SlotArm, index: number, mult: SizeMult): BothSideSlot {
  const lots = arm === "T1" ? lotsForT1(mult) : lotsForExtra(index, mult);
  return {
    key: slotKey(arm, index),
    arm,
    index: arm === "T1" ? 0 : index,
    lots,
    open: false,
    fill: null,
  };
}

export function emptySlots(mult: SizeMult = 1): BothSideSlot[] {
  const m = asSizeMult(mult);
  const slots: BothSideSlot[] = [makeSlot("T1", 0, m)];
  for (let i = 1; i <= UI_EXTRA_COUNT; i++) {
    slots.push(makeSlot("A", i, m));
    slots.push(makeSlot("B", i, m));
  }
  return slots;
}

export function applySizeToEmptySlots(slots: BothSideSlot[], mult: SizeMult): BothSideSlot[] {
  const m = asSizeMult(mult);
  return slots.map((s) => {
    if (s.open) return s;
    const lots = s.arm === "T1" ? lotsForT1(m) : lotsForExtra(s.index, m);
    return { ...s, lots };
  });
}

export function emptyHedges(): BothSideHedge[] {
  return [];
}

export function cloneSlots(slots: BothSideSlot[]): BothSideSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function cloneHedges(hedges: BothSideHedge[]): BothSideHedge[] {
  return hedges.map((h) => ({ ...h }));
}

export function isInTrade(slots: BothSideSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.key === "T1");
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function hedgesOpen(state: Pick<BothSideEngineState, "hedges">): boolean {
  return state.hedges.some((h) => h.open);
}

export function openLots(slots: BothSideSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function canAddLots(slots: BothSideSlot[], nextLots: number, mult: SizeMult): boolean {
  return openLots(slots) + nextLots <= capLots(mult) + 1e-9;
}

export function avgFill(slots: BothSideSlot[]): number | null {
  let lotSum = 0;
  let pxSum = 0;
  for (const s of slots) {
    if (!s.open || s.fill == null || !(s.fill > 0) || s.lots <= 0) continue;
    lotSum += s.lots;
    pxSum += s.fill * s.lots;
  }
  if (lotSum <= 0) return null;
  return pxSum / lotSum;
}

export function openMtm(avg: number | null, liveLtp: number | null, lots: number): number | null {
  if (avg == null || liveLtp == null || !(avg > 0) || !(liveLtp > 0) || lots <= 0) return null;
  return (avg - liveLtp) * lots * LOT_SIZE;
}

export function shortBookPnl(entryFill: number, exitFill: number, lots: number): number {
  return (entryFill - exitFill) * lots * LOT_SIZE;
}

export function slotByKey(slots: BothSideSlot[], key: string): BothSideSlot | undefined {
  return slots.find((s) => s.key === key);
}

function maxOpenIndex(slots: BothSideSlot[], arm: "A" | "B"): number {
  let max = 0;
  for (const s of slots) {
    if (s.arm !== arm) continue;
    if (s.index > max) max = s.index;
  }
  return max;
}

/** Ensure next empty extra slot exists (grows past A4/B4 / A8/B8). */
export function ensureExtraSlot(slots: BothSideSlot[], arm: "A" | "B", index: number, mult: SizeMult): BothSideSlot[] {
  if (index < 1 || index > MAX_EXTRA_INDEX) return slots;
  const key = slotKey(arm, index);
  if (slots.some((s) => s.key === key)) return slots;
  return [...slots, makeSlot(arm, index, mult)];
}

export function nextEmptyExtra(slots: BothSideSlot[], arm: "A" | "B", mult: SizeMult): BothSideSlot | null {
  const t1 = slotByKey(slots, "T1");
  if (!t1?.open) return null;
  const existing = slots
    .filter((s) => s.arm === arm)
    .sort((a, b) => a.index - b.index);
  for (const s of existing) {
    if (!s.open) return s;
  }
  const growTo = Math.max(maxOpenIndex(slots, arm) + 1, UI_EXTRA_COUNT + 1);
  if (growTo > MAX_EXTRA_INDEX) return null;
  return makeSlot(arm, growTo, asSizeMult(mult));
}

/** UI rows: always T1 + A1..A4 + B1..B4; later extras only if present (filled / grown). */
export function visibleSlots(slots: BothSideSlot[]): BothSideSlot[] {
  const t1 = slots.find((s) => s.key === "T1");
  const as = slots.filter((s) => s.arm === "A").sort((a, b) => a.index - b.index);
  const bs = slots.filter((s) => s.arm === "B").sort((a, b) => a.index - b.index);
  const showA = as.filter((s) => s.index <= UI_EXTRA_COUNT || s.open || s.fill != null);
  const showB = bs.filter((s) => s.index <= UI_EXTRA_COUNT || s.open || s.fill != null);
  // keep empty A5+ only if any higher exists as open
  const out: BothSideSlot[] = [];
  if (t1) out.push(t1);
  out.push(...showA);
  out.push(...showB);
  return out;
}

function highestOpenOverall(slots: BothSideSlot[]): BothSideSlot | null {
  let best: BothSideSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best) {
      best = s;
      continue;
    }
    const score = (x: BothSideSlot) => (x.arm === "T1" ? 0 : x.index * 10 + (x.arm === "A" ? 2 : 1));
    if (score(s) > score(best)) best = s;
  }
  return best;
}

function highestOpenExtra(slots: BothSideSlot[]): BothSideSlot | null {
  let best: BothSideSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.arm === "T1") continue;
    if (!best) {
      best = s;
      continue;
    }
    if (s.index > best.index) best = s;
    else if (s.index === best.index && s.arm === "A" && best.arm === "B") best = s;
  }
  return best;
}

function extraBookHit(slot: BothSideSlot, ltp: number): boolean {
  if (slot.fill == null || !(slot.fill > 0)) return false;
  const book = slot.arm === "A" ? bookLevelA(slot.fill) : bookLevelB(slot.fill);
  return ltp <= book + 1e-9;
}

/** Among open extras whose book is hit, pick highest index (A before B on tie). */
function nextBookExtra(slots: BothSideSlot[], ltp: number): BothSideSlot | null {
  const hits = slots.filter((s) => s.open && s.arm !== "T1" && extraBookHit(s, ltp));
  if (!hits.length) return null;
  hits.sort((a, b) => {
    if (b.index !== a.index) return b.index - a.index;
    if (a.arm === b.arm) return 0;
    return a.arm === "A" ? -1 : 1;
  });
  return hits[0] ?? null;
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: BothSideSlot, reason: string): BothSideAction {
  return { kind: "book", key: slot.key, lots: slot.lots, reason };
}

export function isHardSlReason(reason: string): boolean {
  return reason.toUpperCase().includes("HARD SL");
}

export function isCoverReason(reason: string): boolean {
  const u = reason.toUpperCase();
  return u.includes("COVER") || u.includes("30%");
}

function sideLtp(row: ChainPremiumRow, optionType: OptionType): number | null {
  const raw = optionType === "CE" ? row.call_ltp : row.put_ltp;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function sortNearTarget(a: HuntPick, b: HuntPick, optionType: OptionType): number {
  const da = Math.abs(a.ltp - BAND_TARGET);
  const db = Math.abs(b.ltp - BAND_TARGET);
  if (da !== db) return da - db;
  // tie → more OTM
  return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
}

export function pickNear100(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
  const candidates: HuntPick[] = [];
  for (const row of rows) {
    const ltp = sideLtp(row, optionType);
    if (ltp == null || !inPremiumBand(ltp)) continue;
    candidates.push({ strike: row.strike, ltp, optionType });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => sortNearTarget(a, b, optionType));
  return candidates[0] ?? null;
}

export function closestTo100(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
  const candidates: HuntPick[] = [];
  for (const row of rows) {
    const ltp = sideLtp(row, optionType);
    if (ltp == null) continue;
    candidates.push({ strike: row.strike, ltp, optionType });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => sortNearTarget(a, b, optionType));
  return candidates[0] ?? null;
}

export function manualStrikeLabel(offset: ManualStrikeOffset): string {
  if (offset === 0) return "ATM";
  return offset > 0 ? `ATM + ${offset}` : `ATM − ${Math.abs(offset)}`;
}

export function resolveManualStrike(
  atmStrike: number,
  step: number,
  offset: ManualStrikeOffset,
): number {
  const s = Number.isFinite(step) && step > 0 ? step : 50;
  return atmStrike + offset * s;
}

export function pickManualStrike(
  rows: ChainPremiumRow[],
  optionType: OptionType,
  atmStrike: number,
  step: number,
  offset: ManualStrikeOffset,
): HuntPick | null {
  if (!(Number.isFinite(atmStrike) && atmStrike > 0)) return null;
  const target = resolveManualStrike(atmStrike, step, offset);
  let row = rows.find((r) => r.strike === target);
  if (!row && rows.length) {
    row = rows.reduce((best, r) =>
      Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best,
    );
  }
  if (!row) return null;
  const ltp = sideLtp(row, optionType);
  if (ltp == null) return null;
  return { strike: row.strike, ltp, optionType };
}

export function pickCheapHedge(
  rows: ChainPremiumRow[],
  optionType: OptionType,
  avoidStrike: number | null,
): HuntPick | null {
  const candidates: HuntPick[] = [];
  for (const row of rows) {
    if (avoidStrike != null && row.strike === avoidStrike) continue;
    const ltp = sideLtp(row, optionType);
    if (ltp == null || ltp < HEDGE_LOW || ltp > HEDGE_HIGH) continue;
    candidates.push({ strike: row.strike, ltp, optionType });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const da = Math.abs(a.ltp - HEDGE_TARGET);
    const db = Math.abs(b.ltp - HEDGE_TARGET);
    if (da !== db) return da - db;
    return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
  });
  return candidates[0] ?? null;
}

function nextResellSlot(slots: BothSideSlot[], legs: string[]): BothSideSlot | null {
  const order = [...legs];
  order.sort((a, b) => {
    if (a === "T1") return -1;
    if (b === "T1") return 1;
    const ai = Number(a.slice(1)) || 0;
    const bi = Number(b.slice(1)) || 0;
    if (ai !== bi) return ai - bi;
    return a < b ? -1 : 1;
  });
  for (const key of order) {
    const slot = slotByKey(slots, key);
    if (slot && !slot.open) return slot;
  }
  return null;
}

/**
 * ONE next action. Caller loops until null.
 * Priority: EOD → hard SL flatten → T1 cover path → T-A add → T-B add → extra book → re-SELL → hunt.
 */
export function planTick(input: PlanTickInput): BothSideAction | null {
  const {
    nowMs,
    armed,
    awaitRestart,
    awaitResell,
    resellLegs,
    hardSlPx,
    t1Fill,
    slots,
    ltp,
    huntPick,
    sizeMult,
    entryMode = "auto",
  } = input;
  const trading = isInTrade(slots, t1Fill);
  const mult = asSizeMult(sizeMult);

  if (isEod(nowMs)) {
    const hi = highestOpenOverall(slots);
    if (hi) return bookAction(hi, `EOD 15:15 · ${labelForKey(hi.key)}`);
    if (awaitResell) return { kind: "stop", reason: "EOD 15:15 — re-SELL cancelled" };
    return null;
  }

  if (trading && validLtp(ltp)) {
    const sl = hardSlPrice(slots, t1Fill);
    if (sl != null && ltp >= sl - 1e-9) {
      const hi = highestOpenOverall(slots);
      if (hi) return bookAction(hi, `HARD SL +30% · flatten ${labelForKey(hi.key)}`);
    }
  }

  if (!trading) {
    if (awaitResell && hardSlPx != null && hardSlPx > 0) {
      if (!armed) return null;
      if (!validLtp(ltp) || ltp >= hardSlPx - 1e-9) return null;
      const next = nextResellSlot(slots, resellLegs);
      if (next) return { kind: "resell", key: next.key, lots: next.lots };
      return null;
    }
    if (!armed || awaitRestart) return null;
    if (!isEntryWindow(nowMs)) return null;
    if (!huntPick) return null;
    if (entryMode !== "manual" && !inPremiumBand(huntPick.ltp)) return null;
    return { kind: "enter_t1", pick: huntPick };
  }

  if (!validLtp(ltp) || t1Fill == null || !(t1Fill > 0)) return null;

  if (ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) return bookAction(extra, `T1 30% path · book ${labelForKey(extra.key)} first`);
    const t1 = slotByKey(slots, "T1");
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  // Adds before books (armed only). Spike can fill several T-A; dump several T-B.
  // Hard-SL burst must finish flat before any new add. Re-SELL is the re-entry.
  if (armed && !input.suppressAdds) {
    const nextA = nextEmptyExtra(slots, "A", mult);
    if (nextA) {
      const working = slots.some((s) => s.key === nextA.key) ? slots : ensureExtraSlot(slots, "A", nextA.index, mult);
      const slot = slotByKey(working, nextA.key) ?? nextA;
      const entry = plannedEntry(t1Fill, "A", slot.index);
      if (ltp + 1e-9 >= entry && canAddLots(working, slot.lots, mult)) {
        return { kind: "add", key: slot.key, arm: "A", index: slot.index, lots: slot.lots };
      }
    }
    const nextB = nextEmptyExtra(slots, "B", mult);
    if (nextB) {
      const working = slots.some((s) => s.key === nextB.key) ? slots : ensureExtraSlot(slots, "B", nextB.index, mult);
      const slot = slotByKey(working, nextB.key) ?? nextB;
      const entry = plannedEntry(t1Fill, "B", slot.index);
      if (ltp <= entry + 1e-9 && canAddLots(working, slot.lots, mult)) {
        return { kind: "add", key: slot.key, arm: "B", index: slot.index, lots: slot.lots };
      }
    }
  }

  const bookExtra = nextBookExtra(slots, ltp);
  if (bookExtra) {
    return bookAction(
      bookExtra,
      bookExtra.arm === "A"
        ? `${labelForKey(bookExtra.key)} −${STEP_PTS}`
        : `${labelForKey(bookExtra.key)} −${STEP_PTS + 1}`,
    );
  }

  if (awaitResell && armed && hardSlPx != null && hardSlPx > 0) {
    if (ltp >= hardSlPx - 1e-9) return null;
    const next = nextResellSlot(slots, resellLegs);
    if (next) return { kind: "resell", key: next.key, lots: next.lots };
  }

  return null;
}

export function nextSquareAllAction(slots: BothSideSlot[]): BothSideAction | null {
  const hi = highestOpenOverall(slots);
  if (!hi) return null;
  return bookAction(hi, "SQUARE ALL");
}

function withPeak(state: BothSideEngineState, slots: BothSideSlot[]): BothSideEngineState {
  const lots = openLots(slots);
  let peakA = state.peakA;
  let peakB = state.peakB;
  for (const s of slots) {
    if (!s.open) continue;
    if (s.arm === "A") peakA = Math.max(peakA, s.index);
    if (s.arm === "B") peakB = Math.max(peakB, s.index);
  }
  return {
    ...state,
    slots,
    peakLots: Math.max(state.peakLots, lots),
    peakA,
    peakB,
  };
}

function addRoundTrip(
  state: BothSideEngineState,
  entry: number,
  exit: number,
  lots: number,
  side: "short" | "long",
): BothSideEngineState {
  const gross =
    side === "short" ? shortBookPnl(entry, exit, lots) : (exit - entry) * lots * LOT_SIZE;
  return {
    ...state,
    gross: roundMoney(state.gross + gross),
    expense: roundMoney(state.expense + ROUND_TRIP_COST_PER_LOT * lots),
    roundTrips: state.roundTrips + lots,
  };
}

export function idleEngineState(
  optionType: OptionType = "CE",
  sizeMult: SizeMult = loadBothSideSize(),
  entryMode: EntryMode = "auto",
  manualStrikeOffset: ManualStrikeOffset = 0,
): BothSideEngineState {
  const mult = asSizeMult(sizeMult);
  const mode: EntryMode = entryMode === "manual" ? "manual" : "auto";
  const offset = MANUAL_STRIKE_OFFSETS.includes(manualStrikeOffset) ? manualStrikeOffset : 0;
  return {
    optionType,
    sizeMult: mult,
    entryMode: mode,
    manualStrikeOffset: offset,
    armed: false,
    awaitRestart: false,
    awaitResell: false,
    resellLegs: [],
    slFlattening: false,
    hardSlPx: null,
    slots: emptySlots(mult),
    t1Fill: null,
    strike: null,
    hedges: emptyHedges(),
    gross: 0,
    expense: 0,
    roundTrips: 0,
    peakLots: 0,
    peakA: 0,
    peakB: 0,
  };
}

function clearedShort(state: BothSideEngineState, awaitRestart: boolean): BothSideEngineState {
  return {
    ...state,
    armed: false,
    awaitRestart,
    awaitResell: false,
    resellLegs: [],
    slFlattening: false,
    hardSlPx: null,
    slots: emptySlots(state.sizeMult),
    t1Fill: null,
    strike: null,
  };
}

export function uiReset(state: BothSideEngineState): BothSideEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

export function applyFilledAction(
  state: BothSideEngineState,
  action: BothSideAction,
  fillPx: number,
): BothSideEngineState {
  let slots = cloneSlots(state.slots);

  if (action.kind === "stop") {
    const eod = action.reason.toUpperCase().includes("EOD");
    return clearedShort(state, !eod);
  }

  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.key === "T1");
    if (t1) {
      t1.open = true;
      t1.fill = fillPx;
    }
    return withPeak(
      {
        ...state,
        t1Fill: fillPx,
        strike: action.pick.strike,
        optionType: action.pick.optionType,
        awaitRestart: false,
        awaitResell: false,
        resellLegs: [],
        slFlattening: false,
        hardSlPx: null,
      },
      slots,
    );
  }

  if (action.kind === "add") {
    slots = ensureExtraSlot(slots, action.arm, action.index, state.sizeMult);
    const slot = slots.find((s) => s.key === action.key);
    if (slot) {
      slot.open = true;
      slot.fill = fillPx;
      slot.lots = action.lots;
    }
    return withPeak({ ...state, slFlattening: false }, slots);
  }

  if (action.kind === "resell") {
    const slot = slots.find((s) => s.key === action.key);
    if (slot) {
      slot.open = true;
      slot.fill = fillPx;
    }
    const resellLegs = state.resellLegs.filter((key) => {
      const s = slots.find((row) => row.key === key);
      return s ? !s.open : false;
    });
    const awaitResell = resellLegs.length > 0;
    const t1Fill = action.key === "T1" ? fillPx : state.t1Fill;
    return withPeak(
      {
        ...state,
        t1Fill,
        resellLegs,
        awaitResell,
        slFlattening: false,
        hardSlPx: awaitResell ? state.hardSlPx : null,
      },
      slots,
    );
  }

  const slot = slots.find((s) => s.key === action.key);
  const entry = slot?.fill ?? null;
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  let next: BothSideEngineState =
    entry != null && entry > 0 && fillPx > 0
      ? addRoundTrip({ ...state, slots }, entry, fillPx, action.lots, "short")
      : { ...state, slots };
  next.slots = slots;

  if (isHardSlReason(action.reason)) {
    const resellLegs = state.slFlattening
      ? state.resellLegs
      : state.slots
          .filter((s) => s.open)
          .map((s) => s.key)
          .sort((a, b) => {
            if (a === "T1") return -1;
            if (b === "T1") return 1;
            return a.localeCompare(b);
          });
    const stillOpen = slots.some((s) => s.open);
    const slPx =
      state.hardSlPx != null && state.hardSlPx > 0
        ? state.hardSlPx
        : hardSlPrice(state.slots, state.t1Fill);
    return {
      ...next,
      slots,
      resellLegs,
      slFlattening: stillOpen,
      awaitResell: !stillOpen && resellLegs.length > 0,
      awaitRestart: false,
      hardSlPx: slPx,
    };
  }

  if (action.key === "T1") {
    return {
      ...clearedShort(next, isCoverReason(action.reason)),
      slots: emptySlots(next.sizeMult),
      gross: next.gross,
      expense: next.expense,
      roundTrips: next.roundTrips,
      peakLots: next.peakLots,
      peakA: next.peakA,
      peakB: next.peakB,
      hedges: next.hedges,
    };
  }

  return { ...next, slots, slFlattening: false };
}

export function applyHedgeOpen(
  state: BothSideEngineState,
  window: HedgeWindowId,
  strike: number,
  iid: number,
  fillPx: number,
): BothSideEngineState {
  const hedges = cloneHedges(state.hedges);
  let row = hedges.find((h) => h.window === window);
  if (!row) {
    row = {
      window,
      covers: hedgeCoverLabel(window),
      lots: hedgeLotsForWindow(window, state.sizeMult),
      strike: null,
      iid: null,
      open: false,
      fill: null,
    };
    hedges.push(row);
  }
  row.open = true;
  row.strike = strike;
  row.iid = iid;
  row.fill = fillPx;
  row.lots = hedgeLotsForWindow(window, state.sizeMult);
  row.covers = hedgeCoverLabel(window);
  return { ...state, hedges };
}

export function applyHedgeClose(
  state: BothSideEngineState,
  window: HedgeWindowId,
  exitPx: number,
): BothSideEngineState {
  const hedges = cloneHedges(state.hedges);
  const row = hedges.find((h) => h.window === window);
  if (!row?.open || row.fill == null || !(row.fill > 0) || !(exitPx > 0)) {
    if (row) {
      row.open = false;
      row.fill = null;
    }
    return { ...state, hedges };
  }
  const next = addRoundTrip({ ...state, hedges }, row.fill, exitPx, row.lots, "long");
  const closed = cloneHedges(next.hedges);
  const target = closed.find((h) => h.window === window);
  if (target) {
    target.open = false;
    target.fill = null;
  }
  return { ...next, hedges: closed };
}

export function closeAllHedges(state: BothSideEngineState, exitPx: number): BothSideEngineState {
  let next = state;
  for (const h of state.hedges) {
    if (h.open) next = applyHedgeClose(next, h.window, exitPx);
  }
  return next;
}

export function externalShortFlat(state: BothSideEngineState): BothSideEngineState {
  return clearedShort(state, true);
}

export function localNewDayReset(state: BothSideEngineState): BothSideEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

/** Persist while armed, re-SELL wait, SL flatten, or still in trade. Clear when position book is flat. */
export function bothSidePositionActive(state: BothSideEngineState): boolean {
  return Boolean(
    state.armed ||
      state.awaitResell ||
      state.slFlattening ||
      isInTrade(state.slots, state.t1Fill),
  );
}

export type BothSideLogKind = "info" | "entry" | "exit" | "warn";

export type BothSidePersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: BothSideLogKind;
};

export type BothSidePersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: BothSideEngineState;
  logs: BothSidePersistedLog[];
  nextLogId: number;
};

const LOG_KINDS = new Set<BothSideLogKind>(["info", "entry", "exit", "warn"]);

function readStoreRaw(): string | null {
  try {
    const s = sessionStorage.getItem(BOTHSIDE_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(BOTHSIDE_STORE_KEY);
  } catch {
    return null;
  }
}

function writeStoreRaw(raw: string): void {
  try {
    sessionStorage.setItem(BOTHSIDE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(BOTHSIDE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeStoreRaw(): void {
  try {
    sessionStorage.removeItem(BOTHSIDE_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(BOTHSIDE_STORE_KEY);
  } catch {
    /* ignore */
  }
}

function sanitizeIid(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function readSizeRaw(): string | null {
  try {
    const s = sessionStorage.getItem(BOTHSIDE_SIZE_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(BOTHSIDE_SIZE_STORE_KEY);
  } catch {
    return null;
  }
}

export function loadBothSideSize(): SizeMult {
  try {
    const raw = readSizeRaw();
    if (!raw) return 1;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "sizeMult" in parsed) {
      return asSizeMult((parsed as { sizeMult?: unknown }).sizeMult);
    }
    return asSizeMult(parsed);
  } catch {
    return 1;
  }
}

export function persistBothSideSize(sizeMult: SizeMult): void {
  const raw = JSON.stringify({ sizeMult: asSizeMult(sizeMult) });
  try {
    sessionStorage.setItem(BOTHSIDE_SIZE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(BOTHSIDE_SIZE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function sanitizeSlot(raw: unknown, mult: SizeMult): BothSideSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const arm: SlotArm | null =
    rec.arm === "T1" || rec.arm === "A" || rec.arm === "B" ? rec.arm : null;
  if (!arm) return null;
  const index = arm === "T1" ? 0 : Math.floor(Number(rec.index));
  if (arm !== "T1" && (!Number.isFinite(index) || index < 1 || index > MAX_EXTRA_INDEX)) return null;
  const key = typeof rec.key === "string" ? rec.key : slotKey(arm, index);
  const open = Boolean(rec.open);
  const fillRaw = rec.fill;
  const fill =
    typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
  if (open && fill == null) return null;
  const expected = arm === "T1" ? lotsForT1(mult) : lotsForExtra(index, mult);
  const lotsRaw = Math.floor(Number(rec.lots));
  const lots =
    lotsRaw === expected || lotsRaw === expected / 2 || lotsRaw === expected / 3
      ? expected
      : Number.isFinite(lotsRaw) && lotsRaw > 0
        ? lotsRaw
        : expected;
  return { key, arm, index, lots: open ? lots : expected, open, fill: open ? fill : null };
}

function sanitizeSlots(raw: unknown, mult: SizeMult): BothSideSlot[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const slots: BothSideSlot[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const s = sanitizeSlot(row, mult);
    if (!s || seen.has(s.key)) continue;
    seen.add(s.key);
    slots.push(s);
  }
  if (!slots.some((s) => s.key === "T1")) return null;
  // ensure UI base extras
  let out = slots;
  for (let i = 1; i <= UI_EXTRA_COUNT; i++) {
    if (!out.some((s) => s.key === slotKey("A", i))) out = ensureExtraSlot(out, "A", i, mult);
    if (!out.some((s) => s.key === slotKey("B", i))) out = ensureExtraSlot(out, "B", i, mult);
  }
  return out;
}

function sanitizeLogs(raw: unknown): BothSidePersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: BothSidePersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as BothSideLogKind) ? (rec.kind as BothSideLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 80) break;
  }
  return out;
}

function finiteNonNeg(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function sanitizeBothSideEngine(raw: unknown): BothSideEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const optionType: OptionType | null =
    rec.optionType === "CE" || rec.optionType === "PE" ? rec.optionType : null;
  if (!optionType) return null;
  const sizeMult = asSizeMult(rec.sizeMult);
  const entryMode: EntryMode = rec.entryMode === "manual" ? "manual" : "auto";
  const manualStrikeOffset = MANUAL_STRIKE_OFFSETS.includes(rec.manualStrikeOffset as ManualStrikeOffset)
    ? (rec.manualStrikeOffset as ManualStrikeOffset)
    : 0;
  const slots = sanitizeSlots(rec.slots, sizeMult);
  if (!slots) return null;
  const t1 = slots.find((s) => s.key === "T1");
  const t1FillRaw = rec.t1Fill;
  let t1Fill =
    typeof t1FillRaw === "number" && Number.isFinite(t1FillRaw) && t1FillRaw > 0 ? t1FillRaw : null;
  if (t1?.open && t1.fill != null) t1Fill = t1Fill ?? t1.fill;
  const strikeRaw = rec.strike;
  const strike =
    typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw : null;
  const hardSlRaw = rec.hardSlPx;
  const hardSlPx =
    typeof hardSlRaw === "number" && Number.isFinite(hardSlRaw) && hardSlRaw > 0 ? hardSlRaw : null;
  const resellLegs = Array.isArray(rec.resellLegs)
    ? rec.resellLegs.filter((k): k is string => typeof k === "string" && k.length > 0)
    : [];
  const engine: BothSideEngineState = {
    optionType,
    sizeMult,
    entryMode,
    manualStrikeOffset,
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    awaitResell: Boolean(rec.awaitResell),
    resellLegs,
    slFlattening: Boolean(rec.slFlattening) && slots.some((s) => s.open),
    hardSlPx,
    slots,
    t1Fill,
    strike,
    hedges: emptyHedges(),
    gross: finiteNonNeg(rec.gross),
    expense: finiteNonNeg(rec.expense),
    roundTrips: finiteNonNeg(rec.roundTrips),
    peakLots: finiteNonNeg(rec.peakLots),
    peakA: finiteNonNeg(rec.peakA),
    peakB: finiteNonNeg(rec.peakB),
  };
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) {
    return null;
  }
  if (engine.awaitResell && (engine.strike == null || !engine.resellLegs.length || engine.hardSlPx == null)) {
    engine.awaitResell = false;
    engine.resellLegs = [];
    engine.hardSlPx = null;
  }
  return engine;
}

export function parseBothSideSession(raw: unknown, today: string): BothSidePersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeBothSideEngine(rec.engine);
  if (!engine || !bothSidePositionActive(engine)) return null;
  const logs = sanitizeLogs(rec.logs);
  const nextLogIdRaw = Number(rec.nextLogId);
  const maxLogId = logs.reduce((m, l) => Math.max(m, l.id), 0);
  const nextLogId =
    Number.isFinite(nextLogIdRaw) && nextLogIdRaw > maxLogId ? Math.floor(nextLogIdRaw) : maxLogId + 1;
  return {
    v: 1,
    day: rec.day,
    iid: sanitizeIid(rec.iid),
    engine,
    logs,
    nextLogId,
  };
}

export function loadBothSideSession(nowMs: number = Date.now()): BothSidePersisted | null {
  try {
    const raw = readStoreRaw();
    if (!raw) return null;
    const parsed = parseBothSideSession(JSON.parse(raw), istCalendarDay(nowMs));
    if (!parsed) {
      removeStoreRaw();
      return null;
    }
    return parsed;
  } catch {
    removeStoreRaw();
    return null;
  }
}

export function saveBothSideSession(snap: BothSidePersisted): void {
  persistBothSideSize(snap.engine.sizeMult);
  if (!bothSidePositionActive(snap.engine)) {
    removeStoreRaw();
    return;
  }
  try {
    writeStoreRaw(
      JSON.stringify({
        v: 1,
        day: snap.day,
        iid: snap.iid,
        engine: {
          ...snap.engine,
          slots: snap.engine.slots.map((s) => ({ ...s })),
          hedges: cloneHedges(snap.engine.hedges),
          resellLegs: [...snap.engine.resellLegs],
        },
        logs: snap.logs.slice(0, 80),
        nextLogId: snap.nextLogId,
      } satisfies BothSidePersisted),
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearBothSideSession(): void {
  removeStoreRaw();
}
