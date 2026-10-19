/**
 * NIFTY Ladder — same-strike short-premium grid.
 * Pure decision engine: planTick + level math + pickNear100.
 * UI / broker is a thin wrapper. Do not invent extra constants.
 */

export const UNDERLYING = "NIFTY";
export const BAND_LOW = 98;
export const BAND_HIGH = 105;
export const BAND_TARGET = 100;
export const STEP_PTS = 3;
export const T1_COVER_PCT = 0.3;
export const T1_HARD_SL_PCT = 0.3;
export const ENTRY_MINUTE = 9 * 60 + 16; // 09:16 IST
export const EOD_MINUTE = 15 * 60 + 15; // 15:15 IST
export const LOT_SIZE = 65;
export const SIZE_MULTS = [1, 2, 3] as const;
export const MANUAL_STRIKE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
export const TRANCHE_LOTS = [8, 2, 2, 2, 2, 3, 3, 4, 4] as const;
export const TRANCHE_COUNT = 9;
export const MAX_SLOT_LOTS = 100;
export const MAX_PLAN_TICKS = 32;
export const LADDER_CLOCK_MS = 25;
export const ROUND_TRIP_COST_PER_LOT = 25;

export type OptionType = "CE" | "PE";
export type SizeMult = (typeof SIZE_MULTS)[number];
export type EntryMode = "auto" | "manual";
export type ManualStrikeOffset = (typeof MANUAL_STRIKE_OFFSETS)[number];
export type OpenDriveBias = "UP" | "DOWN" | "FLAT";

export type LadderSlot = {
  index: number;
  lots: number;
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

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  t1Fill: number | null;
  /**
   * Grid origin is the T1 entry print. Never replaced by XTS SellAveragePrice
   * or book avg. Extras book down to T1 then add up again from this same lock.
   */
  t1GridLocked: boolean;
  slots: LadderSlot[];
  ltp: number | null;
  huntPick: HuntPick | null;
  /** Locked SL. Null uses T1 fill +30%. Hard SL and reload both use this line. */
  hardSlPx?: number | null;
  /** auto = require 98–105 band; manual = enter any live pick */
  entryMode?: EntryMode;
  /**
   * True while this cycle is already flattening a hard SL.
   * A one-tick dip under the +30% line must not gap-fill extras
   * in the same burst — that re-sold T2–T9 and got stopped again.
   */
  suppressAdds?: boolean;
};

export type LadderAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; index: number; lots: number; through?: number }
  | { kind: "reload"; index: number; lots: number }
  | { kind: "book"; index: number; lots: number; reason: string };

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

export function isEntryWindow(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= ENTRY_MINUTE;
}

export function isEod(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= EOD_MINUTE;
}

export function lotsForMult(mult: SizeMult): number[] {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  return TRANCHE_LOTS.map((lots) => lots * m);
}

export function clampSlotLots(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_SLOT_LOTS, n);
}

export function addIntervalPts(index: number): number {
  return STEP_PTS * Math.max(0, index - 1);
}

function slotsFromLots(lots: number[]): LadderSlot[] {
  return lots.map((n, i) => ({
    index: i + 1,
    lots: clampSlotLots(n),
    open: false,
    fill: null,
  }));
}

export function emptySlots(mult: SizeMult = 1): LadderSlot[] {
  const saved = loadCustomTrancheLots();
  return slotsFromLots(saved?.lots ?? lotsForMult(mult));
}

export function applySizeToEmptySlots(slots: LadderSlot[], mult: SizeMult): LadderSlot[] {
  const lots = lotsForMult(mult);
  return slots.map((s, i) => (s.open ? s : { ...s, lots: lots[i] ?? s.lots }));
}

export function setEmptySlotLots(slots: LadderSlot[], index: number, lots: number): LadderSlot[] | null {
  const nextLots = clampSlotLots(lots);
  const found = slots.find((s) => s.index === index);
  if (!found || found.open || found.lots === nextLots) return null;
  return slots.map((s) => (s.index === index ? { ...s, lots: nextLots } : { ...s }));
}

