/**
 * NIFTY Snake — short-premium grid on ONE selected CE/PE strike.
 * Independent of Nifty Ladder (T1–T9 / 90–110). Do not import ladder files.
 */

export const UNDERLYING = "NIFTY";
export const BAND_LOW = 70;
export const BAND_HIGH = 75;
export const BAND_TARGET = 72.5;
export const STEP_PTS = 3;
export const T1_COVER_PCT = 0.3;
export const T1_HARD_SL_PCT = 0.3;
export const ENTRY_MINUTE = 9 * 60 + 16;
export const EOD_MINUTE = 15 * 60 + 15;
export const LOT_SIZE = 65;
export const TRANCHE_LOTS = [8, 3, 3, 4, 4, 3, 3] as const;
export const TRANCHE_COUNT = 7;
export const SIZE_MULTS = [1, 2, 3] as const;
export type SizeMult = (typeof SIZE_MULTS)[number];
export const MANUAL_STRIKE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
export const MAX_PLAN_TICKS = 32;
export const SNAKE_CLOCK_MS = 25;
export const ROUND_TRIP_COST_PER_LOT = 25;
export const HEDGE_LOW = 3;
export const HEDGE_HIGH = 4;
export const HEDGE_TARGET = 3.5;

export const SNAKE_STORE_KEY = "sow_nifty_snake_v1";
export const SNAKE_SIZE_STORE_KEY = "sow_nifty_snake_size_v1";

export type OptionType = "CE" | "PE";
export type EntryMode = "auto" | "manual";
export type ManualStrikeOffset = (typeof MANUAL_STRIKE_OFFSETS)[number];
export type HedgeWindowId = "T1" | "T4" | "T7";

export const HEDGE_WINDOWS: ReadonlyArray<{
  id: HedgeWindowId;
  from: number;
  to: number;
  label: string;
}> = [
  { id: "T1", from: 1, to: 3, label: "T1–T3" },
  { id: "T4", from: 4, to: 6, label: "T4–T6" },
  { id: "T7", from: 7, to: 7, label: "T7" },
];

export type SnakeSlot = {
  index: number;
  lots: number;
  open: boolean;
  fill: number | null;
};

export type SnakeHedge = {
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

export type SnakeEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  /** auto = band hunt 70–75; manual = fixed ATM±N, no band check */
  entryMode: EntryMode;
  manualStrikeOffset: ManualStrikeOffset;
  armed: boolean;
  awaitRestart: boolean;
  awaitResell: boolean;
  /** Indices that were open when hard SL flattened. Re-SELL these, not a new hunt. */
  resellLegs: number[];
  slFlattening: boolean;
  slots: SnakeSlot[];
  /** Original T1 fill. Never replaced by a re-SELL print. */
  t1Fill: number | null;
  strike: number | null;
  /** Manual SL. Null keeps the +30% line from the original T1 fill. */
  hardSlPx: number | null;
  hedges: SnakeHedge[];
  gross: number;
  expense: number;
  roundTrips: number;
  peakLots: number;
  peakTranche: number;
};

export type SnakeAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; index: number; lots: number }
  | { kind: "resell"; index: number; lots: number }
  | { kind: "book"; index: number; lots: number; reason: string }
  | { kind: "stop"; reason: string };

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitResell: boolean;
  resellLegs: number[];
  t1Fill: number | null;
  slots: SnakeSlot[];
  ltp: number | null;
  huntPick: HuntPick | null;
  /** Locked SL. Null uses original T1 fill +30%. Hard SL and re-SELL both use this line. */
  hardSlPx?: number | null;
  /** auto = require 70–75 band; manual = enter any live pick */
  entryMode?: EntryMode;
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

export function lotsForMult(mult: SizeMult = 1): number[] {
  const m = asSizeMult(mult);
  return TRANCHE_LOTS.map((lots) => lots * m);
}

export function sellLevel(t1Fill: number, index: number): number {
  return t1Fill + STEP_PTS * (index - 1);
}

export function bookLevel(t1Fill: number, index: number): number {
  return sellLevel(t1Fill, index) - STEP_PTS;
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * (1 - T1_COVER_PCT);
}

export function t1HardSlPrice(t1Fill: number): number {
  return t1Fill * (1 + T1_HARD_SL_PCT);
}

