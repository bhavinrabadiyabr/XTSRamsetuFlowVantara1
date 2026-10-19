"""Pending working orders are cancelled and only the unfilled qty is resent."""

from ix_order_chase import (
    chase_resting_order,
    remaining_to_execute,
    row_for_app_id,
    settle_book_only_fill,
    status_kind,
    traded_response,
    wish_filled_qty,
)


def _chase(states, *, order_qty=65, cancel_error=None):
    seq = list(states)
    cancelled = []
    markets = []

    def fetch(_app_id):
        if not seq:
            return states[-1]
        return seq.pop(0)

    def cancel(row):
        if cancel_error:
            raise RuntimeError(cancel_error)
        cancelled.append(row)

    def place_market(qty):
        markets.append(qty)
        return {"type": "success", "result": {"AppOrderID": 99, "OrderStatus": "Filled", "OrderAverageTradedPrice": "10"}}

    out = chase_resting_order(
        {"type": "success", "result": {"AppOrderID": 7, "OrderUniqueIdentifier": "OPT1"}},
        order_qty=order_qty,
        fetch=fetch,
        cancel=cancel,
        place_market=place_market,
        sleep=lambda _s: None,
        pause_s=0,
    )
    return out, cancelled, markets


def _row(status, qty=65, traded=0, leaves=None):
    row = {"AppOrderID": 7, "OrderStatus": status, "OrderQuantity": qty, "CumulativeQuantity": traded}
    if leaves is not None:
        row["LeavesQuantity"] = leaves
    return row


def test_ack_without_status_books_the_history_fill():
    ack = {"type": "success", "result": {"AppOrderID": 7}}
    history = {
        "type": "success",
        "result": [
            {"AppOrderID": 7, "OrderStatus": "Pending", "OrderQuantity": 65, "CumulativeQuantity": 0},
            {
                "AppOrderID": 7,
                "OrderStatus": "Filled",
                "OrderQuantity": 65,
                "CumulativeQuantity": 65,
                "OrderAverageTradedPrice": "66.55",
            },
        ],
    }
    booked = traded_response(ack, history, 65)
    assert booked is not None
    assert booked["result"]["OrderStatus"] == "Filled"
    assert traded_response(ack, {"type": "success", "result": [_row("Pending")]}, 65) is None


def test_history_prefers_filled_over_an_older_pending_snapshot():
    raw = {
        "type": "success",
        "result": [
            {"AppOrderID": 7, "OrderStatus": "Pending", "OrderQuantity": 65, "CumulativeQuantity": 0},
            {"AppOrderID": 7, "OrderStatus": "Filled", "OrderQuantity": 65, "CumulativeQuantity": 65},
            {"AppOrderID": 8, "OrderStatus": "Pending", "OrderQuantity": 65, "CumulativeQuantity": 0},
        ],
    }
    row = row_for_app_id(raw, 7)
    assert row is not None and row["OrderStatus"] == "Filled"


def test_status_kinds():
    assert status_kind("Pending") == "resting"
    assert status_kind("Partially Filled") == "resting"
    assert status_kind("Filled") == "filled"
    assert status_kind("Cancelled") == "dead"


def test_cancelled_leaves_zero_still_counts_untraded_qty():
    assert remaining_to_execute(_row("Cancelled", qty=65, traded=0, leaves=0)) == 65
    assert remaining_to_execute(_row("Cancelled", qty=65, traded=25, leaves=0)) == 40
    assert remaining_to_execute(_row("Filled", qty=65, traded=65, leaves=0)) == 0


def test_ioc_cancel_is_resent_without_a_second_cancel():
    out, cancelled, markets = _chase([_row("Cancelled", traded=0, leaves=0)])
    assert cancelled == []
    assert markets == [65]
    assert out["chased"] is True
    assert out["error"] is None


def test_filled_limit_is_not_chased():
    out, cancelled, markets = _chase([_row("Pending"), _row("Filled", traded=65, leaves=0)])
    assert out["chased"] is False
    assert cancelled == []
    assert markets == []
    assert out["error"] is None