export function cloneSlots(slots: LadderSlot[]): LadderSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function isInTrade(slots: LadderSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.index === 1);
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function openLots(slots: LadderSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function avgFill(slots: LadderSlot[]): number | null {
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

export function qtyForLots(lots: number): number {
  return Math.max(1, Math.floor(lots) * LOT_SIZE);
}

export function addLevel(t1Fill: number, index: number): number {
  return t1Fill + STEP_PTS * (index - 1);
}

export function bookLevel(t1Fill: number, index: number): number {
  return addLevel(t1Fill, index) - STEP_PTS;
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * (1 - T1_COVER_PCT);
}

export function t1HardSlPrice(t1Fill: number): number {
  return t1Fill * (1 + T1_HARD_SL_PCT);
}

/** Locked override wins. Otherwise hard SL is T1 fill +30%. */
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

/**
 * Short-premium mark: bid first (sellable quote), then last trade.
 * OTM CE/PE can sit on a stale LastTradedPrice while the book still ticks.
 */
export function shortMarkPx(
  tick: { ltp?: number | null; bid?: number | null } | null | undefined,
  fallback?: number | null,
): number | null {
  const bid = tick?.bid;
  if (typeof bid === "number" && Number.isFinite(bid) && bid > 0) return bid;
  const ltp = tick?.ltp;
  if (typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0) return ltp;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
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

/** UI “nearest” display only. Never used for T1 entry. */
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

/**
 * Manual T1: fixed ATM±N strike for selected CE/PE.
 * No premium-band filter — any live print on that side is enough.
 */
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

function slotByIndex(slots: LadderSlot[], index: number): LadderSlot | undefined {
  return slots.find((s) => s.index === index);
}

function highestOpen(slots: LadderSlot[]): LadderSlot | null {
  let best: LadderSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function highestOpenExtra(slots: LadderSlot[]): LadderSlot | null {
  let best: LadderSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.index <= 1) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function firstEmptyExtra(slots: LadderSlot[]): LadderSlot | null {
  const t1 = slotByIndex(slots, 1);
  if (!t1?.open) return null;
  const extras = slots.filter((s) => s.index >= 2).sort((a, b) => a.index - b.index);
  for (const s of extras) {
    if (!s.open) return s;
  }
  return null;
}

/** Consecutive empty extras whose +3 add level is already crossed by LTP. */
export function crossedEmptyExtras(slots: LadderSlot[], t1Fill: number, ltp: number): LadderSlot[] {
  const first = firstEmptyExtra(slots);
  if (!first) return [];
  const extras = slots.filter((s) => s.index >= first.index).sort((a, b) => a.index - b.index);
  const out: LadderSlot[] = [];
  for (const s of extras) {
    if (s.open) break;
    if (ltp + 1e-9 < addLevel(t1Fill, s.index)) break;
    out.push(s);
  }
  return out;
}

function firstEmptySlot(slots: LadderSlot[]): LadderSlot | null {
  const ordered = [...slots].sort((a, b) => a.index - b.index);
  for (const s of ordered) {
    if (!s.open) return s;
  }
  return null;
}

function closeAllSlots(slots: LadderSlot[]): LadderSlot[] {
  return slots.map((s) => ({ ...s, open: false, fill: null }));
}

export function isHardSlReason(reason: string): boolean {
  return reason.toUpperCase().includes("HARD SL");
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: LadderSlot, reason: string): LadderAction {
  return { kind: "book", index: slot.index, lots: slot.lots, reason };
}

/**
 * ONE next action. Caller MUST loop until null so a spike can open extras
 * in one burst, a gap-down can book extras then T1, and a hard-SL recross
 * can flatten then reload T1–T9 before T-system books.
 * Priority is strict: first match wins.
 */
export function planTick(input: PlanTickInput): LadderAction | null {
  const {
    nowMs,
    armed,
    awaitRestart,
    awaitReload,
    t1Fill,
    slots,
    ltp,
    huntPick,
    entryMode = "auto",
    hardSlPx,
  } = input;
  const trading = isInTrade(slots, t1Fill);
  // Live as soon as T1 is applied — do not wait for XTS book lock.
  // Up-spike can add T2+ in one burst; down-spike can book extras then T1.
  const gridLive = trading;
  const hardSl = resolveHardSl(t1Fill, hardSlPx);
  const hardSlLabel =
    typeof hardSlPx === "number" && hardSlPx > 0 && hardSl != null
      ? `HARD SL ${hardSl.toFixed(2)}`
      : "HARD SL +30%";

  // 1) EOD (istMinuteOfDay >= 15:15) — flatten, never reload after 15:15
  if (isEod(nowMs)) {
    const hi = highestOpen(slots);
    if (!hi) return null;
    return bookAction(hi, `EOD 15:15 · T${hi.index}`);
  }

  // 2) HARD SL: ltp >= locked SL (default t1Fill * 1.30) — flatten whatever is open
  if (gridLive && validLtp(ltp) && hardSl != null && ltp >= hardSl) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `${hardSlLabel} · flatten T${hi.index}`);
  }

  // 3) After hard-SL flatten: reload full book T1–T9 while LTP < hard SL
  if (awaitReload && hardSl != null) {
    if (!validLtp(ltp) || ltp >= hardSl) return null;
    if (!armed) return null;
    const next = firstEmptySlot(slots);
    if (next) return { kind: "reload", index: next.index, lots: next.lots };
    return null;
  }

  // 4) Not inTrade — hunt T1
  if (!trading) {
    if (!armed || awaitRestart) return null;
    if (!isEntryWindow(nowMs)) return null;
    if (!huntPick) return null;
    // Manual ATM±N: enter at live premium. Auto: only 98–105 hunt band.
    if (entryMode !== "manual" && !inPremiumBand(huntPick.ltp)) return null;
    return { kind: "enter_t1", pick: huntPick };
  }

  // 5) inTrade but ltp invalid
  if (!validLtp(ltp) || t1Fill == null || !(t1Fill > 0)) return null;

  // 6) T1 COVER path: ltp <= t1Fill * 0.70 — down-spike / −30% books immediately
  if (gridLive && ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) {
      return bookAction(extra, `T1 30% path · book T${extra.index} first`);
    }
    const t1 = slotByIndex(slots, 1);
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  // 7) Extra −3 book (T1 is NEVER booked by this rule)
  if (gridLive) {
    const highestExtra = highestOpenExtra(slots);
    if (highestExtra && ltp <= bookLevel(t1Fill, highestExtra.index)) {
      return bookAction(highestExtra, `T${highestExtra.index} −3`);
    }
  }

  // 8) Adds only if armed === true (PAUSE blocks this).
  // Gap-up: fill every crossed empty extra in one burst — no skip.
  // Hard-SL burst: do not re-open extras until this flatten pass ends.
  if (gridLive && armed === true && !input.suppressAdds) {
    const crossed = crossedEmptyExtras(slots, t1Fill, ltp);
    if (crossed.length) {
      const first = crossed[0]!;
      const last = crossed[crossed.length - 1]!;
      const lots = crossed.reduce((sum, s) => sum + s.lots, 0);
      return {
        kind: "add",
        index: first.index,
        lots,
        through: last.index > first.index ? last.index : undefined,
      };
    }
  }

  // 9) else null
  return null;
}

export function nextSquareAllAction(slots: LadderSlot[]): LadderAction | null {
  const hi = highestOpen(slots);
  if (!hi) return null;
  return bookAction(hi, "SQUARE ALL");
}

export function reasonAwaitsRestart(reason: string): boolean {
  const u = reason.toUpperCase();
  return !u.includes("EOD") && !u.includes("SQUARE") && !u.includes("HARD SL");
}

export type LadderEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  /** auto = band hunt ~100; manual = fixed ATM±N, no band check */
  entryMode: EntryMode;
  manualStrikeOffset: ManualStrikeOffset;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  slots: LadderSlot[];
  t1Fill: number | null;
  /** True after T1 entry — +3/−3 grid is frozen to that print for the whole trade. */
  t1GridLocked: boolean;
  strike: number | null;
  /** Manual SL. Null keeps the +30% line from t1Fill. */
  hardSlPx: number | null;
};

export function idleEngineState(
  optionType: OptionType = "CE",
  sizeMult: SizeMult = 1,
  entryMode: EntryMode = "auto",
  manualStrikeOffset: ManualStrikeOffset = 0,
): LadderEngineState {
  const saved = loadCustomTrancheLots();
  const mult = saved?.sizeMult ?? (SIZE_MULTS.includes(sizeMult) ? sizeMult : 1);
  const mode: EntryMode = entryMode === "manual" ? "manual" : "auto";
  const offset = MANUAL_STRIKE_OFFSETS.includes(manualStrikeOffset) ? manualStrikeOffset : 0;
  return {
    optionType,
    sizeMult: mult,
    entryMode: mode,
    manualStrikeOffset: offset,
    armed: false,
    awaitRestart: false,
    awaitReload: false,
    slots: emptySlots(mult),
    t1Fill: null,
    t1GridLocked: false,
    strike: null,
    hardSlPx: null,
  };
}

function slotsFullyOpen(slots: LadderSlot[]): boolean {
  return slots.length > 0 && slots.every((s) => s.open);
}

/** Apply a planTick / square-all action after the order filled at `fillPx`. */
export function applyFilledAction(
  state: LadderEngineState,
  action: LadderAction,
  fillPx: number,
): LadderEngineState {
  const slots = cloneSlots(state.slots);
  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.index === 1);
    if (t1) {
      t1.open = true;
      t1.fill = fillPx;
    }
    return {
      ...state,
      t1Fill: fillPx,
      t1GridLocked: true,
      strike: action.pick.strike,
      optionType: action.pick.optionType,
      slots,
      awaitRestart: false,
      awaitReload: false,
      hardSlPx: null,
    };
  }
  if (action.kind === "add" || action.kind === "reload") {
    const from = action.index;
    const to =
      action.kind === "add" && typeof action.through === "number" && action.through >= from
        ? action.through
        : from;
    for (const slot of slots) {
      if (slot.index >= from && slot.index <= to) {
        slot.open = true;
        slot.fill = fillPx;
      }
    }
    return {
      ...state,
      t1GridLocked: true,
      slots,
      awaitReload: action.kind === "reload" ? !slotsFullyOpen(slots) : state.awaitReload,
    };
  }
  const slot = slots.find((s) => s.index === action.index);
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  if (action.index === 1) {
    if (isHardSlReason(action.reason)) {
      return {
        ...state,
        slots: closeAllSlots(slots),
        awaitRestart: false,
        awaitReload: true,
      };
    }
    return {
      ...state,
      slots: emptySlots(state.sizeMult),
      t1Fill: null,
      t1GridLocked: false,
      strike: null,
      armed: false,
      awaitRestart: reasonAwaitsRestart(action.reason),
      awaitReload: false,
      hardSlPx: null,
    };
  }
  return { ...state, slots };
}