/** Locked override wins. Otherwise hard SL is original T1 fill +30%. */
export function resolveHardSl(
  t1Fill: number | null | undefined,
  override?: number | null,
): number | null {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  if (typeof t1Fill === "number" && Number.isFinite(t1Fill) && t1Fill > 0) return t1HardSlPrice(t1Fill);
  return null;
}

export function inPremiumBand(ltp: number | null | undefined): boolean {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp >= BAND_LOW && ltp <= BAND_HIGH;
}

export function netRealized(state: Pick<SnakeEngineState, "gross" | "expense">): number {
  return roundMoney(state.gross - state.expense);
}

export function hedgeWindowForLeg(index: number): HedgeWindowId | null {
  if (index === 1) return "T1";
  if (index === 4) return "T4";
  if (index === 7) return "T7";
  return null;
}

export function hedgeLots(window: HedgeWindowId): number {
  const spec = HEDGE_WINDOWS.find((w) => w.id === window);
  if (!spec) return 0;
  let sum = 0;
  for (let i = spec.from; i <= spec.to; i++) sum += TRANCHE_LOTS[i - 1] ?? 0;
  return sum;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptySlots(mult: SizeMult = 1): SnakeSlot[] {
  return lotsForMult(mult).map((lots, i) => ({
    index: i + 1,
    lots,
    open: false,
    fill: null,
  }));
}

export function applySizeToEmptySlots(slots: SnakeSlot[], mult: SizeMult): SnakeSlot[] {
  const lots = lotsForMult(mult);
  return slots.map((s, i) => (s.open ? s : { ...s, lots: lots[i] ?? s.lots }));
}

export function emptyHedges(): SnakeHedge[] {
  return HEDGE_WINDOWS.map((w) => ({
    window: w.id,
    covers: w.label,
    lots: hedgeLots(w.id),
    strike: null,
    iid: null,
    open: false,
    fill: null,
  }));
}

export function cloneSlots(slots: SnakeSlot[]): SnakeSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function cloneHedges(hedges: SnakeHedge[]): SnakeHedge[] {
  return hedges.map((h) => ({ ...h }));
}

export function isInTrade(slots: SnakeSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.index === 1);
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function hedgesOpen(state: Pick<SnakeEngineState, "hedges">): boolean {
  return state.hedges.some((h) => h.open);
}

export function openLots(slots: SnakeSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function avgFill(slots: SnakeSlot[]): number | null {
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

function slotByIndex(slots: SnakeSlot[], index: number): SnakeSlot | undefined {
  return slots.find((s) => s.index === index);
}

function highestOpen(slots: SnakeSlot[]): SnakeSlot | null {
  let best: SnakeSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function highestOpenExtra(slots: SnakeSlot[]): SnakeSlot | null {
  let best: SnakeSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.index <= 1) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function firstEmptyExtra(slots: SnakeSlot[]): SnakeSlot | null {
  const t1 = slotByIndex(slots, 1);
  if (!t1?.open) return null;
  const extras = slots.filter((s) => s.index >= 2).sort((a, b) => a.index - b.index);
  for (const s of extras) {
    if (!s.open) return s;
  }
  return null;
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: SnakeSlot, reason: string): SnakeAction {
  return { kind: "book", index: slot.index, lots: slot.lots, reason };
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
  return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
}

export function pickNear72(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
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

export function closestTo72(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
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

/** Manual T1: fixed ATM±N strike. No 70–75 band filter. */
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

function nextResellSlot(slots: SnakeSlot[], legs: number[]): SnakeSlot | null {
  const ordered = [...legs].filter((n) => n >= 1 && n <= TRANCHE_COUNT).sort((a, b) => a - b);
  for (const index of ordered) {
    const slot = slotByIndex(slots, index);
    if (slot && !slot.open) return slot;
  }
  return null;
}

/**
 * ONE next action. Caller loops until null.
 * Priority: EOD, hard SL flatten, cover, extra book, re-SELL, hunt, add.
 * Re-SELL is not a new 70–75 hunt and is blocked while paused.
 */
export function planTick(input: PlanTickInput): SnakeAction | null {
  const {
    nowMs,
    armed,
    awaitRestart,
    awaitResell,
    resellLegs,
    t1Fill,
    slots,
    ltp,
    huntPick,
    entryMode = "auto",
    hardSlPx,
  } = input;
  const trading = isInTrade(slots, t1Fill);
  const hardSl = resolveHardSl(t1Fill, hardSlPx);
  const hardSlLabel =
    typeof hardSlPx === "number" && hardSlPx > 0 && hardSl != null
      ? `HARD SL ${hardSl.toFixed(2)}`
      : "HARD SL +30%";

  if (isEod(nowMs)) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `EOD 15:15 · T${hi.index}`);
    if (awaitResell) return { kind: "stop", reason: "EOD 15:15 — re-SELL cancelled" };
    return null;
  }

  if (trading && validLtp(ltp) && hardSl != null && ltp >= hardSl) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `${hardSlLabel} · flatten T${hi.index}`);
  }

  if (
    awaitResell &&
    !trading &&
    !(typeof hardSlPx === "number" && hardSlPx > 0) &&
    t1Fill != null &&
    t1Fill > 0 &&
    validLtp(ltp) &&
    ltp <= t1CoverPrice(t1Fill)
  ) {
    return { kind: "stop", reason: "Below T1 cover while flat — re-SELL cancelled" };
  }

  if (!trading) {
    if (awaitResell && hardSl != null) {
      if (!armed) return null;
      if (!validLtp(ltp) || ltp >= hardSl) return null;
      const next = nextResellSlot(slots, resellLegs);
      if (next) return { kind: "resell", index: next.index, lots: next.lots };
      return null;
    }
    if (!armed || awaitRestart) return null;
    if (!isEntryWindow(nowMs)) return null;
    if (!huntPick) return null;
    // Manual ATM±N: enter at live premium. Auto: only 70–75 hunt band.
    if (entryMode !== "manual" && !inPremiumBand(huntPick.ltp)) return null;
    return { kind: "enter_t1", pick: huntPick };
  }

  if (!validLtp(ltp) || t1Fill == null || !(t1Fill > 0)) return null;

  if (ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) return bookAction(extra, `T1 30% path · book T${extra.index} first`);
    const t1 = slotByIndex(slots, 1);
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  const highestExtra = highestOpenExtra(slots);
  if (highestExtra && ltp <= bookLevel(t1Fill, highestExtra.index)) {
    return bookAction(highestExtra, `T${highestExtra.index} −3`);
  }

  if (awaitResell && armed) {
    if (hardSl != null && ltp >= hardSl) return null;
    const next = nextResellSlot(slots, resellLegs);
    if (next) return { kind: "resell", index: next.index, lots: next.lots };
  }

  if (armed) {
    const next = firstEmptyExtra(slots);
    if (next && ltp + 1e-9 >= sellLevel(t1Fill, next.index)) {
      return { kind: "add", index: next.index, lots: next.lots };
    }
  }

  return null;
}

export function nextSquareAllAction(slots: SnakeSlot[]): SnakeAction | null {
  const hi = highestOpen(slots);
  if (!hi) return null;
  return bookAction(hi, "SQUARE ALL");
}

function withPeak(state: SnakeEngineState, slots: SnakeSlot[]): SnakeEngineState {
  const lots = openLots(slots);
  const peakT = slots.reduce((m, s) => (s.open && s.index > m ? s.index : m), 0);
  return {
    ...state,
    slots,
    peakLots: Math.max(state.peakLots, lots),
    peakTranche: Math.max(state.peakTranche, peakT),
  };
}

function addRoundTrip(state: SnakeEngineState, entry: number, exit: number, lots: number, side: "short" | "long"): SnakeEngineState {
  const gross =
    side === "short" ? shortBookPnl(entry, exit, lots) : (exit - entry) * lots * LOT_SIZE;
  return {
    ...state,
    gross: roundMoney(state.gross + gross),
    expense: roundMoney(state.expense + ROUND_TRIP_COST_PER_LOT * lots),
    roundTrips: state.roundTrips + lots,
  };
}

function closeAllSlots(slots: SnakeSlot[]): SnakeSlot[] {
  return slots.map((s) => ({ ...s, open: false, fill: null }));
}

export function idleEngineState(
  optionType: OptionType = "CE",
  sizeMult: SizeMult = loadSnakeSize(),
  entryMode: EntryMode = "auto",
  manualStrikeOffset: ManualStrikeOffset = 0,
): SnakeEngineState {
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
    slots: emptySlots(mult),
    t1Fill: null,
    strike: null,
    hardSlPx: null,
    hedges: emptyHedges(),
    gross: 0,
    expense: 0,
    roundTrips: 0,
    peakLots: 0,
    peakTranche: 0,
  };
}

function clearedShort(state: SnakeEngineState, awaitRestart: boolean): SnakeEngineState {
  return {
    ...state,
    armed: false,
    awaitRestart,
    awaitResell: false,
    resellLegs: [],
    slFlattening: false,
    slots: emptySlots(state.sizeMult),
    t1Fill: null,
    strike: null,
    hardSlPx: null,
  };
}

export function uiReset(state: SnakeEngineState): SnakeEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

export function applyFilledAction(
  state: SnakeEngineState,
  action: SnakeAction,
  fillPx: number,
): SnakeEngineState {
  const slots = cloneSlots(state.slots);

  if (action.kind === "stop") {
    const eod = action.reason.toUpperCase().includes("EOD");
    return clearedShort(state, !eod);
  }

  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.index === 1);
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

  if (action.kind === "add" || action.kind === "resell") {
    const slot = slots.find((s) => s.index === action.index);
    if (slot) {
      slot.open = true;
      slot.fill = fillPx;
    }
    const resellLegs =
      action.kind === "resell"
        ? state.resellLegs.filter((index) => {
            const s = slots.find((row) => row.index === index);
            return s ? !s.open : false;
          })
        : state.resellLegs;
    const awaitResell = action.kind === "resell" ? resellLegs.length > 0 : state.awaitResell;
    return withPeak(
      {
        ...state,
        resellLegs,
        awaitResell,
        slFlattening: false,
      },
      slots,
    );
  }

  const slot = slots.find((s) => s.index === action.index);
  const entry = slot?.fill ?? null;
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  let next: SnakeEngineState = entry != null && entry > 0 && fillPx > 0
    ? addRoundTrip({ ...state, slots }, entry, fillPx, action.lots, "short")
    : { ...state, slots };
  next.slots = slots;

  if (isHardSlReason(action.reason)) {
    const resellLegs = state.slFlattening
      ? state.resellLegs
      : state.slots
          .filter((s) => s.open)
          .map((s) => s.index)
          .sort((a, b) => a - b);
    const stillOpen = slots.some((s) => s.open);
    return {
      ...next,
      slots,
      resellLegs,
      slFlattening: stillOpen,
      awaitResell: !stillOpen && resellLegs.length > 0,
      awaitRestart: false,
    };
  }

  if (action.index === 1) {
    return {
      ...clearedShort(next, isCoverReason(action.reason)),
      slots: emptySlots(next.sizeMult),
      gross: next.gross,
      expense: next.expense,
      roundTrips: next.roundTrips,
      peakLots: next.peakLots,
      peakTranche: next.peakTranche,
      hedges: next.hedges,
    };
  }

  return { ...next, slots, slFlattening: false };
}

