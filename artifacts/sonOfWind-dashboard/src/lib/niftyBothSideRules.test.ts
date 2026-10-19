/**
 * Lightweight node assertions for Nifty Ladder Both Side grid math / planTick.
 * Run: node --experimental-strip-types artifacts/sonOfWind-dashboard/src/lib/niftyBothSideRules.test.ts
 * (or via tsx if available)
 */
import {
  applyFilledAction,
  bookLevelA,
  bookLevelB,
  canAddLots,
  capLots,
  cheapestOpenFill,
  emptySlots,
  hardSlFromBase,
  idleEngineState,
  lotsForExtra,
  lotsForT1,
  planTick,
  plannedEntry,
  sellLevelA,
  sellLevelB,
  t1CoverPrice,
} from "./niftyBothSideRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(lotsForT1(1) === 8, "T1 1x lots");
assert(lotsForT1(2) === 16, "T1 2x lots");
assert(lotsForExtra(1, 1) === 2, "A1 lots");
assert(lotsForExtra(5, 1) === 3, "A5 lots");
assert(lotsForExtra(8, 1) === 4, "A8 lots");
assert(lotsForExtra(9, 1) === 4, "A9 repeats last");
assert(capLots(1) === 30 && capLots(3) === 90, "hard cap");

assert(sellLevelA(100, 1) === 103, "T-A1 entry");
assert(sellLevelB(100, 1) === 97, "T-B1 entry");
assert(bookLevelA(103) === 100, "T-A book −3");
assert(bookLevelB(97) === 93, "T-B book −4");
assert(t1CoverPrice(100) === 70, "T1 cover");
assert(hardSlFromBase(97) === 97 * 1.3, "hard SL from cheapest");

let st = idleEngineState("CE", 1);
st = applyFilledAction(st, { kind: "enter_t1", pick: { strike: 24500, ltp: 100, optionType: "CE" } }, 100);
assert(st.t1Fill === 100 && st.slots.find((s) => s.key === "T1")?.open, "T1 open");

let action = planTick({
  nowMs: Date.parse("2026-09-21T04:00:00Z"), // ~09:30 IST
  armed: true,
  awaitRestart: false,
  awaitResell: false,
  resellLegs: [],
  hardSlPx: null,
  t1Fill: 100,
  slots: st.slots,
  ltp: 103,
  huntPick: null,
  sizeMult: 1,
});
assert(action?.kind === "add" && action.arm === "A" && action.index === 1, "spike fills T-A1");

st = applyFilledAction(st, action!, 103);
action = planTick({
  nowMs: Date.parse("2026-09-21T04:00:00Z"),
  armed: true,
  awaitRestart: false,
  awaitResell: false,
  resellLegs: [],
  hardSlPx: null,
  t1Fill: 100,
  slots: st.slots,
  ltp: 97,
  huntPick: null,
  sizeMult: 1,
});
assert(action?.kind === "add" && action.arm === "B" && action.index === 1, "dump fills T-B1");

st = applyFilledAction(st, action!, 97);
assert(cheapestOpenFill(st.slots) === 97, "cheapest is T-B1");

// LTP 93: next T-B2 entry is 94 → add before book (spec order)
action = planTick({
  nowMs: Date.parse("2026-09-21T04:00:00Z"),
  armed: true,
  awaitRestart: false,
  awaitResell: false,
  resellLegs: [],
  hardSlPx: null,
  t1Fill: 100,
  slots: st.slots,
  ltp: 93,
  huntPick: null,
  sizeMult: 1,
});
assert(action?.kind === "add" && action.arm === "B" && action.index === 2, "dump fills T-B2 before book");

st = applyFilledAction(st, action!, 93);
action = planTick({
  nowMs: Date.parse("2026-09-21T04:00:00Z"),
  armed: true,
  awaitRestart: false,
  awaitResell: false,
  resellLegs: [],
  hardSlPx: null,
  t1Fill: 100,
  slots: st.slots,
  ltp: 93,
  huntPick: null,
  sizeMult: 1,
});
// B1 book=93 and A1 book=100 both hit; same index → A before B
assert(action?.kind === "book" && action.key === "A1", "A1 books first when both A1/B1 hit");

const nearCap = emptySlots(1).map((s) =>
  s.key === "T1" ? { ...s, open: true, fill: 100, lots: 28 } : s,
);
assert(!canAddLots(nearCap, 3, 1), "cap blocks add");
assert(plannedEntry(100, "A", 2) === 106, "T-A2");

console.log("niftyBothSideRules.test.ts: all assertions passed");