/**
 * Mark the T1-entry grid as locked. Never overwrites t1Fill with XTS SellAveragePrice.
 */
export function maybeConfirmT1Fill(
  state: LadderEngineState,
  _confirmedFill?: number,
  _brokerShortLots?: number,
): LadderEngineState {
  if (state.t1GridLocked) return state;
  if (!isInTrade(state.slots, state.t1Fill)) return state;
  return { ...state, t1GridLocked: true };
}

export type ReconcileResult = {
  state: LadderEngineState;
  phantomClosed: number[];
  brokerFlat: boolean;
};

/**
 * Live broker reconcile. Source of truth = net SHORT lots of the locked contract.
 * If UI lots > broker: close highest extras first (phantom). Never auto-open
 * extras when broker shows more shorts — that re-booked T2 in a loop.
 * If broker is flat: wipe to Idle (caller must have seen a live short first).
 */
export function reconcileBrokerShortLots(
  state: LadderEngineState,
  brokerShortLots: number,
): ReconcileResult {
  const trading = isInTrade(state.slots, state.t1Fill);
  const brokerLots = Math.max(0, Math.floor(brokerShortLots));
  if (trading && brokerLots <= 0) {
    return {
      state: idleEngineState(
        state.optionType,
        state.sizeMult,
        state.entryMode,
        state.manualStrikeOffset,
      ),
      phantomClosed: [],
      brokerFlat: true,
    };
  }
  const uiLots = openLots(state.slots);
  if (uiLots <= brokerLots) {
    return { state, phantomClosed: [], brokerFlat: false };
  }
  const slots = cloneSlots(state.slots);
  let extra = uiLots - brokerLots;
  const phantomClosed: number[] = [];
  const extras = slots.filter((s) => s.open && s.index > 1).sort((a, b) => b.index - a.index);
  for (const s of extras) {
    if (extra <= 0) break;
    s.open = false;
    s.fill = null;
    extra -= s.lots;
    phantomClosed.push(s.index);
  }
  return { state: { ...state, slots }, phantomClosed, brokerFlat: false };
}

