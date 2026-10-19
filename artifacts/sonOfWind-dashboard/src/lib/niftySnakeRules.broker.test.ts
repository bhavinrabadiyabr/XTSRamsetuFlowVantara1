/**
 * Broker qty read for Nifty Snake square-off.
 * Run: node --experimental-strip-types src/lib/niftySnakeRules.broker.test.ts
 */
import { readBrokerNetQty } from "./niftySnakeRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const IID = 44012;

const empty = readBrokerNetQty([], IID);
assert(empty.bookEmpty && empty.netQty === 0, "empty book is unknown");

const missing = readBrokerNetQty([{ ExchangeInstrumentID: 99, Quantity: -65 }], IID);
assert(!missing.bookEmpty && missing.netQty === 0, "other contracts stay a real flat read");

const hiddenQty = readBrokerNetQty(
  [{ ExchangeInstrumentID: IID, NetPosition: 0, Quantity: -520, OpenBuyQuantity: 5720, OpenSellQuantity: 5720 }],
  IID,
);
assert(hiddenQty.netQty === -520, "0 NetPosition must not hide live Quantity");

const openSell = readBrokerNetQty(
  [{ ExchangeInstrumentID: String(IID), NetPosition: "0", Quantity: "0", OpenBuyQuantity: "0", OpenSellQuantity: "520" }],
  IID,
);
assert(openSell.netQty === -520, "open sell is the short when net fields are 0");

const split = readBrokerNetQty(
  [
    { ExchangeInstrumentID: IID, NetPosition: 0, Quantity: 0, OpenBuyQuantity: 520, OpenSellQuantity: 520 },
    { ExchangeInstrumentId: IID, Quantity: -520 },
  ],
  IID,
);
assert(split.netQty === -520, "sum every row for the locked contract");

console.log("niftySnake broker qty ok");
