"""Pick display LTP from touchline (1501) vs depth (1502) feeds."""

from __future__ import annotations

# Same LastTradedPrice reprint (bid/ask 1501 snapshots) must not look like a new print.
_LTP_EPS = 1e-6


def apply_feed_ltp(
    prev_ltp: float,
    prev_ts: float,
    new_ltp: float,
    new_ts: float,
    *,
    ignore_older_ts: bool = False,
) -> tuple[float, float]:
    """Keep the timestamp of the last actual print. Identical reprints must not look newer.

    Index feeds often mix wall-clock vs LastTradedTime epochs; ``ignore_older_ts``
    still applies a real price change so NIFTY/BANKNIFTY/SENSEX cannot freeze.
    """
    if new_ltp <= 0:
        return float(prev_ltp or 0.0), float(prev_ts or 0.0)
    if prev_ltp <= 0:
        return float(new_ltp), float(new_ts or prev_ts or 0.0)
    if abs(float(new_ltp) - float(prev_ltp)) < _LTP_EPS:
        return float(prev_ltp), float(prev_ts or 0.0)
    if (
        not ignore_older_ts
        and new_ts > 0
        and prev_ts > 0
        and float(new_ts) + 1e-9 < float(prev_ts)
    ):
        return float(prev_ltp), float(prev_ts)
    return float(new_ltp), float(new_ts or prev_ts or 0.0)


def pick_ltp_for_display(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
    now: float | None = None,
) -> float:
    """Touchline (1501) is the last-trade tape — match XTS market watch tick-to-tick.

    Depth (1502) LastTradedPrice can sit on an old print (often day high) while 1501
    has already moved. Use 1502 LTP only until the first 1501 print arrives.

    ``now`` / timestamps are unused for the pick (kept for call-site compatibility).
    """
    _ = now, ts_1501, ts_1502
    have1 = ltp_1501 > 0
    have2 = ltp_1502 > 0
    if have1:
        return float(ltp_1501)
    if have2:
        return float(ltp_1502)
    return 0.0


# REST may refresh an option only after the shown price has sat still this long.
OPTION_REST_STALE_SEC = 1.2


def ltp_inside_book(ltp: float, bid: float, ask: float) -> bool:
    """True when a print sits on the live book, not on a far day-high."""
    if ltp <= 0 or bid <= 0 or ask <= 0 or float(ask) + 1e-9 < float(bid):
        return False
    pad = max(0.25, (float(ask) - float(bid)) * 3.0)
    return (float(bid) - pad) - 1e-9 <= float(ltp) <= (float(ask) + pad) + 1e-9


def pick_option_ltp(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
    bid: float = 0.0,
    ask: float = 0.0,
) -> float:
    """1501 last-trade is the tape. A newer 1502 print is used only inside the book.

    Touchline often freezes on the first option print while depth keeps trading.
    A 1502 price outside bid/ask (typical day high) must not replace 1501.
    """
    have1 = ltp_1501 > 0
    have2 = ltp_1502 > 0
    if have1 and have2:
        if abs(float(ltp_1501) - float(ltp_1502)) < 0.05:
            return float(ltp_1501)
        if float(ts_1502) > float(ts_1501) and ltp_inside_book(ltp_1502, bid, ask):
            return float(ltp_1502)
        return float(ltp_1501)
    if have1:
        return float(ltp_1501)
    if have2:
        return float(ltp_1502)
    return 0.0


def option_display_ltp(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
    bid: float = 0.0,
    ask: float = 0.0,
    rest_ltp: float = 0.0,
    rest_ts: float = 0.0,
) -> float:
    """Socket tape first. A newer REST quote replaces a tape that has stopped changing."""
    tape = pick_option_ltp(ltp_1501, ltp_1502, ts_1501, ts_1502, bid, ask)
    if abs(tape - float(ltp_1502 or 0.0)) < 1e-6 and float(ltp_1502 or 0.0) > 0:
        tape_ts = float(ts_1502 or 0.0)
    else:
        tape_ts = float(ts_1501 or 0.0) if float(ltp_1501 or 0.0) > 0 else 0.0
    if float(rest_ltp or 0.0) > 0 and float(rest_ts or 0.0) > tape_ts:
        return float(rest_ltp)
    return tape


def pick_index_ltp(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
) -> float:
    """Index LastTradedPrice on 1501 often freezes after the first print.

    Depth (1502) keeps printing the live index. ``apply_feed_ltp`` does not
    refresh the timestamp on an identical reprint, so the feed that last
    changed is the live one. Options stay on ``pick_ltp_for_display`` (1501).
    """
    have1 = ltp_1501 > 0
    have2 = ltp_1502 > 0
    if have1 and have2:
        if abs(float(ltp_1501) - float(ltp_1502)) < 0.05:
            return float(ltp_1501)
        if float(ts_1502) > float(ts_1501):
            return float(ltp_1502)
        if float(ts_1501) > float(ts_1502):
            return float(ltp_1501)
        return float(ltp_1502)
    if have1:
        return float(ltp_1501)
    if have2:
        return float(ltp_1502)
    return 0.0
