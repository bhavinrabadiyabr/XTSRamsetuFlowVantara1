/**
 * Strike band + qty for Nifty Flip.
 * Run: node --experimental-strip-types src/lib/niftyFlipRules.test.ts
 */
import {
  DEFAULT_QTY,
  FLIP_RATIOS,
  LOT_SIZE,
  autoFlipAction,
  oppositeSide,
  pickHighestInBand,
  resolveOrderQty,
  shortMtm,
  sideForSignal,
  type FlipChainRow,
} from "./niftyFlipRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const rows: FlipChainRow[] = [
  { strike: 24500, ltp: 92, instrumentId: 1 },
  { strike: 24550, ltp: 81, instrumentId: 2 },
  { strike: 24600, ltp: 99.5, instrumentId: 3 },
  { strike: 24650, ltp: 101, instrumentId: 4 },
  { strike: 24400, ltp: 70, instrumentId: 5 },
  { strike: 24450, ltp: 79, instrumentId: 9 },
  { strike: 24350, ltp: 59, instrumentId: 6 },
  { strike: 24300, ltp: 44, instrumentId: 7 },
  { strike: 24250, ltp: null, instrumentId: 8 },
  { strike: 24200, ltp: 88, instrumentId: null },
];

const hi = pickHighestInBand(rows, 80, 100);
assert(hi?.strike === 24600 && hi.ltp === 99.5, "80-100 takes the higher LTP");
assert(pickHighestInBand(rows, 60, 79)?.strike === 24450, "60-79 takes 79 over 70");
assert(pickHighestInBand(rows, 60, 79)?.ltp === 79, "79 is inside 60-79");
assert(pickHighestInBand(rows, 45, 59)?.strike === 24350, "45-59 inclusive 59");
assert(pickHighestInBand(rows, 80, 100)?.instrumentId !== 4, "101 is outside 80-100");

const tied: FlipChainRow[] = [
  { strike: 24000, ltp: 90, instrumentId: 11 },
  { strike: 24100, ltp: 90, instrumentId: 12 },
];
assert(pickHighestInBand(tied, 80, 100)?.strike === 24100, "equal LTP keeps higher strike");
const twoInBand: FlipChainRow[] = [
  { strike: 25000, ltp: 82, instrumentId: 21 },
  { strike: 24950, ltp: 97, instrumentId: 22 },
];
assert(pickHighestInBand(twoInBand, 80, 100)?.strike === 24950 && pickHighestInBand(twoInBand, 80, 100)?.ltp === 97, "two strikes in band: higher price wins");
assert(pickHighestInBand([], 80, 100) === null, "empty band");

const base = resolveOrderQty(String(DEFAULT_QTY), 1);
assert("qty" in base && base.qty === 780 && base.base === 780, "default 780");
const x2 = resolveOrderQty("780", 2);
assert("qty" in x2 && x2.qty === 1560, "2x doubles qty");
const x3 = resolveOrderQty("780", 3);
assert("qty" in x3 && x3.qty === 2340, "3x triples qty");
assert("error" in resolveOrderQty("100", 1), "reject non lot multiple");
assert("error" in resolveOrderQty("0", 1), "reject zero");
assert("error" in resolveOrderQty("", 2), "reject empty");
assert(DEFAULT_QTY % LOT_SIZE === 0, "780 is 12 lots of 65");
assert(oppositeSide("PE") === "CE" && oppositeSide("CE") === "PE", "flip side");
assert(shortMtm(90, 80, 780) === 7800, "short profit when premium falls");
assert(shortMtm(90, 100, 780) === -7800, "short loss when premium rises");
assert(FLIP_RATIOS.length === 3, "three ratios");
assert(sideForSignal("BULL") === "PE" && sideForSignal("BEAR") === "CE", "signal side");
assert(autoFlipAction(null, null) === "hold", "no signal holds");
assert(autoFlipAction("BULL", null) === "enter", "flat bull enters");
assert(autoFlipAction("BEAR", null) === "enter", "flat bear enters");
assert(autoFlipAction("BULL", "PE") === "hold", "already short PE on bull");
assert(autoFlipAction("BEAR", "CE") === "hold", "already short CE on bear");
assert(autoFlipAction("BEAR", "PE") === "flip", "bull short flips on bear");
assert(autoFlipAction("BULL", "CE") === "flip", "bear short flips on bull");

console.log("niftyFlipRules.test.ts: all assertions passed");