export function shortBookedPnl(entryFill: number, exitFill: number, lots: number): number {
  return (entryFill - exitFill) * lots * LOT_SIZE;
}

export function openMtm(avg: number | null, liveLtp: number | null, lots: number): number | null {
  if (avg == null || liveLtp == null || !(avg > 0) || !(liveLtp > 0) || lots <= 0) return null;
  return (avg - liveLtp) * lots * LOT_SIZE;
}

export function backtestAddFill(ltp: number, level: number): number {
  return Math.min(ltp, level);
}

export function backtestBookFill(opts: {
  reason: string;
  ltp: number;
  prevLtp: number | null;
  level: number;
  hardSl: number;
}): number {
  const { reason, ltp, prevLtp, level, hardSl } = opts;
  const u = reason.toUpperCase();
  if (u.includes("EOD")) return ltp;
  if (u.includes("HARD SL")) {
    if (prevLtp != null && prevLtp < hardSl) return hardSl;
    return ltp;
  }
  if (prevLtp != null && prevLtp > level) return level;
  return ltp;
}

export function localNewDayReset(state: LadderEngineState): LadderEngineState {
  return {
    ...state,
    armed: false,
    awaitRestart: false,
    awaitReload: false,
    slots: emptySlots(state.sizeMult),
    t1Fill: null,
    t1GridLocked: false,
    strike: null,
    hardSlPx: null,
  };
}