def test_pending_is_cancelled_and_sent_as_market():
    out, cancelled, markets = _chase(
        [
            _row("Pending", leaves=65),
            _row("Pending", leaves=65),
            _row("Cancelled", traded=0, leaves=0),
        ]
    )
    assert len(cancelled) == 1
    assert markets == [65]
    assert out["chased"] is True
    assert out["error"] is None


def test_partial_pending_markets_only_the_rest():
    out, _cancelled, markets = _chase(
        [
            _row("PartiallyFilled", traded=25, leaves=40),
            _row("PartiallyFilled", traded=25, leaves=40),
            _row("Cancelled", traded=25, leaves=0),
        ]
    )
    assert markets == [40]
    assert out["market_qty"] == 40


def test_no_second_order_when_cancel_does_not_land():
    out, _cancelled, markets = _chase(
        [
            _row("Pending", leaves=65),
            _row("Pending", leaves=65),
            _row("Pending", leaves=65),
            _row("Pending", leaves=65),
            _row("Pending", leaves=65),
        ]
    )
    assert markets == []
    assert out["chased"] is False
    assert "pending" in str(out["error"]).lower()


def test_pending_resend_is_cancelled_and_sent_again_until_filled():
    """A replacement that also rests is cancelled, then the same qty is sent again."""
    books = {
        7: [_row("Pending", leaves=65), _row("Pending", leaves=65), _row("Cancelled", traded=0, leaves=0)],
        99: [
            {"AppOrderID": 99, "OrderStatus": "Pending", "OrderQuantity": 65, "CumulativeQuantity": 0, "LeavesQuantity": 65},
            {"AppOrderID": 99, "OrderStatus": "Pending", "OrderQuantity": 65, "CumulativeQuantity": 0, "LeavesQuantity": 65},
            {"AppOrderID": 99, "OrderStatus": "Cancelled", "OrderQuantity": 65, "CumulativeQuantity": 0, "LeavesQuantity": 0},
        ],
    }
    cancelled = []
    markets = []

    def fetch(app_id):
        seq = books.get(int(app_id)) or []
        if not seq:
            return {"AppOrderID": int(app_id), "OrderStatus": "Filled", "OrderQuantity": 65, "CumulativeQuantity": 65}
        return seq.pop(0)

    def cancel(row):
        cancelled.append(app_order_id(row))

    def place_market(qty):
        markets.append(qty)
        if len(markets) == 1:
            return {
                "type": "success",
                "result": {"AppOrderID": 99, "OrderStatus": "Pending", "OrderQuantity": qty, "CumulativeQuantity": 0},
            }
        return {
            "type": "success",
            "result": {"AppOrderID": 100, "OrderStatus": "Filled", "OrderQuantity": qty, "CumulativeQuantity": qty},
        }

    out = chase_resting_order(
        {"type": "success", "result": {"AppOrderID": 7}},
        order_qty=65,
        fetch=fetch,
        cancel=cancel,
        place_market=place_market,
        sleep=lambda _s: None,
        pause_s=0,
    )
    assert cancelled == [7, 99]
    assert markets == [65, 65]
    assert out["chased"] is True
    assert out["error"] is None
    assert out["raw"]["result"]["AppOrderID"] == 100


def app_order_id(row):
    return int(row["AppOrderID"])


def test_missing_history_does_not_send_another_order():
    out, cancelled, markets = _chase([None, None])
    assert cancelled == []
    assert markets == []
    assert out["chased"] is False
    assert "doosra order nahi" in str(out["error"])


def test_unknown_status_does_not_send_another_order():
    out, cancelled, markets = _chase([{"AppOrderID": 7}, {"AppOrderID": 7}])
    assert cancelled == []
    assert markets == []
    assert out["chased"] is False
    assert "doosra order nahi" in str(out["error"])


def test_missing_app_order_id_does_not_chase():
    markets = []
    out = chase_resting_order(
        {"type": "success", "result": {}},
        order_qty=65,
        fetch=lambda _i: (_ for _ in ()).throw(AssertionError("fetch")),
        cancel=lambda _r: (_ for _ in ()).throw(AssertionError("cancel")),
        place_market=lambda q: markets.append(q),
        sleep=lambda _s: None,
        pause_s=0,
    )
    assert out["chased"] is False
    assert markets == []


