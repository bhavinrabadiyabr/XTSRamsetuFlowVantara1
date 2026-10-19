/**
 * Nifty Wish VWAP desk rules.
 * Run: node --experimental-strip-types src/lib/niftyVwapRules.test.ts
 */
import {
  averageFill,
  badPremiumTick,
  bookPx,
  entryLog,
  lotQty,
  orderButtonText,
  profitPoints,
  sellStrike,
  sizedQty,
  slPriceHit,
  targetHit,
  tradeSignal,
  wingStrikes,
} from "./niftyVwapRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(tradeSignal(24510.2, 24500) === "SELL_PE", "above VWAP sells PE");
assert(tradeSignal(24490, 24500) === "SELL_CE", "below VWAP sells CE");
assert(tradeSignal(24500, 24500) === "NONE", "equal is no trade");
assert(tradeSignal(null, 24500) === "NONE", "missing spot is no trade");
assert(tradeSignal(24510, 0) === "NONE", "missing VWAP is no trade");

const legs = wingStrikes(24500, 0, 50);
assert(legs.ce === 24500 && legs.pe === 24500, "wing 0 is ATM both sides");
assert(sellStrike(24500, 2, 50, "CE") === 24600, "wing 2 lifts CE");
assert(sellStrike(24500, 2, 50, "PE") === 24400, "wing 2 drops PE");

assert(lotQty("780") === 780, "780 is 12 lots");
assert(lotQty("240", 20) === 240, "Sensex 240 is 12 lots of 20");
assert(lotQty("65", 20) === null, "65 is not a Sensex lot");
assert(sizedQty("240", 2, 20) === 480, "240 × 2 = 480");
assert(lotQty("100") === null, "100 is not a lot multiple");
assert(lotQty("") === null, "blank qty is refused");
assert(sizedQty("780", 2) === 1560, "780 × 2 = 1560");

assert(
  orderButtonText({ signal: "SELL_PE", wing: 0, strike: 24500, premium: 120.5, openSide: null }) ===
    "SELL ATM PE 24500 @ 120.50",
  "flat ATM button",
);
assert(
  orderButtonText({ signal: "SELL_PE", wing: 1, strike: 24450, premium: 80, openSide: null }) ===
    "SELL PE 24450 @ 80.00",
  "wing button drops ATM",
);
assert(
  orderButtonText({ signal: "SELL_CE", wing: 1, strike: 24550, premium: 90, openSide: "PE" }) === "PE OPEN",
  "an open short shows OPEN and does not sell again",
);
assert(
  orderButtonText({ signal: "SELL_PE", wing: 0, strike: 24500, premium: 80, openSide: "PE" }) === "PE OPEN",
  "same side is OPEN",
);
assert(orderButtonText({ signal: "NONE", wing: 0, strike: 24500, premium: 1, openSide: null }) === "NO TRADE", "flat equal");

assert(
  entryLog({
    spot: 24510.2,
    vwap: 24500,
    wing: 0,
    side: "PE",
    strike: 24500,
    qty: 780,
    premium: 120.5,
    target: 10,
  }) === "spot 24510.20 vs VWAP 24500.00: SELL ATM PE 24,500 × 780 @ 120.50 · target 10",
  "entry log",
);

assert(targetHit(120.5, 110.5, 10), "target books when points reach it");
assert(!targetHit(120.5, 110.6, 10), "target waits under the line");
assert(!targetHit(120.5, 100, null), "blank target is off");
assert(bookPx(120.5, 10) === 110.5, "book price is fill minus target");

assert(badPremiumTick(120, 0.2), "bad tick under 0.50 with fill >= 5");
assert(!badPremiumTick(4, 0.2), "cheap fill does not use the bad-tick guard");
assert(!badPremiumTick(120, 0.5), "0.50 is a real tick");

assert(slPriceHit(70, 70), "SL hits when LTP reaches the price");
assert(slPriceHit(70.05, 70), "SL hits when LTP trades through the price");
assert(!slPriceHit(69.95, 70), "SL waits under the price");
assert(!slPriceHit(80, null), "blank SL is off");
assert(!slPriceHit(0, 70), "missing premium does not hit");

assert(averageFill(100, 780, 110, 65) === 100.77, "add recomputes the average");
assert(profitPoints(120.5, 116.3) === 4.2, "profit points");

console.log("niftyVwapRules ok");