export function uiReset(state: LadderEngineState): LadderEngineState {
  return idleEngineState(
    state.optionType,
    state.sizeMult,
    state.entryMode,
    state.manualStrikeOffset,
  );
}

/** Persist while armed or still in trade. Clear after square-all / all books / idle. */
export function ladderSessionActive(state: LadderEngineState): boolean {
  return Boolean(state.armed || state.awaitReload || isInTrade(state.slots, state.t1Fill));
}

export const LADDER_STORE_KEY = "sow_nifty_ladder_v1";
export const LADDER_LOTS_STORE_KEY = "sow_nifty_ladder_lots_v1";
/** MTM TARGET/SL Exit All — pause hunt and square the ladder so it does not re-enter. */
export const EV_NIFTY_LADDER_FLAT = "sow:nifty_ladder_flat";

export type CustomTrancheLots = {
  sizeMult: SizeMult;
  lots: number[];
};

function readJsonStore(key: string): unknown {
  try {
    const s = sessionStorage.getItem(key);
    if (s) return JSON.parse(s);
  } catch {
    /* ignore */
  }
  try {
    const s = localStorage.getItem(key);
    if (s) return JSON.parse(s);
  } catch {
    /* ignore */
  }
  return null;
}

function writeJsonStore(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  try {
    sessionStorage.setItem(key, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(key, raw);
  } catch {
    /* ignore */
  }
}

export function loadCustomTrancheLots(): CustomTrancheLots | null {
  try {
    const rec = readJsonStore(LADDER_LOTS_STORE_KEY);
    if (!rec || typeof rec !== "object") return null;
    const obj = rec as Record<string, unknown>;
    const sizeMult = SIZE_MULTS.includes(obj.sizeMult as SizeMult) ? (obj.sizeMult as SizeMult) : null;
    if (!sizeMult) return null;
    if (!Array.isArray(obj.lots) || obj.lots.length !== TRANCHE_COUNT) return null;
    const lots = obj.lots.map((n) => clampSlotLots(n));
    if (lots.some((n) => !Number.isFinite(n) || n < 1)) return null;
    return { sizeMult, lots };
  } catch {
    return null;
  }
}

export function persistTrancheLots(slots: LadderSlot[], sizeMult: SizeMult): void {
  if (slots.length !== TRANCHE_COUNT) return;
  const lots = slots.map((s) => clampSlotLots(s.lots));
  writeJsonStore(LADDER_LOTS_STORE_KEY, { sizeMult, lots } satisfies CustomTrancheLots);
}

export type LadderLogKind = "info" | "entry" | "exit" | "warn";

export type LadderPersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: LadderLogKind;
};

