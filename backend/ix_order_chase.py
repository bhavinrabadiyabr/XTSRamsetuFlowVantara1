"""If a working order is still pending, cancel it and send the unfilled qty as a market order."""

from __future__ import annotations

from typing import Any, Callable


def _as_rec(v: Any) -> dict[str, Any] | None:
    return v if isinstance(v, dict) else None


def order_rows(raw: Any) -> list[dict[str, Any]]:
    top = _as_rec(raw)
    if not top:
        return []
    src = _as_rec(top.get("raw")) or top
    inner = src.get("result")
    if inner is None:
        inner = src.get("Result")
    if inner is None:
        inner = src
    if isinstance(inner, list):
        return [r for r in inner if isinstance(r, dict)]
    rec = _as_rec(inner)
    if not rec:
        return []
    lst = rec.get("list") or rec.get("orderList") or rec.get("OrderList")
    if isinstance(lst, list):
        return [r for r in lst if isinstance(r, dict)]
    return [rec]


def _opt_int(row: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        if key not in row or row.get(key) in (None, ""):
            continue
        try:
            return int(float(str(row.get(key)).replace(",", "").strip()))
        except (TypeError, ValueError):
            continue
    return None


_TRADED_QTY_KEYS = (
    "CumulativeQuantity",
    "cumulativeQuantity",
    "OrderQuantityTraded",
    "orderQuantityTraded",
    "FilledQuantity",
    "filledQuantity",
    "TradedQuantity",
    "tradedQuantity",
    "TotalTradedQuantity",
)


def explicit_traded_qty(raw: Any) -> int | None:
    """Highest traded-qty field. None when every row omits those fields."""
    found = False
    best = 0
    for row in order_rows(raw):
        for key in _TRADED_QTY_KEYS:
            if key not in row or row.get(key) in (None, ""):
                continue
            found = True
            traded = _opt_int(row, key)
            if traded is not None and traded > best:
                best = int(traded)
    return best if found else None


def response_traded_qty(raw: Any) -> int:
    return int(explicit_traded_qty(raw) or 0)


def response_is_full_fill(raw: Any, qty: int) -> bool:
    """A resting or rejected order is not a position. Only traded qty or a filled status counts."""
    if int(qty) > 0 and response_traded_qty(raw) >= int(qty):
        return True
    for row in order_rows(raw):
        if status_kind(order_status(row)) == "filled":
            return True
    return False


def wish_filled_qty(raw: Any, order_qty: int) -> int:
    """Shares to book. A filled status with no traded field uses the order qty.

    Cancelled or rejected with traded quantity 0 books nothing. A partial
    traded quantity is kept. 16388 with a full traded quantity is a fill.
    """
    order_qty = int(order_qty)
    if order_qty <= 0:
        return 0
    explicit = explicit_traded_qty(raw)
    if explicit is not None and explicit >= order_qty:
        return order_qty
    filled_status = False
    for row in order_rows(raw):
        if status_kind(order_status(row)) == "filled":
            filled_status = True
            break
    if filled_status:
        if explicit is None or explicit <= 0:
            return order_qty
        return min(order_qty, int(explicit))
    if explicit is not None and explicit > 0:
        return min(order_qty, int(explicit))
    return 0


def order_row_for(raw: Any, app_order_id: int, unique_id: str) -> dict[str, Any] | None:
    want = int(app_order_id or 0)
    if want > 0:
        found = row_for_app_id(raw, want)
        if isinstance(found, dict):
            return found
    uniq = str(unique_id or "").strip()
    if not uniq:
        return None
    for row in order_rows(raw):
        if order_unique_id(row) == uniq:
            return row
    return None


def _wrapped(row: dict[str, Any] | None, fallback: Any) -> Any:
    if isinstance(row, dict):
        return {"type": "success", "result": row}
    return fallback


def _row_open(row: dict[str, Any] | None) -> bool:
    if not isinstance(row, dict):
        return False
    kind = status_kind(order_status(row))
    if kind in {"filled", "dead"}:
        return False
    return kind in {"resting", "unknown"} or not order_status(row)


def settle_book_only_fill(
    place_res: Any,
    *,
    order_qty: int,
    app_order_id: int,
    unique_id: str,
    fetch_book: Callable[[], Any],
    cancel: Callable[[], None],
    sleep: Callable[[float], None],
    rounds: int = 4,
    pause_s: float = 0.3,
) -> dict[str, Any]:
    """Book a Wish order only when it trades. Do not leave the remainder working.

    Full fill on the place response is returned at once. Otherwise the order
    book is read `rounds` times. Anything short of a full fill is cancelled.
    A refused cancel that is still open is not a flat book.
    """
    qty = int(order_qty)

    def pack(raw: Any, filled: int, *, ok: bool, error: str | None) -> dict[str, Any]:
        return {"ok": ok, "filled_qty": int(filled) if ok else 0, "raw": raw, "error": error}

    filled = wish_filled_qty(place_res, qty)
    if filled >= qty:
        return pack(place_res, filled, ok=True, error=None)
    row = order_row_for(place_res, app_order_id, unique_id) or _response_row(place_res)
    if isinstance(row, dict) and status_kind(order_status(row)) == "dead":
        if filled > 0:
            return pack(_wrapped(row, place_res), filled, ok=True, error=None)
        return pack(place_res, 0, ok=False, error=None)

    last_raw = place_res
    last_row = row if isinstance(row, dict) else None
    for _ in range(max(1, int(rounds))):
        if pause_s > 0:
            sleep(pause_s)
        try:
            book = fetch_book()
        except Exception:
            book = None
        found = order_row_for(book, app_order_id, unique_id)
        if not isinstance(found, dict):
            continue
        last_row = found
        last_raw = _wrapped(found, place_res)
        filled = wish_filled_qty(last_raw, qty)
        if filled >= qty:
            return pack(last_raw, filled, ok=True, error=None)
        if status_kind(order_status(found)) == "dead":
            if filled > 0:
                return pack(last_raw, filled, ok=True, error=None)
            return pack(last_raw, 0, ok=False, error=None)

    filled = wish_filled_qty(last_raw, qty)
    cancelled = False
    if int(app_order_id or 0) > 0:
        try:
            cancel()
            cancelled = True
        except Exception:
            cancelled = False
        try:
            book = fetch_book()
        except Exception:
            book = None
        found = order_row_for(book, app_order_id, unique_id)
        if isinstance(found, dict):
            last_row = found
            last_raw = _wrapped(found, last_raw)
            filled = wish_filled_qty(last_raw, qty)
            if filled >= qty:
                return pack(last_raw, filled, ok=True, error=None)
        elif cancelled:
            last_row = None
    if filled > 0:
        return pack(last_raw, filled, ok=True, error=None)
    if int(app_order_id or 0) > 0 and _row_open(last_row):
        return pack(last_raw, 0, ok=False, error="Pending order could not be cancelled")
    return pack(last_raw, 0, ok=False, error=None)


def traded_response(place_res: Any, history_res: Any, qty: int) -> Any | None:
    """Place acks are often only an AppOrderID. History is what shows the fill.

    Returns a bookable payload when any contracts traded. None when the order
    is still unfilled, so the caller can cancel it instead of leaving a rest.
    """
    if response_traded_qty(place_res) > 0 or response_is_full_fill(place_res, qty):
        return place_res
    aid = app_order_id_from(place_res)
    row = row_for_app_id(history_res, aid) if aid else None
    if not isinstance(row, dict):
        return None
    wrapped: dict[str, Any] = {"type": "success", "result": row}
    if response_traded_qty(wrapped) > 0 or response_is_full_fill(wrapped, qty):
        return wrapped
    return None


def app_order_id_from(raw: Any) -> int:
    if not isinstance(raw, dict):
        return 0
    n = _opt_int(raw, "AppOrderID", "appOrderID", "appOrderId", "OrderID", "orderID")
    if n:
        return int(n)
    for row in order_rows(raw):
        if row is raw:
            continue
        found = _opt_int(row, "AppOrderID", "appOrderID", "appOrderId", "OrderID", "orderID")
        if found:
            return int(found)
    return 0


def order_unique_id(row: dict[str, Any], fallback: str = "") -> str:
    for key in ("OrderUniqueIdentifier", "orderUniqueIdentifier"):
        v = row.get(key)
        if v is not None and str(v).strip():
            return str(v).strip()
    return str(fallback or "").strip()


def normalize_status(status: str) -> str:
    return "".join(ch for ch in str(status or "").upper() if ch.isalnum())


def order_status(row: dict[str, Any]) -> str:
    return normalize_status(str(row.get("OrderStatus") or row.get("orderStatus") or ""))


def status_kind(status: str) -> str:
    """filled | resting | dead | unknown"""
    s = normalize_status(status)
    if not s:
        return "unknown"
    if "PARTIAL" in s:
        return "resting"
    if s in {"FILLED", "COMPLETE", "COMPLETED", "TRADED"} or s.startswith("FILL"):
        return "filled"
    if "REJECT" in s or s.startswith("CANCEL"):
        return "dead"
    if "PENDING" in s or s in {"NEW", "OPEN", "REPLACED", "TRIGGERPENDING"}:
        return "resting"
    return "unknown"


def remaining_to_execute(row: dict[str, Any], fallback_qty: int = 0) -> int:
    """Qty still to send. Cancelled rows often zero LeavesQuantity while the qty never traded."""
    if status_kind(order_status(row)) == "filled":
        return 0
    qty = _opt_int(row, "OrderQuantity", "orderQuantity")
    traded = _opt_int(
        row,
        "CumulativeQuantity",
        "cumulativeQuantity",
        "OrderQuantityTraded",
        "FilledQuantity",
        "TotalTradedQuantity",
    )
    if qty is not None:
        return max(0, int(qty) - int(traded or 0))
    leaves = _opt_int(row, "LeavesQuantity", "leavesQuantity")
    if leaves is not None:
        return max(0, int(leaves))
    if status_kind(order_status(row)) in {"resting", "dead"}:
        return max(0, int(fallback_qty))
    return 0


def is_resting(row: dict[str, Any] | None, fallback_qty: int = 0) -> bool:
    if not isinstance(row, dict):
        return False
    if status_kind(order_status(row)) != "resting":
        return False
    return remaining_to_execute(row, fallback_qty) > 0


def row_for_app_id(raw: Any, app_order_id: int) -> dict[str, Any] | None:
    want = int(app_order_id)
    rows = order_rows(raw)
    if not rows:
        return None
    exact = [r for r in rows if app_order_id_from(r) == want]
    if exact:
        filled = [r for r in exact if status_kind(order_status(r)) == "filled"]
        if filled:
            return filled[-1]
        return exact[-1]
    if len(rows) == 1 and app_order_id_from(rows[0]) == 0:
        return rows[0]
    return None


def _as_raw(row: dict[str, Any] | None, place_res: Any) -> Any:
    if isinstance(row, dict):
        return {"type": "success", "result": row}
    return place_res


def _poll(fetch: Callable[[int], Any], app_id: int, sleep: Callable[[float], None], pause_s: float, rounds: int) -> dict[str, Any] | None:
    last: dict[str, Any] | None = None
    for _ in range(max(1, int(rounds))):
        if pause_s > 0:
            sleep(pause_s)
        try:
            raw = fetch(int(app_id))
        except Exception:
            raw = None
        row = raw if isinstance(raw, dict) and ("OrderStatus" in raw or "orderStatus" in raw) else row_for_app_id(raw, app_id)
        if isinstance(row, dict):
            got = app_order_id_from(row)
            if got and got != int(app_id):
                continue
            last = row
            if not is_resting(row):
                return row
    return last


def _response_row(raw: Any) -> dict[str, Any] | None:
    app_id = app_order_id_from(raw)
    if app_id > 0:
        row = row_for_app_id(raw, app_id)
        if isinstance(row, dict):
            return row
    rows = order_rows(raw)
    if len(rows) == 1 and ("OrderStatus" in rows[0] or "orderStatus" in rows[0]):
        return rows[0]
    return None


def _is_done(row: dict[str, Any] | None, qty: int) -> bool:
    """Filled, or no quantity left to send. A resting or unfilled cancel is not done."""
    if not isinstance(row, dict):
        return False
    if is_resting(row, qty):
        return False
    return remaining_to_execute(row, qty) <= 0


# Original order plus this many same-side resends. Each resend happens only after the previous one is dead.
_MAX_RESENDS = 4


def _working_outcome(
    place_res: Any,
    *,
    order_qty: int,
    fetch: Callable[[int], Any],
    cancel: Callable[[dict[str, Any]], Any],
    sleep: Callable[[float], None],
    pause_s: float,
) -> dict[str, Any]:
    """done: nothing left to send. replace: this order is dead and qty is still open. error: leave it alone."""
    app_id = app_order_id_from(place_res)
    if app_id <= 0:
        return {"kind": "done", "raw": place_res}

    row = _poll(fetch, app_id, sleep, pause_s, 2)
    if row is not None and status_kind(order_status(row)) == "dead":
        qty = remaining_to_execute(row, order_qty)
        if qty > 0:
            return {"kind": "replace", "qty": int(qty), "raw": _as_raw(row, place_res)}
        return {"kind": "done", "raw": _as_raw(row, place_res)}
    # No history, or a row with no status, is not proof the order died unfilled.
    # Sending another order here doubles a fill that the book has not shown yet.
    if row is None or status_kind(order_status(row)) == "unknown":
        return {
            "kind": "error",
            "raw": _as_raw(row, place_res) if row is not None else place_res,
            "error": "Order status confirm nahi hua — doosra order nahi bheja",
        }
    if not is_resting(row, order_qty):
        return {"kind": "done", "raw": _as_raw(row, place_res)}

    try:
        cancel(row)
    except Exception as e:
        again = _poll(fetch, app_id, sleep, 0.0, 1)
        if again is not None and not is_resting(again, order_qty):
            qty = remaining_to_execute(again, 0)
            if qty <= 0:
                return {"kind": "done", "raw": _as_raw(again, place_res)}
            return {"kind": "replace", "qty": int(qty), "raw": _as_raw(again, place_res)}
        return {"kind": "error", "raw": place_res, "error": f"Pending order cancel nahi hua: {e}"}

    after = _poll(fetch, app_id, sleep, min(0.2, pause_s) if pause_s else 0.0, 3)
    if after is None:
        return {
            "kind": "error",
            "raw": place_res,
            "error": "Pending cancel ke baad order status nahi mila — market order nahi bheja",
        }
    if is_resting(after, order_qty):
        return {
            "kind": "error",
            "raw": _as_raw(after, place_res),
            "error": "Order ab bhi pending hai — doosra order nahi bheja",
        }
    qty = remaining_to_execute(after, order_qty)
    if qty <= 0:
        return {"kind": "done", "raw": _as_raw(after, place_res)}
    return {"kind": "replace", "qty": int(qty), "raw": _as_raw(after, place_res)}


def chase_resting_order(
    place_res: Any,
    *,
    order_qty: int,
    fetch: Callable[[int], Any],
    cancel: Callable[[dict[str, Any]], Any],
    place_market: Callable[[int], Any],
    sleep: Callable[[float], None],
    pause_s: float = 0.3,
) -> dict[str, Any]:
    """
    A pending order is cancelled and the unfilled qty is sent again on the same side.
    The resend is repeated until it fills. A new order is sent only after the previous one is dead.
    """
    current = place_res
    qty = int(order_qty)
    chased = False
    market_qty = 0
    for resend in range(_MAX_RESENDS + 1):
        outcome = _working_outcome(
            current,
            order_qty=qty,
            fetch=fetch,
            cancel=cancel,
            sleep=sleep,
            pause_s=pause_s,
        )
        if outcome["kind"] == "done":
            return {"raw": outcome["raw"], "chased": chased, "market_qty": market_qty, "error": None}
        if outcome["kind"] == "error":
            return {
                "raw": outcome["raw"],
                "chased": chased,
                "market_qty": market_qty,
                "error": outcome["error"],
            }
        left = int(outcome["qty"])
        if resend >= _MAX_RESENDS:
            return {
                "raw": outcome["raw"],
                "chased": chased,
                "market_qty": market_qty,
                "error": "Order fill nahi hua. Pending XTS me nahi chhoda.",
            }
        current = place_market(left)
        qty = left
        market_qty = left
        chased = True
        placed = _response_row(current)
        if _is_done(placed, left):
            return {"raw": current, "chased": True, "market_qty": left, "error": None}
    return {
        "raw": current,
        "chased": chased,
        "market_qty": market_qty,
        "error": "Order fill nahi hua. Pending XTS me nahi chhoda.",
    }