export function applyHedgeOpen(
  state: SnakeEngineState,
  window: HedgeWindowId,
  strike: number,
  iid: number,
  fillPx: number,
): SnakeEngineState {
  const hedges = cloneHedges(state.hedges.length ? state.hedges : emptyHedges());
  const row = hedges.find((h) => h.window === window);
  if (row) {
    row.open = true;
    row.strike = strike;
    row.iid = iid;
    row.fill = fillPx;
    row.lots = hedgeLots(window);
  }
  return { ...state, hedges };
}

export function applyHedgeClose(
  state: SnakeEngineState,
  window: HedgeWindowId,
  exitPx: number,
): SnakeEngineState {
  const hedges = cloneHedges(state.hedges.length ? state.hedges : emptyHedges());
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

/** Broker already flat while we still showed a short. Keep hedges and day PnL. */
export function externalShortFlat(state: SnakeEngineState): SnakeEngineState {
  return clearedShort(state, true);
}

function finiteQty(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNonZeroQty(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = finiteQty(row[key]);
    if (n != null && n !== 0) return n;
  }
  return null;
}

/**
 * Signed open qty. XTS often leaves NetPosition at 0 while Quantity
 * (or open sell) still has the live short — a 0 must not hide that.
 */
export function xtsRowNetQty(row: Record<string, unknown>): number {
  const direct = firstNonZeroQty(row, [
    "NetPosition",
    "netPosition",
    "Quantity",
    "quantity",
    "NetQuantity",
    "netQuantity",
  ]);
  if (direct != null) return direct;
  const longQ = finiteQty(row.LongPosition ?? row.longPosition) ?? 0;
  const shortQ = finiteQty(row.ShortPosition ?? row.shortPosition) ?? 0;
  if (longQ !== 0 || shortQ !== 0) return longQ - shortQ;
  const obq = finiteQty(row.OpenBuyQuantity ?? row.openBuyQuantity) ?? 0;
  const osq = finiteQty(row.OpenSellQuantity ?? row.openSellQuantity) ?? 0;
  return obq - osq;
}

function xtsRowIid(row: Record<string, unknown>): number | null {
  const n = finiteQty(
    row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID,
  );
  return n != null && n > 0 ? Math.floor(n) : null;
}

export type BrokerNetRead = {
  /** positionList missing or empty — unknown, not a square-off. */
  bookEmpty: boolean;
  netQty: number;
};

/** Sum every XTS row for this contract. An empty book is not "flat". */
export function readBrokerNetQty(
  rows: Array<Record<string, unknown>>,
  instrumentId: number | null,
): BrokerNetRead {
  if (!rows.length || instrumentId == null) return { bookEmpty: true, netQty: 0 };
  let net = 0;
  let saw = false;
  for (const row of rows) {
    if (xtsRowIid(row) !== instrumentId) continue;
    saw = true;
    net += xtsRowNetQty(row);
  }
  if (!saw) return { bookEmpty: false, netQty: 0 };
  return { bookEmpty: false, netQty: net };
}

export function localNewDayReset(state: SnakeEngineState): SnakeEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

/** Persist a live start / open short / re-SELL wait / open hedge. Full book clears this. */
export function snakePositionActive(state: SnakeEngineState): boolean {
  return Boolean(
    state.armed ||
      state.awaitResell ||
      state.slFlattening ||
      isInTrade(state.slots, state.t1Fill),
  );
}

export type SnakeLogKind = "info" | "entry" | "exit" | "warn";

export type SnakePersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: SnakeLogKind;
};

