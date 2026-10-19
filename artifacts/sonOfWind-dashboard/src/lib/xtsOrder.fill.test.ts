/**
 * A fill is only the traded qty. A reject or a pending order is not a fill.
 * Run: node --experimental-strip-types src/lib/xtsOrder.fill.test.ts
 */
import { orderLooksFilled, orderTradedQty } from "./xtsOrder.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const filled = { result: { OrderStatus: "Filled", CumulativeQuantity: 325, OrderAverageTradedPrice: "151.9" } };
const rejected = {
  result: { OrderStatus: "Rejected", CumulativeQuantity: 0, CancelRejectReason: "Margin Exceeds" },
};
const pending = { result: { OrderStatus: "Pending", CumulativeQuantity: 0, OrderQuantity: 325 } };

assert(orderLooksFilled(filled, 325), "filled qty counts");
assert(!orderLooksFilled(rejected, 325), "rejection is not a fill");
assert(!orderLooksFilled(pending, 325), "pending is not a fill");
assert(orderTradedQty(filled) === 325, "traded qty is read from the row");
assert(orderTradedQty({ result: { OrderStatus: "Filled", CumulativeQuantity: 100 } }) === 100, "partial traded qty");
assert(orderLooksFilled({ result: { OrderStatus: "Traded", CumulativeQuantity: 0 } }, 195), "traded status is a fill");
assert(!orderLooksFilled({ result: { AppOrderID: 9 } }, 195), "ack without status is not a fill");

console.log("order fill ok");