export type LadderPersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: LadderEngineState;
  logs: LadderPersistedLog[];
  nextLogId: number;
};

const LOG_KINDS = new Set<LadderLogKind>(["info", "entry", "exit", "warn"]);

function sanitizePrice(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function sanitizeIid(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function sanitizeSlots(raw: unknown, _sizeMult: SizeMult): LadderSlot[] | null {
  if (!Array.isArray(raw) || raw.length !== TRANCHE_COUNT) return null;
  const slots: LadderSlot[] = [];
  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") return null;
    const rec = row as Record<string, unknown>;
    const index = Number(rec.index);
    if (index !== i + 1) return null;
    const lots = Number(rec.lots);
    if (!Number.isFinite(lots) || lots <= 0) return null;
    const open = Boolean(rec.open);
    const fillRaw = rec.fill;
    const fill =
      typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
    if (open && fill == null) return null;
    slots.push({
      index,
      lots: clampSlotLots(lots),
      open,
      fill: open ? fill : null,
    });
  }
  return slots;
}

function sanitizeLogs(raw: unknown): LadderPersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: LadderPersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as LadderLogKind) ? (rec.kind as LadderLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 60) break;
  }
  return out;
}

export function sanitizeLadderEngine(raw: unknown): LadderEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const optionType: OptionType | null =
    rec.optionType === "CE" || rec.optionType === "PE" ? rec.optionType : null;
  if (!optionType) return null;
  const sizeMult = SIZE_MULTS.includes(rec.sizeMult as SizeMult) ? (rec.sizeMult as SizeMult) : null;
  if (!sizeMult) return null;
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
  if (t1?.open && t1.fill != null && t1.fill > 0) {
    t1Fill = t1Fill ?? t1.fill;
  }
  const strikeRaw = rec.strike;
  const strike =
    typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0
      ? strikeRaw
      : null;
  const t1GridLocked =
    typeof rec.t1GridLocked === "boolean"
      ? rec.t1GridLocked
      : Boolean(t1?.open && t1Fill != null);
  const engine: LadderEngineState = {
    optionType,
    sizeMult,
    entryMode,
    manualStrikeOffset,
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    awaitReload: Boolean(rec.awaitReload),
    slots,
    t1Fill,
    t1GridLocked,
    strike,
    hardSlPx: sanitizePrice(rec.hardSlPx),
  };
  if (engine.awaitReload && slotsFullyOpen(engine.slots)) {
    engine.awaitReload = false;
  }
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) {
    return null;
  }
  if (engine.awaitReload && (engine.strike == null || engine.t1Fill == null)) {
    return null;
  }
  return engine;
}

export function parseLadderSession(raw: unknown, today: string): LadderPersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeLadderEngine(rec.engine);
  if (!engine || !ladderSessionActive(engine)) return null;
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

function readLadderStoreRaw(): string | null {
  try {
    const s = sessionStorage.getItem(LADDER_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(LADDER_STORE_KEY);
  } catch {
    return null;
  }
}

function writeLadderStoreRaw(raw: string): void {
  try {
    sessionStorage.setItem(LADDER_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(LADDER_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeLadderStoreRaw(): void {
  try {
    sessionStorage.removeItem(LADDER_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LADDER_STORE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadLadderSession(nowMs: number = Date.now()): LadderPersisted | null {
  try {
    const raw = readLadderStoreRaw();
    if (!raw) return null;
    const parsed = parseLadderSession(JSON.parse(raw), istCalendarDay(nowMs));
    if (!parsed) {
      removeLadderStoreRaw();
      return null;
    }
    return parsed;
  } catch {
    removeLadderStoreRaw();
    return null;
  }
}

export function saveLadderSession(snap: LadderPersisted): void {
  if (!ladderSessionActive(snap.engine)) {
    clearLadderSession();
    return;
  }
  try {
    writeLadderStoreRaw(
      JSON.stringify({
        v: 1,
        day: snap.day,
        iid: snap.iid,
        engine: {
          ...snap.engine,
          slots: snap.engine.slots.map((s) => ({ ...s })),
        },
        logs: snap.logs.slice(0, 60),
        nextLogId: snap.nextLogId,
      } satisfies LadderPersisted),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearLadderSession(): void {
  removeLadderStoreRaw();
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
