/**
 * 1 min Fast uses the Wish signal against the 09:20 open.
 * Run: node --experimental-strip-types src/lib/oneMinFastRules.test.ts
 */
import { tradeSignal } from "./niftyVwapRules.ts";
import { NIFTY_FAST1, SENSEX_FAST1, entryLog, fast1Desk } from "./oneMinFastRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(NIFTY_FAST1.lotSize === 65, "Nifty lot is 65");
assert(NIFTY_FAST1.defaultQty === 780, "Nifty book starts at 780");
assert(SENSEX_FAST1.lotSize === 20, "Sensex lot is 20");
assert(SENSEX_FAST1.defaultQty === 20, "a fresh Sensex book starts at 20");
assert(fast1Desk("NIFTY") === NIFTY_FAST1, "Nifty desk");
assert(fast1Desk("sensex") === SENSEX_FAST1, "Sensex desk");
assert(fast1Desk("BANKNIFTY") == null, "other indexes do not trade");

assert(tradeSignal(22890, 22880) === "SELL_PE", "spot above the 09:20 open sells PE");
assert(tradeSignal(22870, 22880) === "SELL_CE", "spot below the 09:20 open sells CE");
assert(tradeSignal(22880, 22880) === "NONE", "spot equal to the open is no trade");
assert(tradeSignal(null, 22880) === "NONE", "missing spot is no trade");
assert(tradeSignal(22890, null) === "NONE", "missing open is no trade");

const text = entryLog({
  spot: 22890,
  open: 22880,
  wing: 0,
  side: "PE",
  strike: 22900,
  qty: 780,
  premium: 100,
  target: 10,
});
assert(text.includes("09:20 open"), "the log names the 09:20 open");
assert(!text.includes("VWAP"), "the log is not the VWAP line");

console.log("oneMinFastRules ok");
