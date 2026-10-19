/**
 * Lightweight assertions for Nifty Snake Both Side (bothside70).
 * Run: node --experimental-strip-types src/lib/niftySnakeBothSideRules.test.ts
 */
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  PROFILE_ID,
  applyFilledAction,
  bookLevelA,
  bookLevelB,
  hardSlFromBase,
  idleEngineState,
  lotsForExtra,
  lotsForT1,
  planTick,
  sellLevelA,
  sellLevelB,
  t1CoverPrice,
} from "./niftySnakeBothSideRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(PROFILE_ID === "bothside70", "profile id");
assert(BAND_LOW === 70 && BAND_HIGH === 75 && BAND_TARGET === 72.5, "70–75 band");
assert(lotsForT1(1) === 8, "T1 lots");
assert(lotsForExtra(1, 1) === 3 && lotsForExtra(3, 1) === 4, "Ladder-70 extras");
assert(lotsForExtra(6, 1) === 3 && lotsForExtra(7, 1) === 3, "past A6 repeats 3");

const F = 72.5;
assert(sellLevelA(F, 1) === 75.5 && bookLevelA(75.5) === 72.5, "T-A1");
assert(sellLevelA(F, 2) === 78.5 && bookLevelA(78.5) === 75.5, "T-A2");
assert(sellLevelB(F, 1) === 69.5 && bookLevelB(69.5) === 65.5, "T-B1");
assert(sellLevelB(F, 2) === 66.5 && bookLevelB(66.5) === 62.5, "T-B2");
assert(t1CoverPrice(F) === 50.75, "T1 cover");
assert(hardSlFromBase(F) === 94.25, "hard SL until cheaper T-B");

let st = idleEngineState("CE", 1);
st = applyFilledAction(st, { kind: "enter_t1", pick: { strike: 24500, ltp: F, optionType: "CE" } }, F);
const action = planTick({
  nowMs: Date.parse("2026-09-21T04:00:00Z"),
  armed: true,
  awaitRestart: false,
  awaitResell: false,
  resellLegs: [],
  hardSlPx: null,
  t1Fill: F,
  slots: st.slots,
  ltp: 75.5,
  huntPick: null,
  sizeMult: 1,
});
assert(action?.kind === "add" && action.arm === "A" && action.index === 1 && action.lots === 3, "T-A1 add 3 lots");

console.log("niftySnakeBothSideRules.test.ts: all assertions passed");