export type SnakePersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: SnakeEngineState;
  logs: SnakePersistedLog[];
  nextLogId: number;
};

const LOG_KINDS = new Set<SnakeLogKind>(["info", "entry", "exit", "warn"]);

function readStoreRaw(): string | null {
  try {
    const s = sessionStorage.getItem(SNAKE_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(SNAKE_STORE_KEY);
  } catch {
    return null;
  }
}

function writeStoreRaw(raw: string): void {
  try {
    sessionStorage.setItem(SNAKE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(SNAKE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeStoreRaw(): void {
  try {
    sessionStorage.removeItem(SNAKE_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(SNAKE_STORE_KEY);
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
    const s = sessionStorage.getItem(SNAKE_SIZE_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(SNAKE_SIZE_STORE_KEY);
  } catch {
    return null;
  }
}

export function loadSnakeSize(): SizeMult {
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

export function persistSnakeSize(sizeMult: SizeMult): void {
  const raw = JSON.stringify({ sizeMult: asSizeMult(sizeMult) });
  try {
    sessionStorage.setItem(SNAKE_SIZE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(SNAKE_SIZE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function sanitizeSlotLots(index: number, raw: unknown, mult: SizeMult): number {
  const base = TRANCHE_LOTS[index - 1] ?? 1;
  const n = Math.floor(Number(raw));
  if (n === base || n === base * 2 || n === base * 3) return n;
  return base * asSizeMult(mult);
}

function sanitizeSlots(raw: unknown, mult: SizeMult): SnakeSlot[] | null {
  if (!Array.isArray(raw) || raw.length !== TRANCHE_COUNT) return null;
  const slots: SnakeSlot[] = [];
  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") return null;
    const rec = row as Record<string, unknown>;
    if (Number(rec.index) !== i + 1) return null;
    const open = Boolean(rec.open);
    const fillRaw = rec.fill;
    const fill =
      typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
    if (open && fill == null) return null;
    slots.push({
      index: i + 1,
      lots: sanitizeSlotLots(i + 1, rec.lots, mult),
      open,
      fill: open ? fill : null,
    });
  }
  return slots;
}

function sanitizeHedges(): SnakeHedge[] {
  return emptyHedges();
}

function sanitizeLogs(raw: unknown): SnakePersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: SnakePersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as SnakeLogKind) ? (rec.kind as SnakeLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 80) break;
  }
  return out;
}

function sanitizePrice(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function finiteNonNeg(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function sanitizeSnakeEngine(raw: unknown): SnakeEngineState | null {
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
  const t1 = slots.find((s) => s.index === 1);
  const t1FillRaw = rec.t1Fill;
  let t1Fill =
    typeof t1FillRaw === "number" && Number.isFinite(t1FillRaw) && t1FillRaw > 0 ? t1FillRaw : null;
  if (t1?.open && t1.fill != null) t1Fill = t1Fill ?? t1.fill;
  const strikeRaw = rec.strike;
  const strike =
    typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw : null;
  const resellLegs = Array.isArray(rec.resellLegs)
    ? rec.resellLegs
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= TRANCHE_COUNT)
    : [];
  const engine: SnakeEngineState = {
    optionType,
    sizeMult,
    entryMode,
    manualStrikeOffset,
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    awaitResell: Boolean(rec.awaitResell),
    resellLegs,
    slFlattening: Boolean(rec.slFlattening) && slots.some((s) => s.open),
    slots,
    t1Fill,
    strike,
    hardSlPx: sanitizePrice(rec.hardSlPx),
    hedges: sanitizeHedges(),
    gross: finiteNonNeg(rec.gross),
    expense: finiteNonNeg(rec.expense),
    roundTrips: finiteNonNeg(rec.roundTrips),
    peakLots: finiteNonNeg(rec.peakLots),
    peakTranche: finiteNonNeg(rec.peakTranche),
  };
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) {
    return null;
  }
  if (engine.awaitResell && (engine.strike == null || engine.t1Fill == null || !engine.resellLegs.length)) {
    engine.awaitResell = false;
    engine.resellLegs = [];
  }
  return engine;
}

export function parseSnakeSession(raw: unknown, today: string): SnakePersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeSnakeEngine(rec.engine);
  if (!engine) return null;
  const logs = sanitizeLogs(rec.logs);
  const nextLogIdRaw = Number(rec.nextLogId);
  const maxLogId = logs.reduce((m, l) => Math.max(m, l.id), 0);
  const nextLogId =
    Number.isFinite(nextLogIdRaw) && nextLogIdRaw > maxLogId ? Math.floor(nextLogIdRaw) : maxLogId + 1;
  const keepPosition = snakePositionActive(engine);
  const storedEngine = keepPosition
    ? engine
    : {
        ...idleEngineState(engine.optionType, engine.sizeMult, engine.entryMode, engine.manualStrikeOffset),
        gross: engine.gross,
        expense: engine.expense,
        roundTrips: engine.roundTrips,
        peakLots: engine.peakLots,
        peakTranche: engine.peakTranche,
      };
  if (
    !keepPosition &&
    storedEngine.gross === 0 &&
    storedEngine.roundTrips === 0 &&
    !logs.length
  ) {
    return null;
  }
  return {
    v: 1,
    day: rec.day,
    iid: keepPosition ? sanitizeIid(rec.iid) : null,
    engine: storedEngine,
    logs,
    nextLogId,
  };
}

export function loadSnakeSession(nowMs: number = Date.now()): SnakePersisted | null {
  try {
    const raw = readStoreRaw();
    if (!raw) return null;
    const parsed = parseSnakeSession(JSON.parse(raw), istCalendarDay(nowMs));
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

export function saveSnakeSession(snap: SnakePersisted): void {
  persistSnakeSize(snap.engine.sizeMult);
  const keepPosition = snakePositionActive(snap.engine);
  const engine = keepPosition
    ? {
        ...snap.engine,
        slots: snap.engine.slots.map((s) => ({ ...s })),
        hedges: cloneHedges(snap.engine.hedges),
        resellLegs: [...snap.engine.resellLegs],
      }
    : {
        ...idleEngineState(
          snap.engine.optionType,
          snap.engine.sizeMult,
          snap.engine.entryMode,
          snap.engine.manualStrikeOffset,
        ),
        gross: snap.engine.gross,
        expense: snap.engine.expense,
        roundTrips: snap.engine.roundTrips,
        peakLots: snap.engine.peakLots,
        peakTranche: snap.engine.peakTranche,
      };
  if (!keepPosition && engine.gross === 0 && engine.roundTrips === 0 && snap.logs.length === 0) {
    removeStoreRaw();
    return;
  }
  try {
    writeStoreRaw(
      JSON.stringify({
        v: 1,
        day: snap.day,
        iid: keepPosition ? snap.iid : null,
        engine,
        logs: snap.logs.slice(0, 80),
        nextLogId: snap.nextLogId,
      } satisfies SnakePersisted),
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearSnakeSession(): void {
  removeStoreRaw();
}