def test_cancel_error_but_already_filled_does_not_market():
    out, _cancelled, markets = _chase(
        [
            _row("Open", leaves=65),
            _row("Open", leaves=65),
            _row("Filled", traded=65, leaves=0),
        ],
        cancel_error="order already filled",
    )
    assert markets == []
    assert out["error"] is None
    assert out["chased"] is False


def test_wish_filled_qty_rules():
    assert wish_filled_qty({"result": {"OrderStatus": "Filled", "CumulativeQuantity": 65}}, 65) == 65
    assert wish_filled_qty({"result": {"OrderStatus": "Filled"}}, 65) == 65
    assert wish_filled_qty({"result": {"AppOrderID": 9}}, 65) == 0
    assert wish_filled_qty({"result": {"OrderStatus": "Pending", "CumulativeQuantity": 0}}, 65) == 0
    assert wish_filled_qty({"result": {"OrderStatus": "Cancelled", "CumulativeQuantity": 0, "CancelRejectReason": "16388"}}, 65) == 0
    assert wish_filled_qty({"result": {"OrderStatus": "Cancelled", "TradedQuantity": 65}}, 65) == 65
    assert wish_filled_qty({"result": {"OrderStatus": "PartiallyFilled", "CumulativeQuantity": 20}}, 65) == 20


def test_wish_full_fill_does_not_poll():
    calls = {"book": 0}

    def fetch_book():
        calls["book"] += 1
        return {"result": []}

    out = settle_book_only_fill(
        {"result": {"AppOrderID": 4, "OrderStatus": "Filled", "OrderAverageTradedPrice": "50.8", "CumulativeQuantity": 65}},
        order_qty=65,
        app_order_id=4,
        unique_id="OPT4S",
        fetch_book=fetch_book,
        cancel=lambda: None,
        sleep=lambda _s: None,
    )
    assert out["ok"] is True
    assert out["filled_qty"] == 65
    assert calls["book"] == 0


def test_wish_polls_then_books_full_fill():
    seen = {"n": 0}

    def fetch_book():
        seen["n"] += 1
        status = "Filled" if seen["n"] >= 2 else "Pending"
        traded = 65 if status == "Filled" else 0
        return {"result": [{"AppOrderID": 4, "OrderUniqueIdentifier": "OPT4S", "OrderStatus": status, "CumulativeQuantity": traded}]}

    out = settle_book_only_fill(
        {"result": {"AppOrderID": 4, "OrderUniqueIdentifier": "OPT4S"}},
        order_qty=65,
        app_order_id=4,
        unique_id="OPT4S",
        fetch_book=fetch_book,
        cancel=lambda: (_ for _ in ()).throw(AssertionError("should not cancel a full fill")),
        sleep=lambda _s: None,
    )
    assert out["ok"] is True
    assert out["filled_qty"] == 65
    assert seen["n"] == 2


def test_wish_partial_after_cancel():
    def fetch_book():
        return {"result": [{"AppOrderID": 4, "OrderStatus": "Pending", "CumulativeQuantity": 20, "OrderQuantity": 65}]}

    out = settle_book_only_fill(
        {"result": {"AppOrderID": 4, "OrderStatus": "Pending", "CumulativeQuantity": 0}},
        order_qty=65,
        app_order_id=4,
        unique_id="OPT4S",
        fetch_book=fetch_book,
        cancel=lambda: None,
        sleep=lambda _s: None,
        rounds=1,
    )
    assert out["ok"] is True
    assert out["filled_qty"] == 20


def test_wish_cancel_refused_while_open():
    def fetch_book():
        return {"result": [{"AppOrderID": 4, "OrderStatus": "Pending", "CumulativeQuantity": 0, "LeavesQuantity": 65}]}

    def cancel():
        raise RuntimeError("cancel refused")

    out = settle_book_only_fill(
        {"result": {"AppOrderID": 4, "OrderStatus": "Pending", "CumulativeQuantity": 0}},
        order_qty=65,
        app_order_id=4,
        unique_id="OPT4S",
        fetch_book=fetch_book,
        cancel=cancel,
        sleep=lambda _s: None,
        rounds=1,
    )
    assert out["ok"] is False
    assert out["error"] == "Pending order could not be cancelled"
    assert out["filled_qty"] == 0
